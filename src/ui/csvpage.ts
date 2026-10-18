// The CSV tab: a CSV file shown as a grid you edit in place.
//
//   [+ Add Row] [+ Add Column]
//        │ Name          │ Age  │ City        ⋯      ← the header row stays while the rows scroll
//     1 ⋯│ Ada           │ 36   │ London
//     2 ⋯│ Lin           │ 41   │ Taipei
//
// The rows are a Gtk.ListView, so only the rows on screen have widgets (a file of tens of thousands of rows opens as fast
// as a small one); each row is made once and bound to the table row it shows, over and over as you scroll. Every cell is
// a text widget. A cell is written when it loses focus or Enter is pressed, never while you type, so one edit is one undo
// step of the document; the model is markdown/csv.ts and the document text stays the source of truth (the owner gets the
// new text through onChange and gives text back through setText, e.g. after an undo). Enter moves down (and adds a row at
// the end), Tab moves right (and adds a row after the last cell), Escape puts the old value back, Ctrl+Enter inserts a row
// below, and Shift+F10 opens the row and column menu of the cell. A row is dragged by its number and a column by the grip in
// its header, and dropped between two others (the table scrolls when the pointer is near its edge). Ctrl+F opens a search bar
// above the table: the cells that contain the text are marked, Enter and Shift+Enter go to the next and previous one (the
// table scrolls to it), and Escape closes the bar.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {
    cellAt, columnCount, deleteColumn, deleteRow, findCells, insertColumn, insertRow, isNumericColumn, landing, moveColumn, moveRow, nextColumnName, parseCsv, replaceInCell, replaceInCells, serializeCsv, setCell,
    type CsvRow, type CsvTable,
} from '../markdown/csv.js';
import type { MenuEntry } from '../app/menu.js';
import { onKeyPress } from '../gtkutil.js';
import { buildPattern } from '../markdown/search.js';
import { CsvFindBar } from './csvfindbar.js';
import { popupMenu, separator } from './menu.js';
import { _, fmt } from '../i18n.js';

const MATCH_ROW = 100000;   // a match is the number row * MATCH_ROW + column
const MIN_WIDTH_CHARS = 8, MAX_WIDTH_CHARS = 36, SAMPLE_ROWS = 100;

interface Cell { row: number; column: number }

// One row widget of the list: the row number and a text widget per column. `position` is the place in the list of the table
// row it shows now (the table row is position + 1, as the header is row 0), or -1 while it shows none.
interface RowWidgets {
    box: Gtk.Box;
    number: Gtk.Label;
    entries: Gtk.Text[];
    position: number;
}

// What the widgets of the current factory are made to fit: one column count, the widths, and which columns are numbers.
interface Layout {
    columns: number;
    widths: number[];
    numeric: boolean[];
    sizes: Gtk.SizeGroup[];   // a column is as wide in the header as in every row
    numbers: Gtk.SizeGroup;
}

export class CsvView {
    readonly widget: Gtk.Box;
    // The document text after a change the user made; the owner writes it to the document.
    onChange: (text: string) => void = () => {};
    // The size of the table after a draw, for the status bar.
    onShape: (rows: number, columns: number) => void = () => {};

    private table: CsvTable = parseCsv('');
    private shown: CsvTable | null = null;               // the table the list and the header were last brought up to
    private layout: Layout | null = null;
    private readonly list: Gtk.ListView;
    private readonly model = new Gtk.StringList();      // one item per body row; the item is nothing, the table has the data
    private readonly headScroll: Gtk.ScrolledWindow;
    private readonly headView: Gtk.Viewport;
    private readonly bodyScroll: Gtk.ScrolledWindow;
    private headBoxes: Gtk.Box[] = [];
    private drag: { kind: 'row' | 'column'; index: number } | null = null;   // what is being dragged
    private mark: { widget: Gtk.Widget; css: string } | null = null;        // where it would land
    private headEntries: Gtk.Text[] = [];
    private readonly rows = new WeakMap<Gtk.Widget, RowWidgets>();   // the box of each row widget → its parts (weak: the list destroys row widgets)
    private made = 0;                                              // row widgets made so far
    private readonly bound = new Map<number, RowWidgets>();      // list position → the row widget that shows it
    private readonly cells = new WeakMap<Gtk.Widget, { rw: RowWidgets | null; column: number }>();   // each text widget → its place
    private focused: { cell: Cell; entry: Gtk.Text } | null = null;
    private tracking = false;
    private stale = false;     // the table changed and the widgets still show the old one: none of them may write to it
    private pending: { focus: Cell | null } | null = null;
    private readonly findBar: CsvFindBar;
    private pattern: RegExp | null = null;    // what the bar looks for, null for nothing or an expression that does not compile
    private after: Cell | null = null;        // after a replace: the cell it was done in, so the next match is the one after it
    private matches: Cell[] = [];
    private matchKeys = new Set<number>();    // row * MATCH_ROW + column of each match
    private current = -1;                     // index in matches of the match that was gone to last

    constructor() {
        this.headView = new Gtk.Viewport({ hscroll_policy: Gtk.ScrollablePolicy.NATURAL });
        this.headScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, vscrollbar_policy: Gtk.PolicyType.NEVER, child: this.headView });
        this.list = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.model }), single_click_activate: false });
        this.list.add_css_class('csv-list');
        // A text widget's smallest width is tiny (its width in characters is only the natural one): without this the table would be
        // squeezed into the window, not scrolled sideways.
        this.list.hscroll_policy = Gtk.ScrollablePolicy.NATURAL;
        const bodyScroll = this.bodyScroll = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true, child: this.list });
        this.headScroll.hadjustment = bodyScroll.hadjustment;   // the header follows the sideways scroll of the rows
        const frame = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        frame.append(this.headScroll);
        frame.append(bodyScroll);

        const addRow = new Gtk.Button({ child: new Adw.ButtonContent({ icon_name: 'list-add-symbolic', label: _('Add Row') }) });
        addRow.set_tooltip_text(_('Add a row at the end (Ctrl+Enter adds one below the cell)'));
        addRow.connect('clicked', () => this.insertRowAt(this.table.rows.length, 0));
        const addColumn = new Gtk.Button({ child: new Adw.ButtonContent({ icon_name: 'list-add-symbolic', label: _('Add Column') }) });
        addColumn.set_tooltip_text(_('Add a column at the end'));
        addColumn.connect('clicked', () => this.insertColumnAt(columnCount(this.table)));
        const toolbar = new Gtk.Box({ spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 12, margin_end: 12 });
        toolbar.append(addRow);
        toolbar.append(addColumn);

        this.findBar = new CsvFindBar();
        this.findBar.onChanged = () => this.search();
        this.findBar.onNext = () => this.step(1);
        this.findBar.onPrevious = () => this.step(-1);
        this.findBar.onReplace = () => this.replaceCurrent();
        this.findBar.onReplaceAll = () => this.replaceEverything();
        this.findBar.onEscape = () => this.closeSearch();
        this.findBar.onClosed = () => this.closeFind();

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.add_css_class('csv-view');
        this.widget.append(this.findBar);
        this.widget.append(toolbar);
        this.widget.append(new Gtk.Separator());
        this.widget.append(frame);
        this.list.add_controller(this.dropTarget(false));
        this.headScroll.add_controller(this.dropTarget(true));
        // One key handler for the whole table: a controller on each cell would cost as much as the cell itself.
        onKeyPress(this.widget, (keyval, state) => this.keyOnFocus(keyval, state), Gtk.PropagationPhase.CAPTURE);
    }

    private keyOnFocus(keyval: number, state: number): boolean {
        const root = this.widget.get_root();
        const found = root instanceof Gtk.Window ? this.cellOf(root.get_focus()) : null;
        return found ? this.keyPressed(found.cell, found.entry, keyval, state) : false;
    }

    // The cell whose text widget is `widget` or holds it; null for anything else, and for a row widget that shows no row.
    private cellOf(widget: Gtk.Widget | null): { cell: Cell; entry: Gtk.Text } | null {
        for (let at = widget; at; at = at.get_parent()) {
            const place = this.cells.get(at);
            if (!place) continue;
            if (!place.rw) return { cell: { row: 0, column: place.column }, entry: at as Gtk.Text };
            return place.rw.position < 0 ? null : { cell: { row: place.rw.position + 1, column: place.column }, entry: at as Gtk.Text };
        }
        return null;
    }

    // Follow the focus of `window`, which holds this view. Done from the window, not by a controller on each entry: rows are
    // destroyed in bulk, and a signal that a destroyed widget emits while the garbage collector sweeps is dropped with a
    // critical warning.
    trackFocus(window: Gtk.Window): void {
        if (this.tracking) return;
        this.tracking = true;
        window.connect('notify::focus-widget', () => this.focusMoved(window.get_focus()));
    }

    // Focus went to `widget` (anything, or nothing): a cell that had it is written, and the cell that has it now is noted.
    private focusMoved(widget: Gtk.Widget | null): void {
        const next = this.cellOf(widget);
        const previous = this.focused;
        if (previous?.entry === next?.entry) return;
        this.focused = next;
        if (previous) this.commit(previous.cell, previous.entry);
    }

    // ---------- Model ----------

    // New contents (the document opened, or its text changed by an undo): drawn without calling onChange. A cell being
    // edited keeps its text unless the file changed under it.
    setText(text: string): void {
        if (text === serializeCsv(this.table)) return;
        this.table = parseCsv(text);
        // At once unless a cell is being edited: the draw would replace the widget whose shortcut brought the text here.
        if (this.focused) this.queueDraw(this.focused.cell);
        else this.draw(null);
    }

    focusFirstCell(): void {
        this.entryAt(1, 0)?.grab_focus();
    }

    // The table is replaced by `next`: reported to the owner, and drawn again when its shape changed.
    private apply(next: CsvTable, redraw: boolean, focus: Cell | null = null): void {
        if (next === this.table) return;
        this.table = next;
        this.onChange(serializeCsv(next));
        if (redraw) this.queueDraw(focus);
        else {
            this.shown = next;   // the widgets already show it: a cell was typed
            this.refind();
            this.onShape(next.rows.length - 1, columnCount(next));
        }
    }

    // Drawn at idle: the change comes from an entry or a menu that the draw is about to replace.
    private queueDraw(focus: Cell | null): void {
        // The widgets on screen show the old table until the draw runs; none of them may write to the new one meanwhile.
        this.stale = true;
        this.focused = null;
        const queued = this.pending !== null;
        this.pending = { focus };
        if (queued) return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const { focus: target } = this.pending ?? { focus: null };
            this.pending = null;
            this.draw(target);
            return GLib.SOURCE_REMOVE;
        });
    }

    private commit(cell: Cell, entry: Gtk.Text): void {
        // A widget that has since been given another row reports losing focus late; what it holds is not this cell's now.
        if (this.stale || this.entryAt(cell.row, cell.column) !== entry) return;
        if (entry.text === cellAt(this.table, cell.row, cell.column)) return;
        this.apply(setCell(this.table, cell.row, cell.column, entry.text), false);
    }

    // ---------- Drawing ----------

    // Bring the header and the list up to the table. Only the rows from the first that differs are given to the list again,
    // so a row inserted far down does not move what is on screen; a new number of columns makes the rows again.
    private draw(focus: Cell | null): void {
        this.stale = true;
        this.focused = null;
        const columns = columnCount(this.table);
        // New rows first: a list that gets its items before its factory makes a screenful of rows twice.
        const numeric = Array.from({ length: columns }, (_c, c) => isNumericColumn(this.table, c));
        if (!this.layout || this.layout.columns !== columns || numeric.some((n, c) => n !== this.layout!.numeric[c])) this.rebuild(columns);
        else this.showHeader();
        const old = this.shown;
        const first = old ? firstDifference(old.rows, this.table.rows) : 1;
        const oldCount = old ? old.rows.length - 1 : 0, count = this.table.rows.length - 1;
        for (const [position, rw] of this.bound) if (position >= first - 1) { this.bound.delete(position); rw.position = -1; }   // bound again as the list lays out
        if (first - 1 < Math.max(oldCount, count)) this.model.splice(first - 1, Math.max(0, oldCount - (first - 1)), new Array<string>(Math.max(0, count - (first - 1))).fill(''));
        this.shown = this.table;
        this.stale = false;
        this.refind();
        this.onShape(count, columns);
        if (focus) this.focusCell(Math.min(focus.row, this.table.rows.length - 1), Math.min(focus.column, columns - 1));
    }

    // New header and a new factory for `columns` columns: widths and number alignment are read from the table again.
    private rebuild(columns: number): void {
        const layout: Layout = {
            columns,
            widths: Array.from({ length: columns }, (_c, c) => this.widthOf(c)),
            numeric: Array.from({ length: columns }, (_c, c) => isNumericColumn(this.table, c)),
            sizes: Array.from({ length: columns }, () => new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL })),
            numbers: new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL }),
        };
        this.layout = layout;
        this.bound.clear();

        // The header is filled before it is shown: a child added to a box that is on screen restyles its siblings.
        const head = new Gtk.Box();
        const corner = new Gtk.Box();
        corner.add_css_class('csv-corner');
        layout.numbers.add_widget(corner);
        head.append(corner);
        this.headEntries = [];
        this.headBoxes = [];
        for (let c = 0; c < columns; c++) {
            const entry = this.newEntry(layout, c, true);
            this.cells.set(entry, { rw: null, column: c });
            const more = new Gtk.Button({ icon_name: 'view-more-symbolic', has_frame: false, focusable: false, valign: Gtk.Align.CENTER });
            more.add_css_class('csv-more');
            more.set_tooltip_text(_('Column options'));
            more.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Column {column} options'), { column: c + 1 })]);
            more.connect('clicked', () => this.showMenu(more, this.columnMenu(c)));
            const box = new Gtk.Box();
            box.add_css_class('csv-head');
            box.append(this.grip(c));
            box.append(entry);
            box.append(more);
            layout.sizes[c].add_widget(box);
            head.append(box);
            this.headEntries.push(entry);
            this.headBoxes.push(box);
        }
        this.headView.set_child(head);
        this.showHeader();

        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => this.setupRow(item as Gtk.ListItem, layout));
        factory.connect('bind', (_f, item) => this.bindRow(item as Gtk.ListItem));
        this.list.set_factory(factory);
    }

    private showHeader(): void {
        this.headEntries.forEach((entry, c) => {
            const text = cellAt(this.table, 0, c);
            if (entry.text !== text) entry.set_text(text);
            entry.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Column {column} header'), { column: c + 1 })]);
        });
        this.markHeader();
    }

    // Wide enough for the longest of the first rows, within limits.
    private widthOf(column: number): number {
        let longest = 0;
        for (const row of this.table.rows.slice(0, SAMPLE_ROWS)) longest = Math.max(longest, [...(row.cells[column] ?? '')].length);
        return Math.min(MAX_WIDTH_CHARS, Math.max(MIN_WIDTH_CHARS, longest + 2));
    }

    // A bare text widget that draws its own borders. Few widgets per cell, because making them is most of the time a draw takes.
    private newEntry(layout: Layout, column: number, header: boolean): Gtk.Text {
        const width = layout.widths[column];
        const entry = new Gtk.Text({ width_chars: width, max_width_chars: width, hexpand: true, xalign: layout.numeric[column] ? 1 : 0 });
        entry.add_css_class(header ? 'csv-head-entry' : 'csv-body');
        // The window's Undo and Redo work on the document; an entry of its own would undo the text it shows.
        entry.enable_undo = false;
        return entry;
    }

    // ---------- The rows of the list ----------

    private setupRow(item: Gtk.ListItem, layout: Layout): void {
        // A label, not a button: a button claims the press that a drag would start from.
        const number = new Gtk.Label({ accessible_role: Gtk.AccessibleRole.BUTTON });
        number.add_css_class('csv-number');
        number.set_tooltip_text(_('Click for row options, drag to move the row'));
        number.set_cursor_from_name('grab');
        const box = new Gtk.Box();
        box.append(number);
        layout.numbers.add_widget(number);
        const rw: RowWidgets = { box, number, entries: [], position: -1 };
        // The menu opens when the press is released without having become a drag; a press that is claimed on the way down
        // would keep the drag from starting.
        const click = new Gtk.GestureClick();
        click.connect('released', () => { if (rw.position >= 0) this.showMenu(number, this.rowMenu(rw.position + 1)); });
        number.add_controller(click);
        this.dragSource(number, () => rw.position >= 0 ? { kind: 'row', index: rw.position + 1 } : null);
        for (let c = 0; c < layout.columns; c++) {
            const entry = this.newEntry(layout, c, false);
            layout.sizes[c].add_widget(entry);
            this.cells.set(entry, { rw, column: c });
            rw.entries.push(entry);
            box.append(entry);
        }
        this.rows.set(box, rw);
        this.made++;
        // The row itself does nothing: its own press handling would take the press that a drag of the number starts from.
        try { item.focusable = false; } catch { /* before GTK 4.12 a row can take the focus itself; harmless */ }
        item.activatable = false;
        item.selectable = false;
        item.set_child(box);
    }

    private bindRow(item: Gtk.ListItem): void {
        const rw = this.rows.get(item.get_child()!);
        if (!rw) return;
        // A row widget that is given another row with a cell being edited writes it first. (There is no handler for the end of
        // a binding: a signal the list emits as it is destroyed is dropped with a critical warning when the collector sweeps.)
        if (this.focused && rw.position >= 0 && rw.entries.includes(this.focused.entry)) this.commit(this.focused.cell, this.focused.entry);
        if (this.bound.get(rw.position) === rw) this.bound.delete(rw.position);
        rw.position = item.get_position();
        this.bound.set(rw.position, rw);
        const row = rw.position + 1;
        rw.number.set_label(String(row));
        this.markRow(rw);
        rw.number.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Row {row} options'), { row })]);
        rw.entries.forEach((entry, c) => {
            const text = cellAt(this.table, row, c);
            if (entry.text !== text) entry.set_text(text);
            entry.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Row {row}, {column}'), { row, column: this.table.rows[0].cells[c] || c + 1 })]);
        });
    }

    // ---------- Drag and drop: a row or a column to another place ----------

    // Make `handle` something to drag: `what` says what it stands for (null = nothing to drag now).
    private dragSource(handle: Gtk.Widget, what: () => { kind: 'row' | 'column'; index: number } | null): void {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', () => {
            this.drag = what();
            if (!this.drag) return null;
            // A symbolic icon; a widget as the drag icon triggers a Gtk-CRITICAL when the drag ends in GTK 4.14.
            const icon = Gtk.IconTheme.get_for_display(handle.get_display()).lookup_icon('list-drag-handle-symbolic', null, 32,
                handle.get_scale_factor(), Gtk.TextDirection.NONE, 0 as Gtk.IconLookupFlags);
            source.set_icon(icon, 0, 0);
            return Gdk.ContentProvider.new_for_value(`${this.drag.kind}.${this.drag.index}`);
        });
        source.connect('drag-end', () => {
            this.drag = null;
            this.showMark(null);
        });
        handle.add_controller(source);
    }

    // The grip in the header of column `column`.
    private grip(column: number): Gtk.Widget {
        const grip = new Gtk.Image({ icon_name: 'list-drag-handle-symbolic', valign: Gtk.Align.CENTER });
        grip.add_css_class('csv-grip');
        grip.set_tooltip_text(_('Drag to move the column'));
        grip.set_cursor_from_name('grab');
        this.dragSource(grip, () => ({ kind: 'column', index: column }));
        return grip;
    }

    // One target for the rows and one for the header take what is dragged. A column can be dropped on the header or anywhere in the
    // rows, a row only on the rows.
    private dropTarget(columnsOnly: boolean): Gtk.DropTarget {
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
        target.set_gtypes([GObject.TYPE_STRING]);
        // Before the cells: a text widget takes a dropped string as text to insert, and would take this one.
        target.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        target.connect('motion', (_t, x, y) => {
            const spot = this.drag && (!columnsOnly || this.drag.kind === 'column') ? this.spotAt(this.drag.kind, x, y) : null;
            this.showMark(spot);
            this.scrollTowards(x, y);
            return spot ? Gdk.DragAction.MOVE : 0 as Gdk.DragAction;
        });
        target.connect('leave', () => this.showMark(null));
        target.connect('drop', (_t, _value, x, y) => {
            const drag = this.drag, spot = drag && (!columnsOnly || drag.kind === 'column') ? this.spotAt(drag.kind, x, y) : null;
            this.showMark(null);
            if (!drag || !spot) return false;
            this.dropAt(drag.kind, drag.index, spot.gap);
            return true;
        });
        return target;
    }

    // Where a drop at (x, y) of the target would go: the gap (before which index) and the widget and side to mark.
    private spotAt(kind: 'row' | 'column', x: number, y: number): { gap: number; widget: Gtk.Widget; css: string } | null {
        return kind === 'row' ? this.rowSpot(y) : this.columnSpot(x);
    }

    private rowSpot(y: number): { gap: number; widget: Gtk.Widget; css: string } | null {
        let nearest: { rw: RowWidgets; top: number; height: number } | null = null;
        for (const rw of this.bound.values()) {
            if (rw.position < 0 || !rw.box.get_mapped()) continue;
            const rect = rw.box.compute_bounds(this.list)?.[1];
            if (!rect) continue;
            const top = rect.get_y(), height = rect.get_height();
            if (y >= top && y < top + height) { nearest = { rw, top, height }; break; }
            if (!nearest || Math.abs(y - top) < Math.abs(y - nearest.top)) nearest = { rw, top, height };
        }
        if (!nearest) return null;
        const row = nearest.rw.position + 1, below = y >= nearest.top + nearest.height / 2;
        return { gap: below ? row + 1 : row, widget: nearest.rw.box, css: below ? 'csv-drop-below' : 'csv-drop-above' };
    }

    private columnSpot(x: number): { gap: number; widget: Gtk.Widget; css: string } | null {
        let nearest: { column: number; left: number; width: number } | null = null;
        this.headBoxes.forEach((box, column) => {
            const rect = box.compute_bounds(this.headScroll)?.[1];
            if (!rect) return;
            const left = rect.get_x(), width = rect.get_width();
            if (!nearest || Math.abs(x - (left + width / 2)) < Math.abs(x - (nearest.left + nearest.width / 2))) nearest = { column, left, width };
        });
        const at = nearest as { column: number; left: number; width: number } | null;
        if (!at) return null;
        const after = x >= at.left + at.width / 2;
        return { gap: after ? at.column + 1 : at.column, widget: this.headBoxes[at.column], css: after ? 'csv-drop-right' : 'csv-drop-left' };
    }

    // The drop is shown as a line on the side of a row or header where the item would go.
    private showMark(spot: { widget: Gtk.Widget; css: string } | null): void {
        if (this.mark && (!spot || this.mark.widget !== spot.widget || this.mark.css !== spot.css)) {
            this.mark.widget.remove_css_class(this.mark.css);
            this.mark = null;
        }
        if (spot && !this.mark) {
            spot.widget.add_css_class(spot.css);
            this.mark = { widget: spot.widget, css: spot.css };
        }
    }

    // The table scrolls while the pointer is held near its edge, so a row or column can be taken further than the window shows.
    private scrollTowards(x: number, y: number): void {
        const EDGE = 40, STEP = 28;
        const vertical = this.bodyScroll.vadjustment, horizontal = this.bodyScroll.hadjustment;
        const height = this.bodyScroll.get_height(), width = this.bodyScroll.get_width();
        if (this.drag?.kind === 'row') vertical.set_value(vertical.value + (y < EDGE ? -STEP : y > height - EDGE ? STEP : 0));
        else if (this.drag) horizontal.set_value(horizontal.value + (x < EDGE ? -STEP : x > width - EDGE ? STEP : 0));
    }

    // Move row or column `from` to the gap before index `gap`.
    private dropAt(kind: 'row' | 'column', from: number, gap: number): void {
        if (this.focused) this.commit(this.focused.cell, this.focused.entry);
        const to = landing(from, gap);
        this.apply(kind === 'row' ? moveRow(this.table, from, to) : moveColumn(this.table, from, to), true, null);
    }

    // ---------- Find ----------

    // The search bar opens (Ctrl+F), with the Replace row for Ctrl+H.
    openFind(withReplace = false): void {
        this.findBar.open(withReplace);
        if (this.findBar.query) this.search();
    }

    // The search bar closes: the marks go.
    private closeFind(): void {
        this.matches = [];
        this.matchKeys.clear();
        this.current = -1;
        this.after = null;
        this.findBar.setCount('', false);
        this.markVisible();
    }

    // Escape: the cell of the match that was gone to gets the focus first, so the focus is not inside the bar when it hides.
    private closeSearch(): void {
        const at = this.matches[this.current];
        if (at) this.focusCell(at.row, at.column);
        this.findBar.close();
    }

    // A new text or option to search with: mark every cell that matches, and go to the first.
    private search(): void {
        const built = this.findBar.query === '' ? null : buildPattern(this.findBar.query, this.findBar.options);
        this.pattern = built instanceof RegExp ? built : null;
        this.findMatches();
        this.current = this.matches.length ? 0 : -1;
        this.showMatch(built !== null && !(built instanceof RegExp));
    }

    // The matches again, after the table changed. The match gone to stays if it is still there; after a replace it is the first
    // one after the cell that was replaced in.
    private refind(): void {
        if (!this.findBar.search_mode_enabled) return;
        const was = this.matches[this.current], after = this.after;
        this.after = null;
        this.findMatches();
        if (after) {
            const next = this.matches.findIndex(m => m.row > after.row || (m.row === after.row && m.column > after.column));
            this.current = this.matches.length ? Math.max(next, 0) : -1;
            this.showMatch();
            return;
        }
        const index = was ? this.matches.findIndex(m => m.row === was.row && m.column === was.column) : -1;
        this.current = index >= 0 ? index : Math.min(this.current, this.matches.length - 1);
        this.markVisible();
        this.showCount();
    }

    private findMatches(): void {
        this.matches = this.pattern ? findCells(this.table, this.pattern) : [];
        this.matchKeys = new Set(this.matches.map(m => m.row * MATCH_ROW + m.column));
    }

    // Replace: every match in the cell that is current, and on to the next match.
    private replaceCurrent(): void {
        if (!this.pattern) return;
        const at = this.matches[this.current];
        if (!at) return;
        if (this.focused) this.commit(this.focused.cell, this.focused.entry);
        const next = replaceInCell(this.table, at.row, at.column, this.pattern, this.findBar.replacement, this.findBar.options.regex);
        if (next === this.table) { this.step(1); return; }
        this.after = at;
        this.apply(next, true, null);
    }

    // All: every match in every cell, as one undo step.
    private replaceEverything(): void {
        if (!this.pattern) return;
        if (this.focused) this.commit(this.focused.cell, this.focused.entry);
        const done = replaceInCells(this.table, this.pattern, this.findBar.replacement, this.findBar.options.regex);
        if (!done.count) return;
        this.apply(done.table, true, null);
    }

    // Go to the next match (or the previous one for -1), wrapping round.
    private step(by: number): void {
        if (!this.matches.length) return;
        this.current = (this.current + by + this.matches.length) % this.matches.length;
        this.showMatch();
    }

    // Mark the matches, scroll to the current one, and say which it is. The focus stays in the search bar.
    private showMatch(invalid = false): void {
        this.markVisible();
        this.showCount(invalid);
        const at = this.matches[this.current];
        if (!at) return;
        if (at.row > 0) this.list.scroll_to(at.row - 1, Gtk.ListScrollFlags.NONE, null);
        this.revealColumn(at.column);
    }

    private showCount(invalid = false): void {
        const label = this.findBar.query === '' || invalid ? '' : this.matches.length ? fmt(_('{current} of {total}'), { current: this.current + 1, total: this.matches.length }) : _('No results');
        this.findBar.setCount(label, invalid);
    }

    // Scroll sideways until the header of `column` is in view.
    private revealColumn(column: number): void {
        const box = this.headBoxes[column];
        const rect = box?.compute_bounds(this.headScroll)?.[1];
        if (!rect) return;
        const adjustment = this.bodyScroll.hadjustment, view = this.headScroll.get_width();
        if (rect.get_x() < 0) adjustment.set_value(adjustment.value + rect.get_x() - 12);
        else if (rect.get_x() + rect.get_width() > view) adjustment.set_value(adjustment.value + rect.get_x() + rect.get_width() - view + 12);
    }

    private markVisible(): void {
        this.markHeader();
        for (const rw of this.bound.values()) if (rw.position >= 0) this.markRow(rw);
    }

    private markHeader(): void {
        this.headEntries.forEach((entry, c) => this.mark1(entry, 0, c));
    }

    private markRow(rw: RowWidgets): void {
        rw.entries.forEach((entry, c) => this.mark1(entry, rw.position + 1, c));
    }

    // Show whether the cell is a match, and the current one.
    private mark1(entry: Gtk.Text, row: number, column: number): void {
        const match = this.matchKeys.has(row * MATCH_ROW + column), at = this.matches[this.current];
        const current = match && !!at && at.row === row && at.column === column;
        if (match !== entry.has_css_class('csv-match')) { if (match) entry.add_css_class('csv-match'); else entry.remove_css_class('csv-match'); }
        if (current !== entry.has_css_class('csv-match-current')) { if (current) entry.add_css_class('csv-match-current'); else entry.remove_css_class('csv-match-current'); }
    }

    // ---------- Keyboard ----------

    private keyPressed(at: Cell, entry: Gtk.Text, keyval: number, state: number): boolean {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0, shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        switch (keyval) {
            case Gdk.KEY_Return:
            case Gdk.KEY_KP_Enter:
                this.commit(at, entry);
                this.enterPressed(at, ctrl, shift);
                return true;
            case Gdk.KEY_Down:
            case Gdk.KEY_Up:
                this.commit(at, entry);
                this.focusCell(at.row + (keyval === Gdk.KEY_Down ? 1 : -1), at.column);
                return true;
            case Gdk.KEY_Tab:
            case Gdk.KEY_ISO_Left_Tab:
                return this.tabPressed(at, entry, shift || keyval === Gdk.KEY_ISO_Left_Tab);
            case Gdk.KEY_Escape:
                entry.set_text(cellAt(this.table, at.row, at.column));
                return true;
            case Gdk.KEY_Menu:
            case Gdk.KEY_F10:
                if (keyval === Gdk.KEY_F10 && !shift) return false;
                this.commit(at, entry);
                this.showMenu(entry, [...this.rowMenu(at.row), separator(), ...this.columnMenu(at.column)]);
                return true;
            default:
                return false;
        }
    }

    // Enter goes down a row, Shift+Enter up, Ctrl+Enter adds a row below; Enter in the last row adds one too.
    private enterPressed(at: Cell, ctrl: boolean, shift: boolean): void {
        if (ctrl) this.insertRowAt(at.row + 1, at.column);
        else if (shift) this.focusCell(at.row - 1, at.column);
        else if (at.row === this.table.rows.length - 1) this.insertRowAt(this.table.rows.length, at.column);
        else this.focusCell(at.row + 1, at.column);
    }

    // Tab moves along the row (the focus chain does that), and from the end of a row to the start of the next, which is made
    // when it is not on screen yet; past the last cell it starts a new row. Shift+Tab goes back. Whether it was handled.
    private tabPressed(at: Cell, entry: Gtk.Text, back: boolean): boolean {
        const last = this.table.rows.length - 1, columns = columnCount(this.table);
        if (back) {
            if (at.column > 0 || at.row === 0) return false;
            this.commit(at, entry);
            this.focusCell(at.row - 1, columns - 1);
            return true;
        }
        if (at.column < columns - 1) return false;
        this.commit(at, entry);
        if (at.row === last) this.insertRowAt(this.table.rows.length, 0);
        else this.focusCell(at.row + 1, 0);
        return true;
    }

    // Focus a cell, scrolling to its row first when it is not on screen.
    private focusCell(row: number, column: number): void {
        if (row < 0 || row >= this.table.rows.length) return;
        if (row > 0) this.list.scroll_to(row - 1, Gtk.ListScrollFlags.NONE, null);
        const entry = this.entryAt(row, column);
        if (entry) {
            entry.grab_focus();
            return;
        }
        // The row widget is made when the list has been laid out again.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.entryAt(row, column)?.grab_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Row and column operations ----------

    private insertRowAt(at: number, column: number): void {
        const index = Math.min(Math.max(at, 1), this.table.rows.length);
        this.apply(insertRow(this.table, index), true, { row: index, column });
    }

    private insertColumnAt(at: number): void {
        const index = Math.min(Math.max(at, 0), columnCount(this.table));
        this.apply(insertColumn(this.table, index, nextColumnName(this.table)), true, { row: 0, column: index });
    }

    private rowMenu(row: number): MenuEntry[] {
        const header = row === 0;
        return [
            { label: _('Insert Row Above'), enabled: !header, run: () => this.insertRowAt(row, 0) },
            { label: _('Insert Row Below'), run: () => this.insertRowAt(row + 1, 0) },
            { label: _('Delete Row'), enabled: !header, run: () => this.apply(deleteRow(this.table, row), true, { row: Math.min(row, this.table.rows.length - 2), column: 0 }) },
        ];
    }

    private columnMenu(column: number): MenuEntry[] {
        return [
            { label: _('Insert Column Left'), run: () => this.insertColumnAt(column) },
            { label: _('Insert Column Right'), run: () => this.insertColumnAt(column + 1) },
            { label: _('Delete Column'), enabled: columnCount(this.table) > 1, run: () => this.apply(deleteColumn(this.table, column), true, { row: 0, column: Math.max(0, column - 1) }) },
        ];
    }

    private showMenu(parent: Gtk.Widget, entries: MenuEntry[]): void {
        popupMenu(parent, entries);
    }

    // ---------- For tests ----------

    // The text widget of a cell, or undefined while its row is not on screen.
    entryAt(row: number, column: number): Gtk.Text | undefined {
        if (row === 0) return this.headEntries[column];
        const rw = this.bound.get(row - 1);
        return rw && rw.position === row - 1 && rw.box.get_mapped() ? rw.entries[column] : undefined;
    }

    // The text of every cell, header first: what is on screen for the rows that are, the table's for the others.
    shownCells(): string[][] {
        const columns = columnCount(this.table);
        return this.table.rows.map((row, r) => Array.from({ length: columns }, (_c, c) => this.entryAt(r, c)?.text ?? cellAt(this.table, r, c)));
    }

    // How many row widgets exist and how many show a row.
    rowWidgets(): { made: number; bound: number; height: number; listHeight: number } {
        return { made: this.made, bound: [...this.bound.values()].filter(rw => rw.box.get_mapped()).length, height: this.widget.get_height(), listHeight: this.list.get_height() };
    }

    // The search: what it found, which match is current, and the text of the counter.
    searchState(): { matches: number; current: number; label: string; open: boolean } {
        return { matches: this.matches.length, current: this.current, label: this.findBar.counter, open: this.findBar.search_mode_enabled };
    }

    // The search bar, for the tests.
    get bar(): CsvFindBar {
        return this.findBar;
    }

    // Where a drop would go at a point, as the gap before an index.
    gapAt(kind: 'row' | 'column', x: number, y: number): number | null {
        return this.spotAt(kind, x, y)?.gap ?? null;
    }

    menuFor(row: number, column: number): MenuEntry[] {
        return [...this.rowMenu(row), separator(), ...this.columnMenu(column)];
    }

    // Draw at once what is queued (the tests do not wait for the main loop).
    flush(): void {
        if (!this.pending) return;
        const { focus } = this.pending;
        this.pending = null;
        this.draw(focus);
    }
}

// The index of the first row (the header is 0, and the body starts at 1) that differs between two tables' rows, or the
// length of the shorter one's body + 1 when one is the start of the other.
function firstDifference(before: readonly CsvRow[], after: readonly CsvRow[]): number {
    const common = Math.min(before.length, after.length);
    let at = 1;
    while (at < common && sameRow(before[at], after[at])) at++;
    return at;
}

function sameRow(a: CsvRow, b: CsvRow): boolean {
    return a === b || (a.cells.length === b.cells.length && a.cells.every((cell, i) => cell === b.cells[i]));
}
