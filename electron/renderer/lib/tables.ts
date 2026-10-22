// A table as a grid, while the cursor is elsewhere. The rows of the table are
// replaced by an HTML table drawn from markdown/table.ts; with the cursor in the table the raw text is back for editing
// (Tab moves between cells, see markdown/editcommands.ts). A click on a cell puts the cursor in that cell of the raw text.
//
// In the visual editor the grid stays, and its cells are edited where they are: a cell holds its formatted text, and the
// one that is being edited holds its Markdown in a box. What is typed changes that one cell of the text, so the document
// is always what the grid shows (autosave, undo, and the toolbar's row and column buttons work on it as on any text).

import { WidgetType, type EditorView } from '@codemirror/view';
import { cellHtml } from '../../../src/markdown/inlinehtml.js';
import { runTableCommand } from '../../../src/markdown/editcommands.js';
import { cellIndexAt, cellStart, escapeCell, parseTable, setCellText, type Table } from '../../../src/markdown/table.js';

interface CellPlace { row: number; col: number; offset: number }

// The cell that had the focus in a grid that is drawn again, so the new one can give it the focus back (a row added
// from the toolbar, a column deleted): set when the old grid cannot be patched, used by the next one, gone after.
let pending: CellPlace | null = null;
const keep = (cell: CellPlace): void => {
    pending = cell;
    setTimeout(() => { if (pending === cell) pending = null; }, 0);
};

// The widgets by the grid element they drew, so an event handler always reads the latest text.
const drawn = new WeakMap<HTMLElement, TableWidget>();

const cellOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('[data-row]') ?? null;
const rowOf = (cell: HTMLElement) => Number(cell.dataset.row);
const colOf = (cell: HTMLElement) => Number(cell.dataset.col);
const cellsIn = (wrap: HTMLElement) => [...wrap.querySelectorAll<HTMLElement>('[data-row]')];

// The box a cell holds while it is edited: its text is the cell's Markdown. (A box, not an editable element: the editor
// takes the focus back from a contenteditable inside its own.)
const inputOf = (cell: HTMLElement): HTMLInputElement | null => cell.querySelector('input');

// Where the caret is in a cell, in UTF-16 units of its text.
const caretIn = (cell: HTMLElement): number => inputOf(cell)?.selectionStart ?? 0;

const textIn = (cell: HTMLElement): string => inputOf(cell)?.value ?? '';

function setCaret(input: HTMLInputElement, offset: number): void {
    const at = Math.min(Math.max(offset, 0), input.value.length);
    input.setSelectionRange(at, at);
}

export class TableWidget extends WidgetType {
    private readonly key: string;

    constructor(readonly lines: readonly string[], readonly table: Table, private readonly dim = false, private readonly editable = false) {
        super();
        this.key = lines.join('\n') + (dim ? '\0dim' : '') + (editable ? '\0edit' : '');
    }

    override eq(other: TableWidget): boolean { return other.key === this.key; }

    raw(row: number, col: number): string { return row < 0 ? this.table.header[col] : this.table.rows[row][col]; }

    // A cell shows its formatted text.
    private fill(cell: HTMLElement): void {
        const row = rowOf(cell), col = colOf(cell);
        cell.innerHTML = cellHtml(this.raw(row, col));
        cell.style.textAlign = this.table.aligns[col] ?? '';
        delete cell.dataset.raw;
    }

    // A cell opens: its Markdown in a box that has the focus, with the caret at `offset`.
    open(cell: HTMLElement, offset: number): void {
        let input = inputOf(cell);
        if (!input) {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'cm-md-cell-input';
            input.spellcheck = false;
            input.setAttribute('aria-label', rowOf(cell) < 0 ? `Heading of column ${colOf(cell) + 1}` : `Row ${rowOf(cell) + 1}, column ${colOf(cell) + 1}`);
            input.value = this.raw(rowOf(cell), colOf(cell));
            cell.replaceChildren(input);
            cell.dataset.raw = '1';
        }
        input.focus();
        setCaret(input, offset);
    }

    override toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'cm-md-table-grid' + (this.dim ? ' cm-md-dim' : '') + (this.editable ? ' editable' : '');
        drawn.set(wrap, this);
        const grid = document.createElement('table');
        const cell = (tag: 'th' | 'td', col: number, row: number) => {
            const el = document.createElement(tag);
            el.dataset.row = String(row);
            el.dataset.col = String(col);
            this.fill(el);
            return el;
        };
        const head = grid.createTHead().insertRow();
        this.table.header.forEach((_, c) => head.append(cell('th', c, -1)));
        const body = grid.createTBody();
        this.table.rows.forEach((cells, r) => {
            const tr = body.insertRow();
            cells.forEach((_, c) => tr.append(cell('td', c, r)));
        });
        wrap.append(grid);
        if (this.editable) this.edit(wrap, view); else this.clickToOpen(wrap, view);
        const give = pending;
        if (give) { pending = null; requestAnimationFrame(() => focusCell(wrap, give)); }
        return wrap;
    }

    // The editor's grid: a click puts the cursor in that cell of the raw text, and the grid goes away for it.
    private clickToOpen(wrap: HTMLElement, view: EditorView): void {
        wrap.addEventListener('mousedown', event => {
            const target = cellOf(event.target as Element);
            if (!target || (event.target as HTMLElement).closest('a') && (event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            const { doc } = view.state;
            const first = doc.lineAt(view.posAtDOM(wrap)).number;
            const row = rowOf(target), col = colOf(target);
            const line = doc.line(Math.min(doc.lines, first + (row < 0 ? 0 : row + 2)));
            view.dispatch({ selection: { anchor: line.from + cellStart(line.text, col) }, scrollIntoView: true });
            view.focus();
        });
    }

    // The visual editor's grid: the cells are edited in place.
    private edit(wrap: HTMLElement, view: EditorView): void {
        const here = () => drawn.get(wrap)!;
        // The line of the text a cell is in, and the table's first and last line (from 1).
        const firstLine = () => view.state.doc.lineAt(view.posAtDOM(wrap)).number;
        const lineOf = (cell: HTMLElement) => view.state.doc.line(Math.min(view.state.doc.lines, firstLine() + (rowOf(cell) < 0 ? 0 : rowOf(cell) + 2)));
        const openCell = (cell: HTMLElement, offset = here().raw(rowOf(cell), colOf(cell)).length) => here().open(cell, offset);
        // The text's cursor goes where the caret is in the cell, so the toolbar and the commands act there.
        const place = (cell: HTMLElement) => {
            const line = lineOf(cell), at = line.from + cellStart(line.text, colOf(cell)) + caretIn(cell);
            const { main } = view.state.selection;
            if (!main.empty || main.head !== at) view.dispatch({ selection: { anchor: at } });
        };
        // What was typed in a cell is written into the text: that cell only.
        const commit = (cell: HTMLElement) => {
            const input = inputOf(cell);
            if (!input) return;
            const line = lineOf(cell), typed = input.value, caret = caretIn(cell);
            // A pipe is escaped on its way into the text, so the box says what the text says.
            const escaped = escapeCell(typed);
            if (escaped !== typed) { input.value = escaped; setCaret(input, caret + escaped.length - typed.length); }
            // The text of a cell has no space around it, but the box keeps the ones just typed, or a word could not be followed by another.
            const change = setCellText(line.text, colOf(cell), escaped.trim());
            if (!change || change.insert === here().raw(rowOf(cell), colOf(cell))) return;
            const from = line.from + change.from;
            view.dispatch({ changes: { from, to: line.from + change.to, insert: change.insert }, selection: { anchor: from + Math.min(caretIn(cell), change.insert.length) }, userEvent: 'input.type' });
        };
        // Add a row below the last one (the toolbar's command), and go to its first cell.
        const addRow = (cell: HTMLElement) => {
            place(cell);
            const { main } = view.state.selection;
            const result = runTableCommand({ text: view.state.doc.toString(), anchor: main.anchor, head: main.head }, 'row-below');
            if (!result.ok) return;
            keep({ row: here().table.rows.length, col: 0, offset: 0 });
            view.dispatch({
                changes: result.edit.changes.map(c => ({ from: c.from, to: c.to, insert: c.insert })),
                selection: { anchor: result.edit.selection.anchor, head: result.edit.selection.head }, userEvent: 'input',
            });
        };
        // Leave the grid for the text above or below it.
        const leave = (below: boolean) => {
            const first = firstLine();
            const target = below ? first + here().table.rows.length + 2 : first - 1;
            if (target < 1 || target > view.state.doc.lines) return;
            const line = view.state.doc.line(target);
            view.dispatch({ selection: { anchor: below ? line.from : line.to }, scrollIntoView: true });
            view.focus();
        };
        // Go to another cell: `rows` and `cols` away. Past the last cell Tab adds a row; past the first or last row an arrow leaves.
        const step = (cell: HTMLElement, rows: number, cols: number) => {
            const all = cellsIn(wrap);
            const next = all[all.indexOf(cell) + rows * here().table.header.length + cols];
            if (next) openCell(next);
            else if (rows > 0 || cols > 0) addRow(cell);
            else leave(false);
        };

        // A click opens the cell it is on; one on the box that is open is the box's own (the caret goes there).
        wrap.addEventListener('mousedown', event => {
            const target = event.target as Element, cell = cellOf(target);
            if (!cell || target.closest('input') || target.closest('a') && (event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            openCell(cell);
        });
        wrap.addEventListener('focusin', event => { const cell = cellOf(event.target as Element); if (cell && inputOf(cell)) place(cell); });
        wrap.addEventListener('focusout', event => {
            const cell = cellOf(event.target as Element);
            if (cell?.isConnected && inputOf(cell)) here().fill(cell);
        });
        wrap.addEventListener('input', event => {
            const cell = cellOf(event.target as Element);
            if (cell && !(event as InputEvent).isComposing) commit(cell);
        });
        wrap.addEventListener('compositionend', event => { const cell = cellOf(event.target as Element); if (cell) commit(cell); });
        wrap.addEventListener('keyup', event => { const cell = cellOf(event.target as Element); if (cell && event.key.startsWith('Arrow')) place(cell); });
        wrap.addEventListener('mouseup', event => { const cell = cellOf(event.target as Element); if (cell && inputOf(cell)) place(cell); });
        wrap.addEventListener('keydown', event => {
            const cell = cellOf(event.target as Element);
            if (!cell || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
            const moves: Record<string, [number, number]> = { Tab: event.shiftKey ? [0, -1] : [0, 1], Enter: [1, 0], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
            const move = moves[event.key];
            // Enter on a last row that is empty leaves the grid instead of adding another row.
            const emptyLast = event.key === 'Enter' && rowOf(cell) === here().table.rows.length - 1 && cellsIn(wrap).filter(x => rowOf(x) === rowOf(cell)).every(x => !textIn(x));
            if (emptyLast) { event.preventDefault(); leave(true); }
            else if (move && !(event.key === 'Enter' && event.shiftKey)) { event.preventDefault(); step(cell, move[0], move[1]); }
            else if (event.key === 'Escape') { event.preventDefault(); leave(true); }
        });
    }

    // A change of the text that keeps the grid's shape is written into the grid it is in, so the cell being typed in keeps
    // its focus and its caret; a change of the shape draws the grid again, and its focus is handed on.
    override updateDOM(dom: HTMLElement, _view: EditorView, from: TableWidget): boolean {
        const same = this.editable && from.editable && from.table.header.length === this.table.header.length && from.table.rows.length === this.table.rows.length;
        const active = cellOf(document.activeElement);
        if (!same) {
            const box = active && dom.contains(active) ? inputOf(active) : null;
            // A place that was asked for (a row added with Tab) wins over the cell that had the focus.
            if (active && box && this.editable && !pending) keep({ row: rowOf(active), col: colOf(active), offset: box.selectionStart ?? 0 });
            return false;
        }
        drawn.set(dom, this);
        dom.classList.toggle('cm-md-dim', this.dim);
        for (const cell of cellsIn(dom)) {
            const box = inputOf(cell);
            if (cell === active && box) { if (box.value.trim() !== this.raw(rowOf(cell), colOf(cell))) box.value = this.raw(rowOf(cell), colOf(cell)); }
            else this.fill(cell);
        }
        return true;
    }

    override ignoreEvent(): boolean { return true; }
}

// Give the focus to a cell of a grid (row -1 is the header), with the caret at `offset` of its text.
export function focusCell(wrap: HTMLElement, place: CellPlace): void {
    const cells = cellsIn(wrap);
    // A row or column that is gone (just deleted) leaves the last cell.
    const cell = cells.find(c => rowOf(c) === place.row && colOf(c) === place.col) ?? cells.at(-1);
    if (cell) drawn.get(wrap)?.open(cell, place.offset);
}

// The grid that draws a table of the text, for the cursor that is in it: its element and the cell the cursor is in.
// `firstLine` is the table's header line (from 0), `line` the cursor's line (from 0) with its `text`, and `offset` the
// cursor's place in that line (UTF-16).
export function gridAt(view: EditorView, firstLine: number, line: number, text: string, offset: number): { wrap: HTMLElement; place: CellPlace } | null {
    const wrap = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table-grid.editable')]
        .find(w => view.state.doc.lineAt(view.posAtDOM(w)).number - 1 === firstLine);
    if (!wrap) return null;
    const rel = line - firstLine;
    return { wrap, place: { row: rel <= 1 ? -1 : rel - 2, col: cellIndexAt(text, offset), offset: 0 } };
}

export const tableOf = (lines: readonly string[]): Table => parseTable([...lines]);
