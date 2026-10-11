// The view of `layout: table` documents (markdown/tablelayout.ts): one row per note, one column per field.
//
//   Sprint                                                   [+ New Row]
//   ┌ Quick capture: type then Enter ───────────────────────────────────┐
//     Title            Status      Due ▲        Progress     Section
//     Parser           review      13 Oct       ▓▓▓▓▓▓▓      ✕
//
// It shows the same model as a board or a list. Clicking a header sorts by that column (ascending, descending, back to the
// order of the document; kept in the view, not written to the file, which has its own `sort:`), clicking a cell
// changes that field in place from a popover, clicking a title edits the note. Every change goes through commit(), which
// calls onChange so the window writes it to the buffer (the Markdown text remains the single source of truth).

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { boardSchema, deleteCard, setCardField, toggleDone, updateCard, withFieldOption, type Board, type Position } from '../markdown/kanban.js';
import { captureItem } from '../markdown/inbox.js';
import { displayValue, fieldInputText, readItem, type FieldDef, type Parsed } from '../markdown/fields.js';
import { newTable, nextSort, sortSpec, SECTION_COLUMN, TITLE_COLUMN, tableColumns, tableRows, type SortSpec, type TableRow } from '../markdown/tablelayout.js';
import { cellMarkup, NOTE_URI, type MarkupColors } from '../markdown/pango.js';
import { parseWikiLink, type WikiLink } from '../markdown/wikilink.js';
import { editNoteDialog, type CardDraft } from './dialogs.js';
import type { Palette } from '../colors.js';
import { after, onChipClick, removeChildren, type Awaitable } from '../gtkutil.js';
import { FieldPopover } from './fieldpopover.js';
import { _, fmt } from '../i18n.js';

export interface TableDialogs {
    editNote(parent: Gtk.Window | null, item: CardDraft, title?: string, listNotes?: () => string[], schema?: FieldDef[]): Awaitable<CardDraft | null>;
}

export class TableView {
    readonly widget: Gtk.ScrolledWindow;
    onChange: (board: Board) => void = () => {};
    dialogs: TableDialogs = { editNote: editNoteDialog };
    now: () => Date = () => new Date();
    today: () => string = () => GLib.DateTime.new_now_local().format('%Y-%m-%d') ?? '';
    onOpenNote: (link: WikiLink) => void = () => {};
    listNotes: (() => string[]) | null = null;

    private board: Board = newTable();
    private sortOverride: SortSpec | null | undefined = undefined;   // undefined = the document's own `sort:`
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private readonly page: Gtk.Box;
    private readonly entry: Gtk.Entry;
    private readonly grid: Gtk.Grid;
    private readonly empty: Adw.StatusPage;
    private readonly title: Gtk.Label;
    private readonly description: Gtk.Label;
    private readonly popovers: FieldPopover;
    private renderQueued = false;

    constructor() {
        this.title = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true });
        this.title.add_css_class('title-1');
        this.description = new Gtk.Label({ xalign: 0, wrap: true, visible: false });
        this.description.add_css_class('dim-label');
        const add = new Gtk.Button({ child: new Adw.ButtonContent({ icon_name: 'list-add-symbolic', label: _('New Row') }), valign: Gtk.Align.START });
        add.set_tooltip_text(_('Add a row with a title, fields, and notes'));
        add.connect('clicked', () => this.showAddNote());
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
        titles.append(this.title);
        titles.append(this.description);
        const header = new Gtk.Box({ spacing: 12 });
        header.append(titles);
        header.append(add);

        this.entry = new Gtk.Entry({ placeholder_text: _('Write a title and press Enter to add a row…'), hexpand: true });
        this.entry.set_name('table-entry');
        this.entry.update_property([Gtk.AccessibleProperty.LABEL], [_('Quick add a row to the table')]);
        this.entry.connect('activate', () => this.capture(this.entry.text));

        this.grid = new Gtk.Grid({ halign: Gtk.Align.START });
        this.grid.add_css_class('table-grid');
        this.empty = new Adw.StatusPage({ icon_name: 'view-list-symbolic', title: _('The table is empty'), description: _('Write a title above to add the first row.') });
        this.empty.add_css_class('compact');

        this.page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        this.page.append(header);
        this.page.append(this.entry);
        this.page.append(this.grid);
        this.page.append(this.empty);
        this.widget = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true, child: this.page });
        this.widget.add_css_class('table-view');
        this.popovers = new FieldPopover(this.page);
    }

    // ---------- Model ----------

    getBoard(): Board {
        return this.board;
    }

    // The fields of this table (what its frontmatter declares), read again only when the head changes.
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

    // Replace the contents (document opened or undo) without calling onChange. A sort chosen by a click is forgotten when
    // another document is shown.
    setBoard(board: Board): void {
        if (board.head.join('\n') !== this.board.head.join('\n')) this.sortOverride = undefined;
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

    // The order shown: the one chosen by a click on a header, else the document's `sort:`.
    currentSort(): SortSpec | null {
        return this.sortOverride !== undefined ? this.sortOverride : sortSpec(this.board);
    }

    setSort(sort: SortSpec | null): void {
        this.sortOverride = sort;
        this.render();
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
        removeChildren(this.grid);
        const rows = tableRows(this.board, this.currentSort(), this.schema());
        this.grid.set_visible(rows.length > 0);
        this.empty.set_visible(rows.length === 0);
        if (rows.length) this.drawGrid(rows);
    }

    // The title and description are taken from the head part after the frontmatter.
    private heading(): { title: string; description: string } {
        const lines = [...this.board.head];
        if (lines[0]?.trim() === '---') {
            const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
            lines.splice(0, close < 0 ? lines.length : close + 1);
        }
        const at = lines.findIndex(l => /^#\s+\S/.test(l));
        const title = at >= 0 ? lines[at].replace(/^#\s+/, '').trim() : _('Table');
        const rest = at >= 0 ? lines.slice(at + 1) : lines;
        return { title, description: rest.map(l => l.trim()).filter(Boolean).join(' ') };
    }

    // A checkbox column when any note has one, then a column for each name, then the delete column.
    private drawGrid(rows: TableRow[]): void {
        const schema = this.schema();
        const keys = tableColumns(this.board, schema);
        const checks = rows.some(r => r.card.done !== null);
        const sort = this.currentSort();
        let col = 0;
        if (checks) this.put(this.headCell(null, sort), col++, 0, false);
        for (const key of keys) this.put(this.headCell(key, sort), col++, 0, key === TITLE_COLUMN);
        this.put(this.headCell(null, sort), col, 0, false);
        rows.forEach((row, r) => {
            let c = 0;
            if (checks) this.put(this.checkCell(row), c++, r + 1, false);
            for (const key of keys) this.put(this.cell(row, key, schema), c++, r + 1, key === TITLE_COLUMN);
            this.put(this.deleteCell(row), c, r + 1, false);
        });
    }

    private put(widget: Gtk.Widget, col: number, row: number, wide: boolean): void {
        widget.add_css_class('table-cell');
        if (row === 0) widget.add_css_class('table-head');
        if (wide) {
            widget.set_hexpand(true);
            widget.set_size_request(260, -1);
        }
        this.grid.attach(widget, col, row, 1, 1);
    }

    private columnLabel(key: string): string {
        return key === TITLE_COLUMN ? _('Title') : key === SECTION_COLUMN ? _('Section') : key;
    }

    // The header of a column: its name and, if the rows are sorted by it, an arrow; a click sorts by it.
    private headCell(key: string | null, sort: SortSpec | null): Gtk.Widget {
        if (key === null) return new Gtk.Box();
        const arrow = sort?.key === key ? (sort.desc ? ' ▼' : ' ▲') : '';
        const button = new Gtk.Button({ label: this.columnLabel(key) + arrow, has_frame: false, halign: Gtk.Align.FILL });
        (button.get_child() as Gtk.Label | null)?.set_xalign(0);
        button.add_css_class('table-head-button');
        button.set_tooltip_text(_('Sort by this column'));
        button.connect('clicked', () => this.setSort(nextSort(this.currentSort(), key)));
        return this.boxed(button);
    }

    // A control inside a plain box, so the cell style (padding, a line under it) is on the box and not on the control.
    private boxed(control: Gtk.Widget): Gtk.Box {
        const box = new Gtk.Box({ valign: Gtk.Align.CENTER });
        box.append(control);
        return box;
    }

    private checkCell(row: TableRow): Gtk.Widget {
        const box = new Gtk.Box({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER });
        if (row.card.done === null) return box;
        const check = new Gtk.CheckButton({ active: row.card.done, tooltip_text: _('Mark done') });
        check.connect('toggled', () => this.commit(toggleDone(this.board, row.at)));
        box.append(check);
        return box;
    }

    private deleteCell(row: TableRow): Gtk.Widget {
        const remove = new Gtk.Button({ icon_name: 'window-close-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Delete row') });
        remove.add_css_class('flat');
        remove.add_css_class('circular');
        remove.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Delete row: {title}'), { title: readItem(row.card.text, this.schema()).title })]);
        remove.connect('clicked', () => this.commit(deleteCard(this.board, row.at)));
        return this.boxed(remove);
    }

    // One cell. The title opens the edit dialog; any other cell changes its field in place from a popover.
    private cell(row: TableRow, key: string, schema: FieldDef[]): Gtk.Widget {
        const cell = new Gtk.Box({ valign: Gtk.Align.CENTER });
        if (key === TITLE_COLUMN) {
            cell.append(this.titleLabel(row, schema));
            onChipClick(cell, () => this.editItem(row.at));
            return cell;
        }
        if (key === SECTION_COLUMN) {
            cell.append(this.plain(row.section || _('No section'), row.section === ''));
            return cell;
        }
        const def = schema.find(f => f.key === key);
        if (!def) return cell;
        cell.append(this.valueWidget(row, def, readItem(row.card.text, schema).fields[key]));
        cell.set_tooltip_text(_('Click to change'));
        onChipClick(cell, () => this.editField(row.at, key, cell));
        return cell;
    }

    private plain(text: string, dim = false, end = false): Gtk.Label {
        const label = new Gtk.Label({ label: text, xalign: end ? 1 : 0, ellipsize: Pango.EllipsizeMode.END });
        if (dim) label.add_css_class('dim-label');
        return label;
    }

    private titleLabel(row: TableRow, schema: FieldDef[]): Gtk.Label {
        const label = new Gtk.Label({ use_markup: true, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, hexpand: true, width_chars: 10 });
        label.set_markup(cellMarkup(readItem(row.card.text, schema).title, this.colors, true));
        label.connect('activate-link', (_l, uri: string) => this.activateNote(uri));
        if (row.card.done === true) label.add_css_class('dim-label');
        return label;
    }

    // The value of a field as a small widget for its type; a missing one is a dash, and one that does not fit is marked.
    private valueWidget(row: TableRow, def: FieldDef, parsed: Parsed | undefined): Gtk.Widget {
        if (!parsed) return this.plain('—', true);
        if (!parsed.ok) return this.chip(parsed.raw, 'inbox-field-invalid', fmt(_('“{key}” does not fit its field: {reason}. The text in the file is unchanged.'), { key: def.key, reason: parsed.error }));
        const text = displayValue(def, parsed.value);
        if (def.type === 'select' && !def.multiple) {
            const index = def.options.indexOf(text);
            const color = def.colors?.[text];
            return this.chip(text, color ? `opt-${color}` : index >= 0 ? `inbox-field-${index % 8}` : '');
        }
        if (def.type === 'progress' && typeof parsed.value === 'object' && !Array.isArray(parsed.value) && 'total' in parsed.value) return this.progress(text, parsed.value.done / parsed.value.total);
        const late = def.type === 'date' && row.card.done !== true && text.slice(0, 10) < this.today();
        const label = this.plain(text, false, def.type === 'number');
        if (late) label.add_css_class('table-late');
        return label;
    }

    private chip(text: string, cls: string, tooltip?: string): Gtk.Label {
        const chip = new Gtk.Label({ label: text, valign: Gtk.Align.CENTER });
        chip.add_css_class('inbox-field');
        if (cls) chip.add_css_class(cls);
        if (tooltip) chip.set_tooltip_text(tooltip);
        return chip;
    }

    private progress(text: string, fraction: number): Gtk.Widget {
        const box = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER });
        const bar = new Gtk.ProgressBar({ fraction, valign: Gtk.Align.CENTER, width_request: 80 });
        box.append(bar);
        box.append(this.plain(text, true));
        return box;
    }

    private activateNote(uri: string): boolean {
        if (!uri.startsWith(NOTE_URI)) return false;
        this.onOpenNote(parseWikiLink(decodeURIComponent(uri.slice(NOTE_URI.length))));
        return true;
    }

    // ---------- Actions ----------

    // Quick add: one line from the entry above the table; it goes where `add:` says, with the defaults of the fields.
    capture(text: string): void {
        this.entry.set_text('');
        if (!text.trim()) return;
        this.commit(captureItem(this.board, text, this.now()));
        this.entry.grab_focus();
    }

    // A new row through the dialog, with fields and notes.
    showAddNote(): void {
        void after(this.dialogs.editNote(this.parent, { text: '', notes: [] }, _('New Row'), this.listNotes ?? undefined, this.schema()), draft => {
            if (draft?.text) this.commit(captureItem(this.board, draft.text, this.now(), draft.notes));
        });
    }

    editItem(at: Position): void {
        const item = this.cardAt(at);
        if (!item) return;
        void after(this.dialogs.editNote(this.parent, { text: item.text, notes: item.notes }, undefined, this.listNotes ?? undefined, this.schema()), result => {
            // The table can change while the dialog is open; the same row is found again through its position.
            if (result?.text && this.cardAt(at)?.text === item.text)
                this.commit(updateCard(this.board, at, { text: result.text, notes: result.notes }));
        });
    }

    private cardAt(at: Position) {
        return this.board.columns[at.column]?.cards[at.index];
    }

    // Change one field of a row in place from a popover that points at `source`. A new select option and the value that
    // uses it are written together, so they are one undo step.
    editField(at: Position, key: string, source: Gtk.Widget): Gtk.Popover | null {
        const item = this.cardAt(at);
        const def = this.schema().find(f => f.key === key);
        if (!item || !def) return null;
        return this.popovers.edit(source, {
            def,
            current: fieldInputText(item.text, def),
            apply: (raw, newOption) => {
                if (this.cardAt(at)?.text !== item.text) return;
                const board = newOption ? withFieldOption(this.board, key, newOption) : this.board;
                this.commit(setCardField(board, at, boardSchema(board).find(f => f.key === key) ?? def, raw));
            },
        });
    }

    focusCapture(): void {
        this.entry.grab_focus();
    }
}
