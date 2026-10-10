// The view of `layout: list` documents (markdown/inbox.ts): an inbox, a reading list, any list of notes. It shows the
// same model as a board (markdown/kanban.ts), with a `##` heading as a section title instead of a column.
//
//   Inbox                                        [+ New Note]
//   A place to capture ideas, notes, and things to process later.
//   ┌ Quick capture: type then Enter ────────────────────────┐
//   ┌────────────────────────────────────────────────────────┐
//   │ Idea: The estuary could use SQLite…          #idea   ✕ │   click to edit
//   │ 10 minutes ago                                         │
//   └────────────────────────────────────────────────────────┘
//
// Like the kanban board, this component only holds the model and its display: every
// change goes through commit(), which calls onChange so the window writes it to the buffer
// (the Markdown text remains the single source of truth).

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { ageOf, captureItem, itemFields, itemMeta, itemMissingFields, newList, type Age } from '../markdown/inbox.js';
import { boardSchema, deleteCard, setCardField, updateCard, withFieldOption, type Board, type Position } from '../markdown/kanban.js';
import { fieldInputText, type FieldChip, type FieldDef } from '../markdown/fields.js';
import { cellMarkup, NOTE_URI, type MarkupColors } from '../markdown/pango.js';
import { parseWikiLink, type WikiLink } from '../markdown/wikilink.js';
import { editNoteDialog, type CardDraft } from './dialogs.js';
import type { Palette } from '../colors.js';
import { after, onChipClick, removeChildren, type Awaitable } from '../gtkutil.js';
import { FieldPopover } from './fieldpopover.js';
import { _, fmt, ngettext } from '../i18n.js';

const MAX_WIDTH = 720;

// "10 minutes ago", "1 hour ago", "3 days ago"; older than a week it becomes a date. Also used by Home.
export function ageLabel(captured: Date, now: Date): string {
    const age: Age = ageOf(captured, now);
    switch (age.unit) {
        case 'now': return _('just now');
        case 'minutes': return fmt(ngettext('{n} minute ago', '{n} minutes ago', age.n), { n: age.n });
        case 'hours': return fmt(ngettext('{n} hour ago', '{n} hours ago', age.n), { n: age.n });
        case 'days': return fmt(ngettext('{n} day ago', '{n} days ago', age.n), { n: age.n });
        default: return captured.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: captured.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    }
}

export interface InboxDialogs {
    editNote(parent: Gtk.Window | null, item: CardDraft, title?: string, listNotes?: () => string[], schema?: FieldDef[]): Awaitable<CardDraft | null>;
}

export class InboxView {
    readonly widget: Gtk.ScrolledWindow;
    onChange: (board: Board) => void = () => {};
    dialogs: InboxDialogs = { editNote: editNoteDialog };
    now: () => Date = () => new Date();
    onOpenNote: (link: WikiLink) => void = () => {};
    listNotes: (() => string[]) | null = null;

    private board: Board = newList();
    private positions: (Position | null)[] = [];   // what each row of the list is: a note, or null for a section title
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private readonly page: Gtk.Box;
    private readonly entry: Gtk.Entry;
    private readonly list: Gtk.ListBox;
    private readonly empty: Adw.StatusPage;
    private readonly title: Gtk.Label;
    private readonly description: Gtk.Label;
    private renderQueued = false;
    private readonly popovers: FieldPopover;

    constructor() {
        this.title = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true });
        this.title.add_css_class('title-1');
        this.description = new Gtk.Label({ xalign: 0, wrap: true, visible: false });
        this.description.add_css_class('dim-label');

        const add = new Gtk.Button({ child: new Adw.ButtonContent({ icon_name: 'list-add-symbolic', label: _('New Note') }), valign: Gtk.Align.START });
        add.set_tooltip_text(_('Add a note with a title, tags, and full notes'));
        add.connect('clicked', () => this.showAddNote());
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
        titles.append(this.title);
        titles.append(this.description);
        const header = new Gtk.Box({ spacing: 12 });
        header.append(titles);
        header.append(add);

        this.entry = new Gtk.Entry({ placeholder_text: _('Write an idea, link, or quick note…'), hexpand: true });
        this.entry.set_name('inbox-entry');
        this.entry.update_property([Gtk.AccessibleProperty.LABEL], [_('Quick capture to the inbox')]);
        this.entry.connect('activate', () => this.capture(this.entry.text));

        this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        this.list.add_css_class('inbox-list');
        this.list.connect('row-activated', (_l, row: Gtk.ListBoxRow) => {
            const at = this.positions[row.get_index()];
            if (at) this.editItem(at);
        });
        this.empty = new Adw.StatusPage({ icon_name: 'mail-inbox-symbolic', title: _('The inbox is empty'), description: _('Write something above to capture it.') });
        this.empty.add_css_class('compact');

        this.page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        this.page.append(header);
        this.page.append(this.entry);
        this.page.append(this.list);
        this.page.append(this.empty);

        const clamp = new Adw.Clamp({ maximum_size: MAX_WIDTH, tightening_threshold: 560, child: this.page, valign: Gtk.Align.START });
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, hexpand: true, child: clamp });
        this.popovers = new FieldPopover(this.page);
        this.widget.add_css_class('inbox-view');
    }

    // ---------- Model ----------

    getBoard(): Board {
        return this.board;
    }

    // The fields of this inbox (the built-in ones plus the frontmatter `fields:` block), read again only when the head changes.
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

    // Replace the contents (document opened or undo) without calling onChange.
    setBoard(board: Board): void {
        this.board = board;
        this.render();
    }

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

    // Deferred to idle: the change comes from a click on a widget that is about to be destroyed.
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
        const { title, description } = this.heading();
        this.title.set_label(title);
        this.description.set_label(description);
        this.description.set_visible(!!description);
        removeChildren(this.list);
        this.positions = [];
        let count = 0;
        this.board.columns.forEach((column, c) => {
            if (column.title !== '') {
                this.list.append(this.buildSection(column.title));
                this.positions.push(null);
            }
            column.cards.forEach((_card, i) => {
                this.list.append(this.buildRow({ column: c, index: i }));
                this.positions.push({ column: c, index: i });
                count++;
            });
        });
        this.list.set_visible(this.positions.length > 0);
        this.empty.set_visible(count === 0 && this.positions.length === 0);
    }

    // A group with a title is shown as a section title above its notes.
    private buildSection(title: string): Gtk.ListBoxRow {
        const label = new Gtk.Label({ label: title, xalign: 0, margin_top: 8, margin_bottom: 4, margin_start: 14 });
        label.add_css_class('heading');
        const row = new Gtk.ListBoxRow({ child: label, activatable: false, selectable: false });
        row.add_css_class('inbox-section');
        return row;
    }

    // The title and description are taken from the head part after the frontmatter.
    private heading(): { title: string; description: string } {
        const lines = [...this.board.head];
        if (lines[0]?.trim() === '---') {
            const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
            lines.splice(0, close < 0 ? lines.length : close + 1);
        }
        const at = lines.findIndex(l => /^#\s+\S/.test(l));
        const title = at >= 0 ? lines[at].replace(/^#\s+/, '').trim() : _('Inbox');
        const rest = at >= 0 ? lines.slice(at + 1) : lines;
        return { title, description: rest.map(l => l.trim()).filter(Boolean).join(' ') };
    }

    ageLabel(captured: Date): string {
        return ageLabel(captured, this.now());
    }

    private buildRow(at: Position): Gtk.ListBoxRow {
        const item = this.board.columns[at.column].cards[at.index];
        const meta = itemMeta(item.text);

        const title = new Gtk.Label({ use_markup: true, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, hexpand: true, width_chars: 10 });
        title.set_markup(cellMarkup(meta.title, this.colors, true));
        title.connect('activate-link', (_l, uri: string) => this.activateNote(uri));
        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER });
        text.append(title);
        const details: string[] = [];
        if (meta.captured) details.push(this.ageLabel(meta.captured));
        if (item.notes.length) details.push(_('has notes'));
        if (details.length) {
            const sub = new Gtk.Label({ label: details.join(' · '), xalign: 0 });
            sub.add_css_class('dim-label');
            sub.add_css_class('caption');
            text.append(sub);
        }

        const box = new Gtk.Box({ spacing: 8, margin_top: 10, margin_bottom: 10, margin_start: 14, margin_end: 8 });
        box.append(text);
        for (const f of itemFields(item.text, this.schema())) box.append(this.fieldChip(at, f));
        for (const tag of meta.tags) {
            const chip = new Gtk.Label({ label: `#${tag}`, valign: Gtk.Align.CENTER });
            chip.add_css_class('inbox-tag');
            box.append(chip);
        }
        if (itemMissingFields(item.text, this.schema()).length) box.append(this.addFieldButton(at));
        const remove = new Gtk.Button({ icon_name: 'window-close-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Delete note') });
        remove.add_css_class('flat');
        remove.add_css_class('circular');
        remove.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Delete note: {title}'), { title: meta.title })]);
        remove.connect('clicked', () => this.commit(deleteCard(this.board, at)));
        box.append(remove);

        const row = new Gtk.ListBoxRow({ child: box, activatable: true });
        return row;
    }

    // A declared field as a chip: a select option takes the color of its position, a value that does not fit is marked.
    private fieldChip(at: Position, f: FieldChip): Gtk.Label {
        const chip = new Gtk.Label({ label: f.text, valign: Gtk.Align.CENTER });
        chip.add_css_class('inbox-field');
        if (f.invalid) {
            chip.add_css_class('inbox-field-invalid');
            chip.set_tooltip_text(fmt(_('“{key}” does not fit its field: {reason}. The text in the file is unchanged.'), { key: f.key, reason: f.invalid }));
        } else if (f.color) {
            chip.add_css_class(`opt-${f.color}`);
        } else if (f.option !== null) {
            chip.add_css_class(`inbox-field-${f.option % 8}`);
        }
        if (f.type !== null) onChipClick(chip, () => this.editField(at, f.key, chip));
        return chip;
    }

    // A small button on the row, shown while the pointer is over it, to give a field that has no value yet one.
    private addFieldButton(at: Position): Gtk.Button {
        const button = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Add a field') });
        button.add_css_class('flat');
        button.add_css_class('circular');
        button.add_css_class('inbox-add-field');
        button.connect('clicked', () => this.addFieldMenu(at, button));
        return button;
    }

    private cardAt(at: Position) {
        return this.board.columns[at.column]?.cards[at.index];
    }

    // The widget a chip or button is clicked on: the given one, or the content of the note's row.
    private sourceFor(at: Position, source?: Gtk.Widget): Gtk.Widget | null {
        const row = this.positions.findIndex(p => p?.column === at.column && p.index === at.index);
        return source ?? this.list.get_row_at_index(row)?.get_child() ?? null;
    }

    // The fields this note has no value for; choosing one opens its popover.
    addFieldMenu(at: Position, source?: Gtk.Widget): Gtk.Popover | null {
        const item = this.cardAt(at);
        const from = this.sourceFor(at, source);
        const missing = item ? itemMissingFields(item.text, this.schema()) : [];
        if (!item || !from || !missing.length) return null;
        return this.popovers.menu(from, missing, def => this.editField(at, def.key, source));
    }

    // Change one field of a note in place from a popover that points at `source`. A new select option and the value
    // that uses it are written together, so they are one undo step.
    editField(at: Position, key: string, source?: Gtk.Widget): Gtk.Popover | null {
        const item = this.cardAt(at);
        const def = this.schema().find(f => f.key === key);
        const from = this.sourceFor(at, source);
        if (!item || !def || !from) return null;
        return this.popovers.edit(from, {
            def,
            current: fieldInputText(item.text, def),
            apply: (raw, newOption) => {
                if (this.cardAt(at)?.text !== item.text) return;
                const board = newOption ? withFieldOption(this.board, key, newOption) : this.board;
                this.commit(setCardField(board, at, boardSchema(board).find(f => f.key === key) ?? def, raw));
            },
        });
    }

    private activateNote(uri: string): boolean {
        if (!uri.startsWith(NOTE_URI)) return false;
        this.onOpenNote(parseWikiLink(decodeURIComponent(uri.slice(NOTE_URI.length))));
        return true;
    }

    // ---------- Actions ----------

    // Quick capture: one line from the entry above the list.
    capture(text: string): void {
        this.entry.set_text('');
        if (!text.trim()) return;
        this.commit(captureItem(this.board, text, this.now()));
        this.entry.grab_focus();
    }

    // A new note through the dialog, with tags and notes.
    showAddNote(): void {
        void after(this.dialogs.editNote(this.parent, { text: '', notes: [] }, _('New Note'), this.listNotes ?? undefined, this.schema()), draft => {
            if (draft?.text) this.commit(captureItem(this.board, draft.text, this.now(), draft.notes));
        });
    }

    editItem(at: Position): void {
        const item = this.cardAt(at);
        if (!item) return;
        void after(this.dialogs.editNote(this.parent, { text: item.text, notes: item.notes }, undefined, this.listNotes ?? undefined, this.schema()), result => {
            // The list can change while the dialog is open; the same item is found again through its position.
            if (result?.text && this.cardAt(at)?.text === item.text)
                this.commit(updateCard(this.board, at, { text: result.text, notes: result.notes }));
        });
    }

    focusCapture(): void {
        this.entry.grab_focus();
    }
}
