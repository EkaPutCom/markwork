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
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import { ageOf, captureItem, itemFields, itemMeta, newList, type Age } from '../markdown/inbox.js';
import { addColumn, boardSchema, deleteCard, deleteColumn, deleteColumnKeepCards, dropSpot, moveCard, moveColumn, placeMove, renameColumn, setCardField, updateCard, withFieldOption, type Board, type DropRow, type DropSpot, type Position } from '../markdown/kanban.js';
import { fieldInputText, type FieldChip, type FieldDef } from '../markdown/fields.js';
import { cellMarkup, NOTE_URI, type MarkupColors } from '../markdown/pango.js';
import { parseWikiLink, type WikiLink } from '../markdown/wikilink.js';
import { deleteSectionDialog, editNoteDialog, promptDialog, type CardDraft } from './dialogs.js';
import type { Palette } from '../colors.js';
import { after, onChipClick, onClick, removeChildren, type Awaitable } from '../gtkutil.js';
import { popupMenu, separator, type MenuEntry } from './menu.js';
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
    prompt(parent: Gtk.Window | null, options: { title: string; label: string; value?: string }): Awaitable<string | null>;
    deleteSection(parent: Gtk.Window | null, title: string, count: number): Awaitable<'keep' | 'delete' | null>;
}

// A row of the list: a note, or the title of a section (the group at `section`).
type ListRow = { note: Position } | { section: number };

export class InboxView {
    readonly widget: Gtk.ScrolledWindow;
    onChange: (board: Board) => void = () => {};
    dialogs: InboxDialogs = { editNote: editNoteDialog, prompt: promptDialog, deleteSection: deleteSectionDialog };
    now: () => Date = () => new Date();
    onOpenNote: (link: WikiLink) => void = () => {};
    listNotes: (() => string[]) | null = null;

    private board: Board = newList();
    private rows: ListRow[] = [];   // what each row of the list is: a note, or the title of a section
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
            const r = this.rows[row.get_index()];
            if (r && 'note' in r) this.editItem(r.note);
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
        this.setupDrag();
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
        this.rows = [];
        let count = 0;
        this.board.columns.forEach((column, c) => {
            if (column.title !== '') {
                this.list.append(this.buildSection(c, column.title));
                this.rows.push({ section: c });
            }
            column.cards.forEach((_card, i) => {
                this.list.append(this.buildRow({ column: c, index: i }));
                this.rows.push({ note: { column: c, index: i } });
                count++;
            });
        });
        this.list.set_visible(this.rows.length > 0);
        this.empty.set_visible(count === 0 && this.rows.length === 0);
    }

    // A group with a title is shown as a section title above its notes; right-clicking it opens its menu.
    private buildSection(column: number, title: string): Gtk.ListBoxRow {
        const label = new Gtk.Label({ label: title, xalign: 0, margin_top: 8, margin_bottom: 4, margin_start: 14 });
        label.add_css_class('heading');
        const row = new Gtk.ListBoxRow({ child: label, activatable: false, selectable: false });
        row.add_css_class('inbox-section');
        onClick(row, (_n, x, y) => {
            popupMenu(row, this.sectionMenu(column), x, y);
            return true;
        }, 3);
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
        const remove = new Gtk.Button({ icon_name: 'window-close-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Delete note') });
        remove.add_css_class('flat');
        remove.add_css_class('circular');
        remove.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Delete note: {title}'), { title: meta.title })]);
        remove.connect('clicked', () => this.commit(deleteCard(this.board, at)));
        box.append(remove);

        this.attachDrag(box, at);
        const row = new Gtk.ListBoxRow({ child: box, activatable: true });
        onClick(row, (_n, x, y) => {
            popupMenu(row, this.rowMenu(at), x, y);
            return true;
        }, 3);
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

    // ---------- Drag and drop: a note to another place in the list or to another section ----------

    private dragFrom: Position | null = null;
    private mark: { row: Gtk.Widget; cls: string } | null = null;

    private setupDrag(): void {
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
        target.set_gtypes([GObject.TYPE_STRING]);
        target.connect('motion', (_t, _x, y) => {
            const spot = this.spotAt(y);
            this.showMark(spot);
            return spot ? Gdk.DragAction.MOVE : 0 as Gdk.DragAction;
        });
        target.connect('leave', () => this.showMark(null));
        target.connect('drop', (_t, _value, _x, y) => {
            const spot = this.spotAt(y);
            this.showMark(null);
            return spot !== null && this.dropNote(spot);
        });
        this.list.add_controller(target);
    }

    // A note can be dragged by its row. The source sits on the row's content: the list itself claims a press to
    // activate a row, so a source on the list never gets to start.
    private attachDrag(content: Gtk.Widget, at: Position): void {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', () => {
            this.dragFrom = at;
            // The icon of a note; a widget as the drag icon triggers a Gtk-CRITICAL when the drag ends in GTK 4.14.
            const icon = Gtk.IconTheme.get_for_display(this.list.get_display()).lookup_icon('text-x-generic-symbolic', null, 32,
                this.list.get_scale_factor(), Gtk.TextDirection.NONE, 0 as Gtk.IconLookupFlags);
            source.set_icon(icon, 0, 0);
            return Gdk.ContentProvider.new_for_value(`${at.column}.${at.index}`);
        });
        source.connect('drag-end', () => {
            this.dragFrom = null;
            this.showMark(null);
        });
        content.add_controller(source);
    }

    // The bounds of every row in the coordinates of the list.
    private dropRows(): DropRow[] {
        return this.rows.map((r, i) => {
            const rect = this.list.get_row_at_index(i)?.compute_bounds(this.list)?.[1];
            const top = rect?.get_y() ?? 0;
            return { top, bottom: top + (rect?.get_height() ?? 0), note: 'note' in r ? r.note : null, section: 'section' in r ? r.section : -1 };
        });
    }

    // Where the dragged note would land at height `y`, or null if nothing is dragged from here or it would not move.
    spotAt(y: number): DropSpot | null {
        const from = this.dragFrom;
        const spot = from ? dropSpot(this.dropRows(), y) : null;
        return from && spot && placeMove(this.board, from, spot.point) !== this.board ? spot : null;
    }

    // The dragged note moves to the spot, in one undo step.
    dropNote(spot: DropSpot): boolean {
        if (!this.dragFrom) return false;
        const next = placeMove(this.board, this.dragFrom, spot.point);
        this.dragFrom = null;
        this.commit(next);
        return true;
    }

    // The line that shows where the note will go: a shadow on the edge of the row it is dropped next to.
    private showMark(spot: DropSpot | null): void {
        const row = spot ? this.list.get_row_at_index(spot.row) : null;
        const cls = spot ? (spot.side === 'above' ? 'inbox-drop-above' : 'inbox-drop-below') : '';
        if (this.mark && (this.mark.row !== row || this.mark.cls !== cls)) {
            this.mark.row.remove_css_class(this.mark.cls);
            this.mark = null;
        }
        if (row && !this.mark) {
            row.add_css_class(cls);
            this.mark = { row, cls };
        }
    }

    // The menu of a note (right click): edit it, move it to another section or up and down within its section, delete it.
    rowMenu(at: Position): MenuEntry[] {
        const column = this.board.columns[at.column];
        const sections = this.board.columns
            .map((target, t): MenuEntry | null => t === at.column ? null
                : { label: target.title || _('No section'), run: () => this.commit(moveCard(this.board, at, { column: t, index: Infinity })) })
            .filter((e): e is MenuEntry => e !== null);
        const submenu = [...sections, ...(sections.length ? [separator()] : []), { label: _('New section…'), run: () => this.newSectionFor(at) }];
        return [
            { label: _('Edit…'), run: () => this.editItem(at) },
            { label: _('Move to'), submenu },
            { label: _('Move Up'), enabled: at.index > 0, run: () => this.commit(moveCard(this.board, at, { column: at.column, index: at.index - 1 })) },
            { label: _('Move Down'), enabled: at.index < (column?.cards.length ?? 0) - 1, run: () => this.commit(moveCard(this.board, at, { column: at.column, index: at.index + 1 })) },
            separator(),
            { label: _('Delete'), run: () => this.commit(deleteCard(this.board, at)) },
        ];
    }

    // A new section at the end, named by the user, with the note moved into it in the same undo step. A name that is
    // already a section (ignoring case) moves the note into that one instead of making a second.
    newSectionFor(at: Position): void {
        const card = this.cardAt(at);
        if (!card) return;
        void after(this.dialogs.prompt(this.parent, { title: _('New Section'), label: _('Section name') }), name => {
            const title = name?.trim();
            if (!title || this.cardAt(at)?.text !== card.text) return;
            const existing = this.board.columns.findIndex(c => c.title.toLowerCase() === title.toLowerCase());
            const board = existing >= 0 ? this.board : addColumn(this.board, title);
            const into = existing >= 0 ? existing : board.columns.length - 1;
            this.commit(into === at.column ? board : moveCard(board, at, { column: into, index: Infinity }));
        });
    }

    // The menu of a section title (right click): rename it, move it up or down among the sections, delete it.
    sectionMenu(column: number): MenuEntry[] {
        const first = this.board.columns[0]?.title === '' ? 1 : 0;   // the unnamed group stays first
        return [
            { label: _('Rename…'), run: () => this.renameSection(column) },
            { label: _('Move Up'), enabled: column > first, run: () => this.commit(moveColumn(this.board, column, column - 1)) },
            { label: _('Move Down'), enabled: column < this.board.columns.length - 1, run: () => this.commit(moveColumn(this.board, column, column + 1)) },
            separator(),
            { label: _('Delete Section…'), run: () => this.deleteSection(column) },
        ];
    }

    renameSection(column: number): void {
        const current = this.board.columns[column]?.title;
        if (!current) return;
        void after(this.dialogs.prompt(this.parent, { title: _('Rename Section'), label: _('Section name'), value: current }), name => {
            if (name?.trim() && this.board.columns[column]?.title === current) this.commit(renameColumn(this.board, column, name));
        });
    }

    // An empty section goes without a question; one with notes asks whether to keep them (in the section above) or delete them too.
    deleteSection(column: number): void {
        const section = this.board.columns[column];
        if (!section || section.title === '') return;
        if (!section.cards.length) {
            this.commit(deleteColumn(this.board, column));
            return;
        }
        void after(this.dialogs.deleteSection(this.parent, section.title, section.cards.length), choice => {
            if (!choice || this.board.columns[column]?.title !== section.title) return;
            this.commit(choice === 'keep' ? deleteColumnKeepCards(this.board, column) : deleteColumn(this.board, column));
        });
    }

    private cardAt(at: Position) {
        return this.board.columns[at.column]?.cards[at.index];
    }

    // The widget a chip or button is clicked on: the given one, or the content of the note's row.
    private sourceFor(at: Position, source?: Gtk.Widget): Gtk.Widget | null {
        const row = this.rows.findIndex(r => 'note' in r && r.note.column === at.column && r.note.index === at.index);
        return source ?? this.list.get_row_at_index(row)?.get_child() ?? null;
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
