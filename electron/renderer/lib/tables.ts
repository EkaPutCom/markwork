// A table as a grid, while the cursor is elsewhere. The rows of the table are
// replaced by an HTML table drawn from markdown/table.ts; with the cursor in the table the raw text is back for editing
// (Tab moves between cells, see markdown/editcommands.ts). A click on a cell puts the cursor in that cell of the raw text.
//
// In the visual editor the grid stays, and its cells are edited where they are, as the text around the table is: each cell
// is an editable element that shows what the cell says (bold, code, links, without their markers), and a click puts the
// caret where it was. What is typed changes that one cell of the text, written into its Markdown at the place the visible
// text maps to, so the document is always what the grid shows (autosave, undo, and the toolbar's commands work on it as
// on any text: the cell's selection is the text's).

import { WidgetType, type EditorView } from '@codemirror/view';
import { parseInline } from '../../../src/markdown/inline.js';
import { runTableCommand } from '../../../src/markdown/editcommands.js';
import { cellIndexAt, cellStart, escapeCell, parseTable, setCellText, type Table } from '../../../src/markdown/table.js';
import { handling, trace } from './inspect/recorder.js';

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

// ---------- What a cell shows ----------

// The formats of a cell's letters, outermost first: the parser's tags, drawn with the classes the editor gives the same
// tags in the text around the table (editor.ts), so a cell looks as a line of text does.
const STYLES = ['bold', 'italic', 'bolditalic', 'strike', 'mark', 'link', 'image', 'code'] as const;

// The visible text of a cell's Markdown (the markers of its formats and escapes left out), and how the two map.
interface Shown {
    raw: string;
    visible: string;
    toRaw: number[];       // the place in the Markdown of each visible letter
    fromRaw: number[];     // how many visible letters stand before each place of the Markdown (one more than its length)
    styles: number[];      // the formats of each visible letter, as bits of STYLES
}

function showOf(raw: string): Shown {
    const hidden = new Uint8Array(raw.length), bits = new Uint8Array(raw.length);
    for (const [name, a, b] of parseInline(raw).tags) {
        const mask = name === 'marker' ? 0 : 1 << STYLES.indexOf(name);
        for (let i = a; i < b; i++) { if (name === 'marker') hidden[i] = 1; else bits[i] |= mask; }
    }
    const toRaw: number[] = [], fromRaw: number[] = [], styles: number[] = [];
    let visible = '';
    for (let i = 0; i < raw.length; i++) {
        fromRaw[i] = toRaw.length;
        if (hidden[i]) continue;
        toRaw.push(i);
        styles.push(bits[i]);
        visible += raw[i];
    }
    fromRaw[raw.length] = toRaw.length;
    return { raw, visible, toRaw, fromRaw, styles };
}

const shown = new WeakMap<HTMLElement, Shown>();

// Draw a cell's visible text with its formats.
function draw(cell: HTMLElement, raw: string): void {
    const s = showOf(raw);
    shown.set(cell, s);
    cell.replaceChildren();
    for (let i = 0; i < s.visible.length;) {
        let j = i + 1;
        while (j < s.visible.length && s.styles[j] === s.styles[i]) j++;
        let node: Node = document.createTextNode(s.visible.slice(i, j));
        for (let k = STYLES.length - 1; k >= 0; k--) {
            if (!(s.styles[i] & 1 << k)) continue;
            const el = document.createElement('span');
            el.className = `cm-md-${STYLES[k]}`;
            el.append(node);
            node = el;
        }
        cell.append(node);
        i = j;
    }
}

// The Markdown that was typed, from what the cell shows now: the letters that went and came replace the same stretch of
// the Markdown. Letters go with the markers between them; text typed right after a word takes its format.
function typed(s: Shown, now: string): { raw: string; caret: number } {
    const old = s.visible;
    let p = 0;
    while (p < old.length && p < now.length && old[p] === now[p]) p++;
    let q = 0;
    while (q < old.length - p && q < now.length - p && old[old.length - 1 - q] === now[now.length - 1 - q]) q++;
    const removed = old.length - p - q, added = now.slice(p, now.length - q).replace(/\r?\n/g, ' ');
    let raw = s.raw, from: number, to: number;
    if (removed > 0) { from = s.toRaw[p]; to = s.toRaw[p + removed - 1] + 1; }
    else from = to = p === 0 ? 0 : p >= old.length ? raw.length : s.toRaw[p - 1] + 1;
    raw = raw.slice(0, from) + added + raw.slice(to);
    // Markers left with nothing between them (** **, ``) go with the last letter.
    if (removed > 0 && !added) {
        for (let k = 3; k >= 1;) {
            const open = raw.slice(from - k, from);
            if (from - k >= 0 && /^([*_~=`])\1*$/.test(open) && raw.slice(from, from + k) === open) { raw = raw.slice(0, from - k) + raw.slice(from + k); from -= k; k = 3; } else k--;
        }
    }
    return { raw, caret: from + added.length };
}

// ---------- The selection in a cell ----------

// The visible offsets of the selection in a cell, [anchor, head]; null when it is not in the cell.
function visibleSelection(cell: HTMLElement): [number, number] | null {
    const sel = window.getSelection();
    if (!sel?.anchorNode || !sel.focusNode || !cell.contains(sel.anchorNode) || !cell.contains(sel.focusNode)) return null;
    const offset = (node: Node, at: number) => { const r = document.createRange(); r.selectNodeContents(cell); r.setEnd(node, at); return r.toString().length; };
    return [offset(sel.anchorNode, sel.anchorOffset), offset(sel.focusNode, sel.focusOffset)];
}

function setVisibleSelection(cell: HTMLElement, anchor: number, head: number): void {
    const point = (at: number): [Node, number] => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let last: Text | null = null;
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
            if (at <= node.length) return [node, at];
            at -= node.length;
            last = node;
        }
        return last ? [last, last.length] : [cell, 0];
    };
    const [an, ao] = point(anchor), [hn, ho] = point(head);
    window.getSelection()?.setBaseAndExtent(an, ao, hn, ho);
}

// The selection in a cell as places in its Markdown, [anchor, head]: a collapsed one before the letter it stands at, the
// ends of a range around the letters it holds.
function selectionIn(cell: HTMLElement): [number, number] {
    const s = shown.get(cell), sel = visibleSelection(cell);
    if (!s || !sel) return [0, 0];
    const [a, h] = sel, from = Math.min(a, h), to = Math.max(a, h);
    const start = from >= s.visible.length ? s.raw.length : s.toRaw[from];
    const end = to === from ? start : s.toRaw[to - 1] + 1;
    return a <= h ? [start, end] : [end, start];
}

// The visible offset of place `raw` of a cell's Markdown.
function visibleAt(cell: HTMLElement, raw: number): number {
    const s = shown.get(cell);
    return s ? s.fromRaw[Math.min(Math.max(raw, 0), s.raw.length)] : 0;
}

// Select places `anchor`–`head` of a cell's Markdown.
function selectIn(cell: HTMLElement, anchor: number, head: number): void {
    const s = shown.get(cell);
    if (!s) return;
    setVisibleSelection(cell, visibleAt(cell, anchor), visibleAt(cell, head));
}

const caretIn = (cell: HTMLElement): number => selectionIn(cell)[1];
const textIn = (cell: HTMLElement): string => shown.get(cell)?.raw ?? '';
const isEdited = (cell: HTMLElement): boolean => document.activeElement === cell;

// Where the selection of the cell that has the focus is on the screen, for a menu over it; null when no cell has it.
export function cellSelectionRect(): DOMRect | null {
    const cell = document.activeElement;
    if (!(cell instanceof HTMLElement) || !cell.classList.contains('cm-md-cell')) return null;
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    return rect.width || rect.height ? rect : cell.getBoundingClientRect();
}

// The grids that are edited, by their element: how to give a cell of one the text's selection again after a command
// (the toolbar's Bold) changed the text. `left` is the cell's selection the redraw left (visible offsets).
const selectors = new WeakMap<HTMLElement, (cell: HTMLElement, left: [number, number] | null) => void>();
// The cells waiting for that: until then the cell shows only a caret, and its selection is not the text's (a key let go
// right after Ctrl+B would otherwise make the text's selection that caret, and Ctrl+B again would add markers).
const settling = new WeakSet<HTMLElement>();
// The caret a redraw left in a cell (visible offsets), until the cell has the text's selection again. Past the frame of
// `settling` the cell can still hold it: a cell that lost the focus for that frame (its grid put back in place) skips
// taking the selection. A key let go or the focus coming back then must not make the text's selection that caret (a
// second Ctrl+B would bold nothing and leave ****): the cell takes the text's selection instead. A click or a key that
// moves the caret is the person's own place, and ends it.
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock']);
const placeholders = new WeakMap<HTMLElement, [number, number]>();

export class TableWidget extends WidgetType {
    private readonly key: string;

    constructor(readonly lines: readonly string[], readonly table: Table, private readonly dim = false, private readonly editable = false) {
        super();
        this.key = lines.join('\n') + (dim ? '\0dim' : '') + (editable ? '\0edit' : '');
    }

    override eq(other: TableWidget): boolean { return other.key === this.key; }

    raw(row: number, col: number): string { return row < 0 ? this.table.header[col] : this.table.rows[row][col]; }

    // A cell shows its formatted text, as the lines around the table do; in the visual editor it is edited where it is.
    private fill(cell: HTMLElement): void {
        const row = rowOf(cell), col = colOf(cell);
        draw(cell, this.raw(row, col));
        cell.style.textAlign = this.table.aligns[col] ?? '';
    }

    // A cell takes the focus, with the caret at place `offset` of its Markdown. The page moves only for a cell that is not
    // all in view (a row added below the last one shown).
    open(cell: HTMLElement, offset: number): void {
        cell.focus({ preventScroll: true });
        selectIn(cell, offset, offset);
        cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    override toDOM(view: EditorView): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'cm-md-table-grid' + (this.dim ? ' cm-md-dim' : '') + (this.editable ? ' editable' : '');
        wrap.contentEditable = 'false';   // each cell of the visual editor is an editing place of its own
        drawn.set(wrap, this);
        const grid = document.createElement('table');
        const cell = (tag: 'th' | 'td', col: number, row: number) => {
            const el = document.createElement(tag);
            el.dataset.row = String(row);
            el.dataset.col = String(col);
            if (this.editable) {
                el.className = 'cm-md-cell';
                el.contentEditable = 'plaintext-only';
                el.spellcheck = false;
                el.setAttribute('aria-label', row < 0 ? `Heading of column ${col + 1}` : `Row ${row + 1}, column ${col + 1}`);
            }
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
        const openCell = (cell: HTMLElement, offset?: number) => here().open(cell, offset ?? here().raw(rowOf(cell), colOf(cell)).length);
        // The text's selection follows the cell's, so the toolbar, the selection menu, and the commands act on it.
        const place = (cell: HTMLElement) => {
            if (!isEdited(cell) || settling.has(cell)) return;
            if (placeholders.has(cell)) {
                const held = placeholders.get(cell)!, now = visibleSelection(cell);
                if (!now || (now[0] === held[0] && now[1] === held[1])) { takeText(cell, held); return; }
                placeholders.delete(cell);
            }
            const line = lineOf(cell), start = line.from + cellStart(line.text, colOf(cell));
            const [anchor, head] = selectionIn(cell).map(at => start + at);
            const { main } = view.state.selection;
            // Marked, so the inspector's log tells the cell's own selection from the text's.
            if (main.anchor !== anchor || main.head !== head) view.dispatch({ selection: { anchor, head }, userEvent: 'select.cell' });
        };
        const takeText = (cell: HTMLElement, left: [number, number] | null) => {
            if (!cell.isConnected || !isEdited(cell)) return;
            placeholders.delete(cell);
            // A selection made in the cell since the redraw (a double-click right after Bold) is the one that counts: the
            // text takes it, rather than the cell taking back the text's older one.
            const now = visibleSelection(cell);
            if (now && (now[0] !== left?.[0] || now[1] !== left[1])) { place(cell); return; }
            const line = lineOf(cell), start = line.from + cellStart(line.text, colOf(cell)), { main } = view.state.selection;
            if (main.from >= start && main.to <= line.to) selectIn(cell, main.anchor - start, main.head - start);
        };
        selectors.set(wrap, takeText);
        // What was typed in a cell is written into the text: that cell only.
        const commit = (cell: HTMLElement) => {
            const before = shown.get(cell);
            if (!before) return;
            const line = lineOf(cell);
            const edit = typed(before, (cell.textContent ?? '').replace(/\u200b/g, ''));
            // A pipe is escaped on its way into the text.
            const escaped = escapeCell(edit.raw), caret = edit.caret + escaped.length - edit.raw.length;
            draw(cell, escaped);
            selectIn(cell, caret, caret);
            // The text of a cell has no space around it, but the cell keeps the ones just typed, or a word could not be followed by another.
            const change = setCellText(line.text, colOf(cell), escaped.trim());
            if (!change || change.insert === here().raw(rowOf(cell), colOf(cell))) return;
            const from = line.from + change.from;
            handling('table.cell-input', () => {
                trace(`row ${rowOf(cell)}, column ${colOf(cell)}: the cell's text is written as ${JSON.stringify(change.insert)}`);
                view.dispatch({ changes: { from, to: line.from + change.to, insert: change.insert }, selection: { anchor: from + Math.min(caret, change.insert.length) }, userEvent: 'input.type' });
            });
        };
        // Add a row below the last one (the toolbar's command), and go to its first cell.
        const addRow = (cell: HTMLElement) => {
            place(cell);
            const { main } = view.state.selection;
            const result = runTableCommand({ text: view.state.doc.toString(), anchor: main.anchor, head: main.head }, 'row-below');
            if (!result.ok) return;
            keep({ row: here().table.rows.length, col: 0, offset: 0 });
            // The grid is drawn again for its new row: the page stays where it is (CodeMirror's own correction for a
            // block that changed would move it), and the new cell shows itself when it takes the focus.
            view.dispatch({
                changes: result.edit.changes.map(c => ({ from: c.from, to: c.to, insert: c.insert })),
                selection: { anchor: result.edit.selection.anchor, head: result.edit.selection.head }, userEvent: 'input',
                effects: view.scrollSnapshot(),
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

        wrap.addEventListener('focusin', event => { const cell = cellOf(event.target as Element); if (cell) place(cell); });
        wrap.addEventListener('focusout', event => {
            const cell = cellOf(event.target as Element);
            if (cell?.isConnected) here().fill(cell);
        });
        // The cell's own history and line breaks stay out: undo is the text's, and a cell is one line.
        wrap.addEventListener('beforeinput', event => {
            if (/^(historyUndo|historyRedo|insertParagraph|insertLineBreak|format)/.test(event.inputType)) event.preventDefault();
        });
        wrap.addEventListener('input', event => {
            const cell = cellOf(event.target as Element);
            if (cell && !(event as InputEvent).isComposing) commit(cell);
        });
        wrap.addEventListener('compositionend', event => { const cell = cellOf(event.target as Element); if (cell) commit(cell); });
        wrap.addEventListener('keyup', event => { const cell = cellOf(event.target as Element); if (cell) place(cell); });
        wrap.addEventListener('mouseup', event => { const cell = cellOf(event.target as Element); if (cell) requestAnimationFrame(() => place(cell)); });
        // A click or a key of the person's own (not a shortcut, whose key let go must not move the text's selection) puts
        // the caret where they mean it.
        wrap.addEventListener('mousedown', event => { const cell = cellOf(event.target as Element); if (cell) placeholders.delete(cell); }, true);
        wrap.addEventListener('keydown', event => {
            const cell = cellOf(event.target as Element);
            if (cell && !event.ctrlKey && !event.metaKey && !event.altKey && !MODIFIER_KEYS.has(event.key)) placeholders.delete(cell);
        }, true);
        wrap.addEventListener('keydown', event => {
            const cell = cellOf(event.target as Element);
            if (!cell || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
            const moves: Record<string, [number, number]> = { Tab: event.shiftKey ? [0, -1] : [0, 1], Enter: [1, 0], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
            const move = moves[event.key];
            // Enter on a last row that is empty leaves the grid instead of adding another row.
            const emptyLast = event.key === 'Enter' && rowOf(cell) === here().table.rows.length - 1 && cellsIn(wrap).filter(x => rowOf(x) === rowOf(cell)).every(x => !textIn(x));
            if (emptyLast) { event.preventDefault(); handling('table.leave', () => { trace('Enter on an empty last row: leaves the grid'); leave(true); }); }
            else if (event.key === 'Enter' && event.shiftKey) event.preventDefault();
            else if (move) { event.preventDefault(); handling('table.step', () => step(cell, move[0], move[1])); }
            else if (event.key === 'Escape') { event.preventDefault(); handling('table.leave', () => leave(true)); }
        });
    }

    // A change of the text that keeps the grid's shape is written into the grid it is in, so the cell being typed in keeps
    // its focus and its caret; a change of the shape draws the grid again, and its focus is handed on.
    override updateDOM(dom: HTMLElement, _view: EditorView, from: TableWidget): boolean {
        const same = this.editable && from.editable && from.table.header.length === this.table.header.length && from.table.rows.length === this.table.rows.length;
        const active = cellOf(document.activeElement);
        if (!same) {
            // A place that was asked for (a row added with Tab) wins over the cell that had the focus.
            if (active && dom.contains(active) && isEdited(active) && this.editable && !pending) keep({ row: rowOf(active), col: colOf(active), offset: caretIn(active) });
            return false;
        }
        drawn.set(dom, this);
        dom.classList.toggle('cm-md-dim', this.dim);
        for (const cell of cellsIn(dom)) {
            if (cell !== active || !isEdited(cell)) { this.fill(cell); continue; }
            if (textIn(cell).trim() === this.raw(rowOf(cell), colOf(cell))) continue;
            // Changed from outside the cell (a command): it takes the text's selection once the update is done.
            const caret = caretIn(cell);
            this.fill(cell);
            selectIn(cell, caret, caret);
            const select = selectors.get(dom);
            if (!select) continue;
            // The caret just put there, from where it was put: read back from the page it can be missing (null), and
            // a missing one would make the caret pass for a selection the person made since.
            const at = visibleAt(cell, caret), left: [number, number] = [at, at];
            settling.add(cell);
            placeholders.set(cell, left);
            requestAnimationFrame(() => { settling.delete(cell); select(cell, left); });
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
