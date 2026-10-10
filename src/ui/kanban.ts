// A Trello-style kanban board view for kanban documents (markdown/kanban.ts).
//
//   ┌ Plan ──────┐ ┌ In Progress┐ ┌ Done ──────┐
//   │ ☐ card     │ │ ☐ card     │ │ ☑ card     │   drag cards between lists,
//   │ ☐ card     │ │            │ │            │   click to edit,
//   │ + Add      │ │ + Add      │ │ + Add      │   right click for the menu
//   └────────────┘ └────────────┘ └────────────┘   + Add list
//
// This component only holds the board model and its display. Every change goes through
// commit(), which replaces the model and calls onChange; the window writes
// the result to the document buffer (the single source of truth is the Markdown text).
//
// Dragging uses its own pointer handling (Gtk.GestureDrag: press → move → release on a card),
// not GTK's built-in drag-and-drop, so the behavior is controlled and can be tested by
// calling onCardPress/onCardMotion/onCardRelease directly: a ghost card (an image of the card
// in the Overlay layer above the board) follows the pointer, and a target marker shows where
// the card will land.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import {
    addCard, addColumn, boardSchema, cardFields, cardMeta, cardMissingFields, setCardField, withFieldOption, DUE_FIELD, deleteCard, deleteColumn, dropIndex, dueStatus, moveCard, moveColumn,
    newBoard, renameColumn, toggleDone, updateCard, type Board, type Card, type Position,
} from '../markdown/kanban.js';
import { fieldInputText, type FieldChip, type FieldDef } from '../markdown/fields.js';
import { fieldMenu, fieldPopover } from './fieldpopover.js';
import { cellMarkup, escapeMarkup, NOTE_URI, type MarkupColors } from '../markdown/pango.js';
import { parseWikiLink, wikiLinksIn, type WikiLink } from '../markdown/wikilink.js';
import { confirmDialog, editCardDialog, promptDialog, type CardDraft } from './dialogs.js';
import type { Palette } from '../colors.js';
import { after, childrenOf, onClick, onKeyPress, pack, removeChildren, type Awaitable } from '../gtkutil.js';
import { popupMenu, separator, type MenuEntry } from './menu.js';
import { _, fmt, pgettext } from '../i18n.js';

const COLUMN_WIDTH = 290;
const DRAG_THRESHOLD = 6;     // pixels the pointer moves before a click is considered a drag
const EDGE = 48;              // distance from the edge (pixels) that triggers autoscroll while dragging
const SCROLL_SPEED = 14;
const TAG_COLORS = 8;
const RUN_ICON: Record<CardRunStatus, string> = { queued: '◌', working: '●', waiting: '⏸', done: '✓', failed: '✕', stopped: '■' };
const RUN_LABEL: Record<CardRunStatus, string> = { queued: _('queued'), working: _('working'), waiting: _('waiting for an answer'), done: _('done'), failed: _('failed'), stopped: _('stopped') };
// Month abbreviations for the due date label; gettext context because "May"/"Jan" alone are ambiguous for translators.
const MONTHS = (): string[] => [
    pgettext('short month', 'Jan'), pgettext('short month', 'Feb'), pgettext('short month', 'Mar'), pgettext('short month', 'Apr'),
    pgettext('short month', 'May'), pgettext('short month', 'Jun'), pgettext('short month', 'Jul'), pgettext('short month', 'Aug'),
    pgettext('short month', 'Sep'), pgettext('short month', 'Oct'), pgettext('short month', 'Nov'), pgettext('short month', 'Dec'),
];

// Dialogs can be replaced (for example in tests with immediate answers); the real dialog answers through a Promise.
export interface BoardDialogs {
    editCard(parent: Gtk.Window | null, card: CardDraft, title?: string, listNotes?: () => string[], schema?: FieldDef[]): Awaitable<CardDraft | null>;
    prompt(parent: Gtk.Window | null, options: { title: string; label: string; value?: string }): Awaitable<string | null>;
    confirm(parent: Gtk.Window | null, message: string, detail?: string): Awaitable<boolean>;
}

// Assigning cards to external harnesses (filled in by the window). A card is recognized by its text.
export type CardRunStatus = 'queued' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';
export interface BoardHarness {
    status(card: Card): CardRunStatus | null;
    menu(card: Card, at: Position): MenuEntry[];
}

export interface ColumnView {
    box: Gtk.Box;
    scroller: Gtk.ScrolledWindow;
    cardsBox: Gtk.Box;
    cards: Gtk.Box[];
    footer: Gtk.Button;
}

// The pointer position is always in the coordinates of the pressed card.
interface PressState {
    column: number;
    index: number;
    widget: Gtk.Box;
    localX: number;
    localY: number;
}

interface DragState {
    from: Position;
    widget: Gtk.Box;
    ghost: Gtk.Picture;
    placeholder: Gtk.Box;
    target: Position;
    pointer: [number, number];   // pointer position in board coordinates
    timer: number;
}

type Adding = { kind: 'list' } | null;

export class KanbanBoard {
    readonly widget: Gtk.Overlay;
    readonly scroller: Gtk.ScrolledWindow;
    private readonly ghostLayer: Gtk.Fixed;   // where the ghost card lives while dragging
    columns: ColumnView[] = [];
    onChange: (board: Board) => void = () => {};
    dialogs: BoardDialogs = { editCard: editCardDialog, prompt: promptDialog, confirm: confirmDialog };
    today: () => string = () => GLib.DateTime.new_now_local().format('%Y-%m-%d') ?? '';
    harness: BoardHarness | null = null;
    // a [[note]] on a card was clicked, and the file list for [[ suggestions in the card dialog (filled in by the window).
    onOpenNote: (link: WikiLink) => void = () => {};
    listNotes: (() => string[]) | null = null;

    private board: Board = newBoard([]);
    private readonly row: Gtk.Box;
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private adding: Adding = null;
    private renderQueued = false;
    private press: PressState | null = null;
    private drag: DragState | null = null;

    constructor() {
        // Distance to the edge through CSS padding (.kanban-row), not widget margin: a margin falls outside
        // the widget's allocation and is not painted by the viewport, so it shows up black.
        this.row = new Gtk.Box({ spacing: 14, valign: Gtk.Align.FILL });
        this.row.add_css_class('kanban-row');
        this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER, hexpand: true, vexpand: true, can_focus: false });
        this.scroller.add_css_class('kanban-board');
        this.scroller.set_child(this.row);
        // The ghost card layer does not receive clicks, so the pointer still reaches the board.
        this.ghostLayer = new Gtk.Fixed({ can_target: false });
        this.widget = new Gtk.Overlay({ child: this.scroller });
        this.widget.add_overlay(this.ghostLayer);
    }

    // ---------- Model ----------

    getBoard(): Board {
        return this.board;
    }

    // Replace the board (for example a document opened or undo) without calling onChange.
    setBoard(board: Board): void {
        this.board = board;
        this.render();
    }

    // Apply a change from the user: replace the model, redraw, and notify the owner.
    commit(next: Board): void {
        if (next === this.board) return;
        this.board = next;
        this.queueRender();
        this.onChange(next);
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        this.render();
    }

    private get parent(): Gtk.Window | null {
        const top = this.widget.get_root();
        return top instanceof Gtk.Window ? top : null;
    }

    // ---------- Drawing ----------

    // Redrawn at idle: changes often come from inside the handling of a click on a widget that
    // is about to be destroyed, and several consecutive changes only need to be drawn once.
    queueRender(): void {
        if (this.renderQueued) return;
        this.renderQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.renderQueued = false;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    render(): void {
        this.cancelDrag();
        this.press = null;
        const h = this.scroller.get_hadjustment().get_value();
        const v = this.columns.map(c => c.scroller.get_vadjustment().get_value());
        removeChildren(this.row);

        this.columns = this.board.columns.map((_, c) => this.buildColumn(c));
        for (const col of this.columns) this.row.append(col.box);
        this.row.append(this.buildAddList());

        // The new scroll position only applies after layout.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.scroller.get_hadjustment().set_value(h);
            this.columns.forEach((col, c) => col.scroller.get_vadjustment().set_value(v[c] ?? 0));
            this.focusAddEntry();
            return GLib.SOURCE_REMOVE;
        });
    }

    private buildColumn(c: number): ColumnView {
        const column = this.board.columns[c];
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, width_request: COLUMN_WIDTH, vexpand: true });
        box.add_css_class('kanban-column');

        // Title: double click to rename.
        const title = new Gtk.Label({ label: column.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END, hexpand: true });
        title.add_css_class('kanban-column-title');
        const titleBox = new Gtk.Box();
        titleBox.append(title);
        titleBox.set_tooltip_text(_('Double-click to rename'));
        onClick(titleBox, count => {
            if (count !== 2) return false;
            this.renameColumnPrompt(c);
            return true;
        });
        const count = new Gtk.Label({ label: String(column.cards.length) });
        count.add_css_class('kanban-count');
        const more = new Gtk.Button({ label: '⋯', has_frame: false, tooltip_text: _('List menu') });
        more.connect('clicked', () => popupMenu(more, this.columnMenu(c)));
        const header = new Gtk.Box({ spacing: 6 });
        pack(header, titleBox, true);
        header.append(count);
        header.append(more);
        box.append(header);

        const cardsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true });
        scroller.set_child(cardsBox);
        const cards = column.cards.map((_, i) => this.buildCard(c, i));
        for (const card of cards) cardsBox.append(card);
        pack(box, scroller, true);

        const footer = this.buildAddCard(c);
        box.append(footer);
        return { box, scroller, cardsBox, cards, footer };
    }

    // The fields of this board (the built-in ones plus the frontmatter `fields:` block), read again only when the head changes.
    private schemaKey = '';
    private schemaCache: FieldDef[] = [];
    schema(): FieldDef[] {
        const key = this.board.head.join('\n');
        if (key !== this.schemaKey) {
            this.schemaKey = key;
            this.schemaCache = boardSchema(this.board);
        }
        return this.schemaCache;
    }

    private buildCard(c: number, i: number): Gtk.Box {
        const card = this.board.columns[c].cards[i];
        const meta = cardMeta(card.text);
        const fields = cardFields(card.text, this.schema());

        const widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        widget.add_css_class('kanban-card');
        if (card.done) widget.add_css_class('kanban-card-done');

        const check = new Gtk.CheckButton({ active: card.done === true, valign: Gtk.Align.START, tooltip_text: _('Mark done') });
        check.connect('toggled', () => this.commit(toggleDone(this.board, { column: c, index: i })));
        const label = new Gtk.Label({ use_markup: true, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, hexpand: true, width_chars: 10 });
        label.add_css_class('kanban-card-text');
        const markup = cellMarkup(meta.title, this.colors, true);
        label.set_markup(card.done ? `<s>${markup}</s>` : markup);
        label.connect('activate-link', (_l, uri: string) => this.activateNote(uri));
        const top = new Gtk.Box({ spacing: 8 });
        top.append(check);
        pack(top, label, true);
        if (cardMissingFields(card.text, this.schema()).length) top.append(this.addFieldButton(c, i));

        const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        inner.append(top);
        // Links in the card notes are not visible in the title, so they are shown as clickable chips.
        const inTitle = new Set(wikiLinksIn(card.text).map(l => l.target.toLowerCase()));
        const noteLinks = card.notes.length ? wikiLinksIn(card.notes.join('\n')).filter(l => !inTitle.has(l.target.toLowerCase())) : [];
        const badges = this.buildBadges(card.notes.length > 0, meta.tags, meta.due, meta.agent, this.harness?.status(card) ?? null, fields, (key, anchor) => this.editField(c, i, key, anchor));
        if (badges) inner.append(badges);
        // One row per link so many links do not widen the card.
        const linkBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
        if (noteLinks.length) inner.append(linkBox);
        for (const link of noteLinks) {
            const ref = `${link.target}${link.heading ? `#${link.heading}` : ''}`;
            const label = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, tooltip_text: fmt(_('Open note {ref} (also becomes agent context)'), { ref }) });
            label.add_css_class('kanban-note-link');
            label.set_markup(`<a href="${escapeMarkup(NOTE_URI + encodeURIComponent(ref))}">↗ ${escapeMarkup(link.alias || ref)}</a>`);
            label.connect('activate-link', (_l, uri: string) => this.activateNote(uri));
            linkBox.append(label);
        }
        widget.append(inner);

        // Press-drag-release with the left button. The checkbox handles its own click
        // first (children come first), so checking does not open the edit dialog.
        const drag = new Gtk.GestureDrag({ button: 1 });
        let startX = 0, startY = 0;
        drag.connect('drag-begin', (_g, x, y) => {
            startX = x;
            startY = y;
            this.onCardPress(c, i, widget, x, y);
        });
        drag.connect('drag-update', (_g, dx, dy) => this.onCardMotion(startX + dx, startY + dy));
        drag.connect('drag-end', () => this.onCardRelease());
        widget.add_controller(drag);
        onClick(widget, (_n, x, y) => {
            popupMenu(widget, this.cardMenu(c, i), x, y);
            return true;
        }, 3);
        return widget;
    }

    private buildBadges(hasNotes: boolean, tags: string[], due: string | null, agent: string | null = null, status: CardRunStatus | null = null, fields: FieldChip[] = [], edit: (key: string, anchor: Gtk.Widget) => void = () => {}): Gtk.Box | null {
        if (!hasNotes && !tags.length && !due && !agent && !fields.length) return null;
        const row = new Gtk.Box({ spacing: 4 });
        const chip = (text: string, ...classes: string[]) => {
            const label = new Gtk.Label({ label: text });
            for (const cls of ['kanban-chip', ...classes]) label.add_css_class(cls);
            row.append(label);
            return label;
        };
        if (agent) this.agentChip(chip, agent, status);
        for (const f of fields) this.fieldChip(chip, f, edit);
        for (const tag of tags) chip(`#${tag}`, `kanban-tag-${this.tagColor(tag)}`);
        if (due) {
            const dueChip = chip(`📅 ${this.formatDue(due)}`, 'kanban-due', `kanban-due-${dueStatus(due, this.today())}`);
            this.clickable(dueChip, () => edit(DUE_FIELD.key, dueChip));
        }
        if (hasNotes) chip('≡', 'kanban-notes');
        return row;
    }

    private agentChip(chip: (text: string, ...classes: string[]) => Gtk.Label, agent: string, status: CardRunStatus | null): void {
        const label = chip(`${status ? RUN_ICON[status] : '◇'} ${agent}${status ? ` · ${RUN_LABEL[status]}` : ''}`, 'kanban-agent', `kanban-agent-${status ?? 'idle'}`);
        label.set_tooltip_text(status === 'waiting' ? fmt(_('{agent} is waiting for your answer: right click the card → Answer {agent}…'), { agent }) : status ? fmt(_('{agent}: {status} (right click the card for the log)'), { agent, status: RUN_LABEL[status] }) : fmt(_('Assigned to {agent}; right click the card → Work on it with {agent}'), { agent }));
    }

    // A select option takes the color of its position; a value that does not fit its field is marked and explained.
    private fieldChip(chip: (text: string, ...classes: string[]) => Gtk.Label, f: FieldChip, edit: (key: string, anchor: Gtk.Widget) => void): void {
        const label = chip(f.text, f.invalid ? 'kanban-field-invalid' : f.option !== null ? `kanban-tag-${f.option % TAG_COLORS}` : 'kanban-field');
        if (f.invalid) label.set_tooltip_text(fmt(_('“{key}” does not fit its field: {reason}. The text in the file is unchanged.'), { key: f.key, reason: f.invalid }));
        if (f.type !== null) this.clickable(label, () => edit(f.key, label));
    }

    // A small button on the card, shown while the pointer is over it, to give a field that has no value yet one.
    private addFieldButton(column: number, index: number): Gtk.Button {
        const button = new Gtk.Button({ icon_name: 'list-add-symbolic', has_frame: false, valign: Gtk.Align.START, tooltip_text: _('Add a field') });
        button.add_css_class('kanban-add-field');
        button.connect('clicked', () => this.addFieldMenu(column, index, button));
        return button;
    }

    // The fields this card has no value for; choosing one opens its popover.
    addFieldMenu(column: number, index: number, anchor?: Gtk.Widget): Gtk.Popover | null {
        const card = this.board.columns[column]?.cards[index];
        const target = anchor ?? this.columns[column]?.cards[index];
        const missing = card ? cardMissingFields(card.text, this.schema()) : [];
        if (!card || !target || !missing.length) return null;
        return fieldMenu(target, missing, def => this.editField(column, index, def.key, target));
    }

    // A chip that opens its editor on a click. It claims the press, so the card does not start a drag or open its dialog.
    private clickable(label: Gtk.Widget, run: () => void): void {
        label.set_cursor_from_name('pointer');
        const click = new Gtk.GestureClick({ button: 1 });
        click.connect('pressed', () => click.set_state(Gtk.EventSequenceState.CLAIMED));
        click.connect('released', () => run());
        label.add_controller(click);
    }

    // Change one field of a card in place from a popover on `anchor`. A new select option and the value that uses it
    // are written together, so they are one undo step.
    editField(column: number, index: number, key: string, anchor?: Gtk.Widget): Gtk.Popover | null {
        const card = this.board.columns[column]?.cards[index];
        const def = this.schema().find(f => f.key === key);
        const target = anchor ?? this.columns[column]?.cards[index];
        if (!card || !def || !target) return null;
        return fieldPopover(target, {
            def,
            current: fieldInputText(card.text, def),
            apply: (raw, newOption) => {
                if (this.board.columns[column]?.cards[index]?.text !== card.text) return;
                // A new option is written first, and the value is checked against the list that now includes it.
                const board = newOption ? withFieldOption(this.board, key, newOption) : this.board;
                this.commit(setCardField(board, { column, index }, boardSchema(board).find(f => f.key === key) ?? def, raw));
            },
        });
    }

    // A fixed color for the same tag.
    tagColor(tag: string): number {
        let hash = 0;
        for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
        return hash % TAG_COLORS;
    }

    // "2026-10-20" → "20 Oct" (with the year if it is not this year).
    formatDue(due: string): string {
        const [y, m, d] = due.split('-').map(Number);
        const sameYear = this.today().startsWith(`${y}-`);
        return `${d} ${MONTHS()[m - 1]}${sameYear ? '' : ` ${y}`}`;
    }

    // ---------- Adding cards and lists ----------

    private entryRow(placeholder: string, add: (text: string) => void, cancel: () => void): { box: Gtk.Box; entry: Gtk.Entry } {
        const entry = new Gtk.Entry({ placeholder_text: placeholder, hexpand: true });
        entry.connect('activate', () => { if (entry.text.trim()) add(entry.text); });
        onKeyPress(entry, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            cancel();
            return true;
        });
        const ok = new Gtk.Button({ label: _('Add') });
        ok.connect('clicked', () => { if (entry.text.trim()) add(entry.text); });
        const close = new Gtk.Button({ label: '✕', has_frame: false, tooltip_text: _('Cancel (Esc)') });
        close.connect('clicked', cancel);
        const box = new Gtk.Box({ spacing: 4 });
        pack(box, entry, true);
        box.append(ok);
        box.append(close);
        return { box, entry };
    }

    private buildAddCard(c: number): Gtk.Button {
        const button = new Gtk.Button({ label: _('+ Add card'), has_frame: false, halign: Gtk.Align.FILL });
        (button.get_child() as Gtk.Label).xalign = 0;
        button.add_css_class('kanban-add');
        button.connect('clicked', () => this.showAddCard(c));
        return button;
    }

    private buildAddList(): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, width_request: COLUMN_WIDTH, valign: Gtk.Align.START });
        box.add_css_class('kanban-add-list');
        const button = new Gtk.Button({ label: _('+ Add list'), has_frame: false });
        button.connect('clicked', () => this.showAddList());
        const { box: entryBox, entry } = this.entryRow('List name…', text => this.commit(addColumn(this.board, text)), () => this.hideAdd());
        entry.set_name('kanban-entry-list');
        const stack = new Gtk.Stack();
        stack.add_named(button, 'button');
        stack.add_named(entryBox, 'entry');
        stack.visible_child_name = this.adding?.kind === 'list' ? 'entry' : 'button';
        box.append(stack);
        return box;
    }

    // A new card is filled in through the same dialog as editing a card.
    showAddCard(column: number): void {
        void after(this.dialogs.editCard(this.parent, { text: '', notes: [] }, _('Add Card'), this.listNotes ?? undefined, this.schema()), draft => {
            if (!draft?.text) return;
            const index = this.board.columns[column]?.cards.length ?? 0;
            const added = addCard(this.board, column, draft.text);
            this.commit(updateCard(added, { column, index }, { notes: draft.notes }));
        });
    }

    showAddList(): void {
        this.adding = { kind: 'list' };
        this.queueRender();
    }

    hideAdd(): void {
        this.adding = null;
        this.queueRender();
    }

    // The list name entry that is open gets focus after being redrawn.
    private focusAddEntry(): void {
        if (this.adding?.kind === 'list') this.findByName(this.row, 'kanban-entry-list')?.grab_focus();
    }

    private findByName(root: Gtk.Widget, name: string): Gtk.Widget | null {
        if (root.get_name() === name) return root;
        for (const child of childrenOf(root)) {
            const found = this.findByName(child, name);
            if (found) return found;
        }
        return null;
    }

    // ---------- Editing ----------

    editCard(column: number, index: number): void {
        const card = this.board.columns[column]?.cards[index];
        if (!card) return;
        void after(this.dialogs.editCard(this.parent, { text: card.text, notes: card.notes }, undefined, this.listNotes ?? undefined, this.schema()), result => {
            // The board can change while the dialog is open; the same card is found again through its position.
            if (result?.text && this.board.columns[column]?.cards[index]?.text === card.text)
                this.commit(updateCard(this.board, { column, index }, { text: result.text, notes: result.notes }));
        });
    }

    renameColumnPrompt(column: number): void {
        const current = this.board.columns[column]?.title;
        if (current === undefined) return;
        void after(this.dialogs.prompt(this.parent, { title: _('Rename List'), label: _('List name'), value: current }), name => {
            if (name && this.board.columns[column]?.title === current) this.commit(renameColumn(this.board, column, name));
        });
    }

    deleteColumnConfirm(column: number): void {
        const col = this.board.columns[column];
        if (!col) return;
        const detail = col.cards.length ? fmt(_('The {count} cards in it will also be deleted.'), { count: col.cards.length }) : undefined;
        void after(this.dialogs.confirm(this.parent, fmt(_('Delete the list “{title}”?'), { title: col.title }), detail), yes => {
            if (yes && this.board.columns[column]?.title === col.title) this.commit(deleteColumn(this.board, column));
        });
    }

    // ---------- Menu ----------

    cardMenu(column: number, index: number): MenuEntry[] {
        const col = this.board.columns[column];
        const card = col.cards[index];
        const at = { column, index };
        const move = this.board.columns
            .map((target, t): MenuEntry | null => t === column ? null
                : { label: target.title, run: () => this.commit(moveCard(this.board, at, { column: t, index: Infinity })) })
            .filter((e): e is MenuEntry => e !== null);
        return [
            { label: _('Edit…'), run: () => this.editCard(column, index) },
            { label: card.done ? _('Mark Not Done') : _('Mark Done'), run: () => this.commit(toggleDone(this.board, at)) },
            { label: _('Move to'), enabled: this.board.columns.length > 1, submenu: move },
            { label: _('Move Up'), enabled: index > 0, run: () => this.commit(moveCard(this.board, at, { column, index: index - 1 })) },
            { label: _('Move Down'), enabled: index < col.cards.length - 1, run: () => this.commit(moveCard(this.board, at, { column, index: index + 1 })) },
            ...(this.harness ? [separator(), ...this.harness.menu(card, at)] : []),
            separator(),
            { label: _('Delete'), run: () => this.commit(deleteCard(this.board, at)) },
        ];
    }

    columnMenu(column: number): MenuEntry[] {
        return [
            { label: _('Rename…'), run: () => this.renameColumnPrompt(column) },
            { label: _('Move Left'), enabled: column > 0, run: () => this.commit(moveColumn(this.board, column, column - 1)) },
            { label: _('Move Right'), enabled: column < this.board.columns.length - 1, run: () => this.commit(moveColumn(this.board, column, column + 1)) },
            separator(),
            { label: _('Delete List…'), run: () => this.deleteColumnConfirm(column) },
        ];
    }

    // ---------- Click and drag ----------

    // A [[note]] link on a card was clicked. The card press is cancelled so releasing does not open the edit dialog.
    activateNote(uri: string): boolean {
        if (!uri.startsWith(NOTE_URI)) return false;
        this.press = null;
        this.onOpenNote(parseWikiLink(decodeURIComponent(uri.slice(NOTE_URI.length))));
        return true;
    }

    // Left button pressed at (x, y), coordinates of the card `widget`.
    onCardPress(column: number, index: number, widget: Gtk.Box, x: number, y: number): boolean {
        this.press = { column, index, widget, localX: x, localY: y };
        return true;
    }

    // The pointer moves to (x, y), coordinates of the pressed card.
    onCardMotion(x: number, y: number): boolean {
        const press = this.press;
        if (!press) return false;
        if (!this.drag) {
            if (Math.hypot(x - press.localX, y - press.localY) < DRAG_THRESHOLD) return true;
            this.startDrag(press);
        }
        this.updateDrag(x, y);
        return true;
    }

    onCardRelease(): boolean {
        const press = this.press;
        this.press = null;
        if (!press) return false;
        if (this.drag) this.finishDrag();
        else this.editCard(press.column, press.index);   // did not move: a plain click
        return true;
    }

    get dragging(): boolean {
        return this.drag !== null;
    }

    private startDrag(press: PressState): void {
        const { widget } = press;
        const height = widget.get_allocated_height();

        // Ghost card: a still image of the card as it is now (before it is faded), in the Overlay layer.
        const image = new Gtk.WidgetPaintable({ widget }).get_current_image();
        const ghost = new Gtk.Picture({ paintable: image, can_shrink: false, opacity: 0.9 });
        this.ghostLayer.put(ghost, 0, 0);
        const placeholder = new Gtk.Box({ height_request: height });
        placeholder.add_css_class('kanban-placeholder');
        widget.set_opacity(0.35);

        this.drag = {
            from: { column: press.column, index: press.index }, widget, ghost, placeholder,
            target: { column: -1, index: -1 }, pointer: [0, 0],
            timer: GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => this.autoscroll()),
        };
    }

    private updateDrag(localX: number, localY: number): void {
        const drag = this.drag!, press = this.press!;
        const [, gx, gy] = drag.widget.translate_coordinates(this.widget, localX - press.localX, localY - press.localY);
        this.ghostLayer.move(drag.ghost, Math.round(gx), Math.round(gy));
        const [, bx, by] = drag.widget.translate_coordinates(this.row, localX, localY);
        drag.pointer = [bx, by];
        this.retarget();
    }

    // Recompute the drop target from the pointer position, and move its marker if it changed.
    private retarget(): void {
        const drag = this.drag;
        if (!drag) return;
        const target = this.targetAt(drag.pointer[0], drag.pointer[1]);
        if (!target || (target.column === drag.target.column && target.index === drag.target.index)) return;
        drag.target = target;

        const col = this.columns[target.column];
        const others = col.cards.filter(w => w !== drag.widget);
        const before = others[target.index];
        const old = drag.placeholder.get_parent();
        if (old instanceof Gtk.Box) old.remove(drag.placeholder);
        // Insert right before the target card (or at the end of the list).
        if (before) col.cardsBox.insert_child_after(drag.placeholder, before.get_prev_sibling());
        else col.cardsBox.append(drag.placeholder);
    }

    // The list surrounding the pointer (or the nearest one), and the card position in it.
    targetAt(bx: number, by: number): Position | null {
        if (!this.columns.length) return null;
        let best = 0, bestDistance = Infinity;
        this.columns.forEach((col, c) => {
            const [, x] = col.box.translate_coordinates(this.row, 0, 0);
            const width = col.box.get_allocated_width();
            const distance = bx < x ? x - bx : bx > x + width ? bx - (x + width) : 0;
            if (distance < bestDistance) { best = c; bestDistance = distance; }
        });
        const others = this.columns[best].cards.filter(w => w !== this.drag?.widget);
        const centers = others.map(w => w.translate_coordinates(this.row, 0, w.get_allocated_height() / 2)[2]);
        return { column: best, index: dropIndex(centers, by) };
    }

    private finishDrag(): void {
        const drag = this.drag!;
        this.endDrag();
        const { from, target } = drag;
        if (target.column < 0 || (target.column === from.column && target.index === from.index)) return;
        this.commit(moveCard(this.board, from, target));
    }

    private cancelDrag(): void {
        if (this.drag) this.endDrag();
    }

    private endDrag(): void {
        const drag = this.drag!;
        this.drag = null;
        GLib.source_remove(drag.timer);
        this.ghostLayer.remove(drag.ghost);
        const parent = drag.placeholder.get_parent();
        if (parent instanceof Gtk.Box) parent.remove(drag.placeholder);
        drag.widget.set_opacity(1);
    }

    // Dragging near an edge scrolls the board (left/right) or the target list (up/down).
    autoscroll(): boolean {
        const drag = this.drag;
        if (!drag) return GLib.SOURCE_REMOVE;
        const [bx, by] = drag.pointer;

        const [, wx] = this.row.translate_coordinates(this.scroller, bx, by);
        const hadj = this.scroller.get_hadjustment();
        const before = hadj.get_value();
        if (wx < EDGE) hadj.set_value(before - SCROLL_SPEED);
        else if (wx > this.scroller.get_allocated_width() - EDGE) hadj.set_value(before + SCROLL_SPEED);
        drag.pointer = [bx + (hadj.get_value() - before), by];   // the pointer is still on screen, the board moves

        const col = this.columns[Math.max(0, drag.target.column)];
        if (col) {
            const [, , sy] = this.row.translate_coordinates(col.scroller, bx, by);
            const vadj = col.scroller.get_vadjustment();
            if (sy < EDGE) vadj.set_value(vadj.get_value() - SCROLL_SPEED);
            else if (sy > col.scroller.get_allocated_height() - EDGE) vadj.set_value(vadj.get_value() + SCROLL_SPEED);
        }
        this.retarget();
        return GLib.SOURCE_CONTINUE;
    }

    // ---------- For tests and callers ----------

    cardTexts(column: number): string[] {
        return this.board.columns[column]?.cards.map(c => c.text) ?? [];
    }
}
