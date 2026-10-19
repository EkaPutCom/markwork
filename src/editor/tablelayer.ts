// Displays a table as a real grid.
//
// It works the same as images (images.ts): a widget is attached above empty space
// provided inside the text, so the document contents do not change.
//
//   Cursor OUTSIDE the table → the table rows are shrunk to ~1 px (tag tablehide),
//                          space the height of the grid is reserved below the last row,
//                          and the grid is attached in that space.
//   Cursor INSIDE the table → the grid is hidden and the raw text is visible for
//                          editing (Tab moves between cells, see tableedit.ts).
//
// Clicking a cell in the grid puts the cursor in that cell in the raw text, which automatically
// opens the table for editing.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { TABLE_CELL_PAD_X, TABLE_CELL_PAD_Y } from '../config.js';
import { fitColumns, parseTable, type TableRange } from '../markdown/table.js';
import { cellMarkup, type MarkupColors } from '../markdown/pango.js';
import type { Palette } from '../colors.js';
import { setTagGroup, setTagRanges, type Range } from './tagsync.js';
import { iterAtLine, lineSpanOffsets, onClick } from '../gtkutil.js';
import { OverlaySlots } from './overlays.js';

const BORDER = 1;       // thickness of the cell border (same as the CSS in ui/theme.ts)
const GAP = 12;         // distance above and below the grid
const HIDDEN_LINE = 2;  // height of one hidden table row (tag tablehide, ~1 px + rounding)

interface Block {
    start: number;           // header row
    end: number;             // last body row
    key: string;             // table contents; matches the same block after lines shift
    widget: Gtk.Box | null;    // overlay slot containing the grid (see overlays.ts); created the first time it is visible
    grid: Gtk.Grid | null;
    height: number;
    geometry: Geometry | null;  // stays available even after the shared cache has been replaced
    collapsed: boolean;      // true = shown as a grid
    x: number;
    y: number;
}

interface Geometry {
    table: ReturnType<typeof parseTable>;
    markup: string[][];
    natural: number[];
    cellWidth: number[][];    // natural width of each cell (one line), including the border
    cellHeight: number[][];   // height of each cell if not wrapped
    height: number;           // table height if no cell is wrapped
}

export class TableLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    onActivate: (line: number, col: number) => void = () => {};  // cell clicked

    private cursor: [number, number] = [-1, -1];
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private gapTags = new Map<number, Gtk.TextTag>();   // height → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;
    private geometry = new Map<string, Geometry>();
    private geometryUnits = 0;
    private cellSizes = new Map<string, [number, number]>();
    private cellUnits = 0;
    private wrapSizes = new Map<string, number>();   // column width + cell contents → height after wrapping
    private probe: Gtk.Grid | null = null;
    private probeCells: { label: Gtk.Label; box: Gtk.Box }[] = [];
    private readonly slots: OverlaySlots;

    constructor(view: Gtk.TextView, private readonly hideTag: Gtk.TextTag) {
        this.view = view;
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    // Editor closed: stop the pending work (see MarkdownView.destroy()).
    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
        this.probe = null;
        this.probeCells = [];
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
        adj.connect('value-changed', () => this.queueRelayout());
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        this.geometry.clear();
        this.geometryUnits = 0;
        this.cellSizes.clear();
        this.cellUnits = 0;
        this.wrapSizes.clear();
        for (const block of this.blocks) block.geometry = null;
        this.rebuildAll();
    }

    // The text column width changed → recompute the table column widths.
    setMaxWidth(width: number): void {
        width = Math.max(200, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        // Cells wrap, so the table height changes when the width changes: the blank space in the text
        // is recomputed (sync) in addition to the existing widgets.
        for (const block of this.blocks) if (block.widget) this.resize(block);
        this.sync();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.sync();
    }

    // tables from highlighter.ts; lines = document contents per line.
    update(tables: TableRange[], lines: string[], force = false): void {
        // Reuse blocks with the same contents even if their lines shifted.
        let changed = force, moved = false;
        const unused = [...this.blocks];
        const next: Block[] = [];
        for (const t of tables) {
            const key = lines.slice(t.start, t.end + 1).join('\n');
            const k = unused.findIndex(b => b.key === key);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                moved ||= block.start !== t.start || block.end !== t.end;
                block.start = t.start;
                block.end = t.end;
                next.push(block);
            } else {
                changed = true;
                next.push({ start: t.start, end: t.end, key, widget: null, grid: null, height: 0, geometry: null, collapsed: false, x: -1, y: -1 });
            }
        }
        changed ||= unused.length > 0;
        for (const block of unused) this.destroyWidget(block);
        this.blocks = next;
        if (!changed && this.blocks.every(b => b.collapsed === this.isCollapsed(b))) {
            // Tag ranges shift along in GTK; just move the widget.
            if (moved) this.queueRelayout();
            return;
        }
        this.sync();
    }

    // The cursor (or selection) is on lines first..last.
    setCursor(first: number, last: number): void {
        this.cursor = [first, last];
        let changed = false;
        for (const block of this.blocks) {
            const collapsed = this.isCollapsed(block);
            if (collapsed === block.collapsed) continue;
            changed = true;
            block.collapsed = collapsed;
            if (collapsed) block.height = this.tableHeight(block);
            if (!collapsed) block.widget?.set_visible(false);

            // The cursor does not change text: other tables' tags stay correct. Do not walk
            // the whole buffer to find tag differences every time one table is entered/left.
            const start = iterAtLine(this.buffer, block.start);
            const lastLine = iterAtLine(this.buffer, block.end);
            const end = lastLine.copy();
            end.forward_to_line_end();
            const gap = this.gapTag(this.reserved(block));
            if (collapsed) {
                this.buffer.apply_tag(this.hideTag, start, end);
                this.buffer.apply_tag(gap, lastLine, end);
            } else {
                this.buffer.remove_tag(this.hideTag, start, end);
                this.buffer.remove_tag(gap, lastLine, end);
            }
        }
        if (changed) this.queueRelayout();
    }

    // ---------- State ----------

    private isCollapsed(block: Block): boolean {
        const [first, last] = this.cursor;
        return this.enabled && !(block.end >= first && block.start <= last);
    }

    private rebuildAll(): void {
        for (const block of this.blocks) this.destroyWidget(block);
        this.sync();
    }

    private destroyWidget(block: Block): void {
        if (block.widget) this.slots.release(block.widget);
        block.widget = null;
        block.grid = null;
    }

    // Sync the text, blank space, and widgets with the current state.
    private sync(): void {
        const iter = this.buffer.get_start_iter();
        const hide: Range[] = [];
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.blocks) {
            block.collapsed = this.isCollapsed(block);
            if (!block.collapsed) { block.widget?.set_visible(false); continue; }
            block.height = this.tableHeight(block);

            const [first, lastLine, end] = lineSpanOffsets(iter, block.start, block.end);
            hide.push([first, end]);

            const gap = this.gapTag(this.reserved(block));
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([lastLine, end]);
        }
        setTagRanges(this.buffer, this.hideTag, hide);
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
        this.queueRelayout();
    }

    // Space below the last row: the grid height plus GAP on both sides, minus
    // the height of the hidden rows above it. Without that subtraction the grid, which is
    // positioned from the last row, would shift down by the number of rows of the table.
    private reserved(block: Block): number {
        return Math.max(0, block.height + 2 * GAP - (block.end - block.start + 1) * HIDDEN_LINE);
    }

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `table-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    // ---------- Widget ----------

    private label(): Gtk.Label {
        return new Gtk.Label({
            use_markup: true, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, hexpand: true,
            margin_start: TABLE_CELL_PAD_X, margin_end: TABLE_CELL_PAD_X,
            margin_top: TABLE_CELL_PAD_Y, margin_bottom: TABLE_CELL_PAD_Y,
        });
    }

    // Two measuring cells use the same CSS as the grid, without building the whole grid.
    // The natural size (one line) is computed here; the height after wrapping: tableHeight().
    private measure(block: Block): Geometry {
        if (block.geometry) return block.geometry;
        const cached = this.geometry.get(block.key);
        if (cached) return block.geometry = cached;
        if (!this.probe) {
            this.probe = new Gtk.Grid();
            this.probe.add_css_class('md-table');
            for (let r = 0; r < 2; r++) {
                const label = this.label();
                const box = new Gtk.Box();
                box.add_css_class('md-table-cell');
                if (r === 0) box.add_css_class('md-table-head');
                box.append(label);
                this.probe.attach(box, 0, r, 1, 1);
                this.probeCells.push({ label, box });
            }
        }
        const table = parseTable(block.key.split('\n'));
        const natural = table.header.map(() => 0);
        let height = BORDER;
        const cellWidth: number[][] = [], cellHeight: number[][] = [];
        const markup = [table.header, ...table.rows].map((row, r) => {
            let rowHeight = 0;
            cellWidth.push([]);
            cellHeight.push([]);
            const result = row.map((text, c) => {
                const m = cellMarkup(text, this.colors);
                const value = r === 0 ? `<b>${m}</b>` : m;
                const [width, h] = this.measureCell(value, r === 0);
                natural[c] = Math.max(natural[c], width + BORDER);
                cellWidth[r].push(width + BORDER);
                cellHeight[r].push(h);
                rowHeight = Math.max(rowHeight, h);
                return value;
            });
            height += rowHeight;
            return result;
        });
        const result = { table, markup, natural, cellWidth, cellHeight, height };
        // Wasteful if the manuscript keeps being replaced: limit the table contents cache, not just its count.
        if (block.key.length <= 1024 * 1024) {
            while (this.geometry.size >= 256 || this.geometryUnits + block.key.length > 1024 * 1024) {
                const key = this.geometry.keys().next().value!;
                this.geometryUnits -= key.length;
                this.geometry.delete(key);
            }
            this.geometry.set(block.key, result);
            this.geometryUnits += block.key.length;
        }
        return block.geometry = result;
    }

    private measureCell(markup: string, header: boolean): [number, number] {
        const key = (header ? 'h:' : 'b:') + markup;
        const cached = this.cellSizes.get(key);
        if (cached) return cached;
        const cell = this.probeCells[header ? 0 : 1];
        cell.label.set_markup(markup);
        const size: [number, number] = [cell.box.measure(Gtk.Orientation.HORIZONTAL, -1)[1], cell.box.measure(Gtk.Orientation.VERTICAL, -1)[1]];
        if (key.length <= 1024 * 1024) {
            while (this.cellSizes.size >= 1024 || this.cellUnits + key.length > 1024 * 1024) {
                const old = this.cellSizes.keys().next().value!;
                this.cellUnits -= old.length;
                this.cellSizes.delete(old);
            }
            this.cellSizes.set(key, size);
            this.cellUnits += key.length;
        }
        return size;
    }

    // Table height at the current width: cells wider than their column are wrapped,
    // so their rows are taller.
    private tableHeight(block: Block): number {
        const geo = this.measure(block);
        const widths = fitColumns(geo.natural, this.maxWidth - BORDER);
        let height = BORDER;
        geo.markup.forEach((row, r) => {
            let rowHeight = 0;
            row.forEach((value, c) => {
                const h = geo.cellWidth[r][c] <= widths[c] ? geo.cellHeight[r][c] : this.measureWrapped(value, r === 0, widths[c]);
                rowHeight = Math.max(rowHeight, h);
            });
            height += rowHeight;
        });
        return height;
    }

    // Height of a wrapped cell at column width `width`.
    private measureWrapped(markup: string, header: boolean, width: number): number {
        const key = `${header ? 'h' : 'b'}${width}:${markup}`;
        const cached = this.wrapSizes.get(key);
        if (cached !== undefined) return cached;
        const cell = this.probeCells[header ? 0 : 1];
        cell.label.set_markup(markup);
        const height = cell.box.measure(Gtk.Orientation.VERTICAL, width)[1];
        if (this.wrapSizes.size >= 4096) this.wrapSizes.delete(this.wrapSizes.keys().next().value!);
        this.wrapSizes.set(key, height);
        return height;
    }

    private resize(block: Block): void {
        const { table, natural } = this.measure(block);
        const widths = fitColumns(natural, this.maxWidth - BORDER);
        const grid = block.grid!;
        [table.header, ...table.rows].forEach((row, r) => row.forEach((text, c) => {
            const box = grid.get_child_at(c, r)!;
            const label = box.get_first_child() as Gtk.Label;
            label.set_size_request(Math.max(1, widths[c] - 2 * TABLE_CELL_PAD_X - BORDER), -1);
        }));
    }

    private build(block: Block): void {
        const { table, markup } = this.measure(block);
        const grid = new Gtk.Grid();
        grid.add_css_class('md-table');
        markup.forEach((row, r) => row.forEach((text, c) => {
            const align = table.aligns[c];
            const label = this.label();
            label.xalign = align === 'right' ? 1 : align === 'center' ? 0.5 : 0;
            label.set_markup(text);
            const box = new Gtk.Box();
            box.append(label);
            box.add_css_class('md-table-cell');
            if (r === 0) box.add_css_class('md-table-head');
            onClick(box, () => {
                this.onActivate(block.start + (r === 0 ? 0 : r + 1), c);
                return true;
            });
            grid.attach(box, c, r, 1, 1);
        }));
        block.grid = grid;
        block.widget = this.slots.acquire();
        block.widget.append(grid);
        this.resize(block);
        block.x = block.y = -1;
    }

    // ---------- Widget position ----------

    queueRelayout(): void {
        if (this.destroyed || this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            if (!this.destroyed) this.relayout();   // the tab may be closed before idle runs
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout(): void {
        if (!this.blocks.length) return;
        const x = this.view.get_left_margin();
        const rect = this.view.get_visible_rect();
        const [top] = this.view.get_line_at_y(rect.y);
        const [bottom] = this.view.get_line_at_y(rect.y + rect.height);
        const first = top.get_line(), last = bottom.get_line();
        for (const block of this.blocks) {
            // get_line_yrange() for all tables forces GTK to lay out to the end of the
            // document every time the cursor moves. Off-screen grids keep their space
            // through tags, but are only positioned when scrolled into view.
            const visible = block.collapsed && block.end >= first && block.start <= last;
            if (visible && !block.widget) this.build(block);
            block.widget?.set_visible(visible);
            if (!visible || block.end >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.end));
            const y = lineY + lineHeight - block.height - GAP;
            // Only move if changed, so as not to trigger repeated resizes.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.widget!, x, y);
        }
    }
}
