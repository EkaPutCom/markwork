// The editor commands as text → edit: bold and the other markers, links, blocks, line prefixes, headings, Enter and Tab in
// lists and quotes, and the table commands. Each takes the text and the selection and returns the changes to make and the
// selection after them; an editor (CodeMirror) only reads its text and applies the result, so every
// frontend edits the same way. Offsets are UTF-16 units of the given text, the unit of JavaScript strings; an editor that
// counts otherwise converts at its edge.

import { RE } from './syntax.js';
import {
    cellIndexAt, cellStart, deleteColumn, deleteRow, findTables, insertColumn, insertRow,
    parseTable, renderRow, renderTable, setAlign, splitRow, type Align, type Table, type TableRange,
} from './table.js';

// The text a command reads and its selection: anchor is where the selection started, head is the cursor. Without a
// selection the two are equal. The text may be the whole document or a part of it (the lines around the selection);
// the offsets of the result are then relative to that part too.
export interface TextState {
    readonly text: string;
    readonly anchor: number;
    readonly head: number;
}

// Replace from..to of the original text with insert. The changes of one edit are sorted and do not overlap, and their
// offsets all refer to the text before the edit.
export interface TextChange {
    readonly from: number;
    readonly to: number;
    readonly insert: string;
}

export interface Selection {
    readonly anchor: number;
    readonly head: number;
}

// What a command does: the changes, then the selection in the text after them. No changes = only the selection moves
// (or nothing does).
export interface TextEdit {
    readonly changes: readonly TextChange[];
    readonly selection: Selection;
}

// ---------- Applying an edit ----------

export function applyChanges(text: string, changes: readonly TextChange[]): string {
    let out = '', at = 0;
    for (const c of changes) {
        out += text.slice(at, c.from) + c.insert;
        at = c.to;
    }
    return out + text.slice(at);
}

// Where a position of the text before the changes ends up after them. A position inside a replaced range, or at an
// insertion, moves to the end of the inserted text, the way a text editor moves its cursor.
export function mapPosition(pos: number, changes: readonly TextChange[]): number {
    let shift = 0;
    for (const c of changes) {
        if (pos < c.from) break;
        if (pos <= c.to) return c.from + shift + c.insert.length;
        shift += c.insert.length - (c.to - c.from);
    }
    return pos + shift;
}

const cursorAt = (pos: number): Selection => ({ anchor: pos, head: pos });

// The changes with the selection carried along by them.
function withSelection(state: TextState, changes: readonly TextChange[]): TextEdit {
    return { changes, selection: { anchor: mapPosition(state.anchor, changes), head: mapPosition(state.head, changes) } };
}

// Handled, but nothing changes.
export const unchanged = (state: TextState): TextEdit => ({ changes: [], selection: { anchor: state.anchor, head: state.head } });

// ---------- Lines ----------

const lineStart = (text: string, pos: number): number => pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;

function lineEnd(text: string, pos: number): number {
    const i = text.indexOf('\n', pos);
    return i < 0 ? text.length : i;
}

// The line around pos: its text and where it starts and ends (before its newline).
function lineAround(text: string, pos: number): { line: string; start: number; end: number } {
    const start = lineStart(text, pos), end = lineEnd(text, pos);
    return { line: text.slice(start, end), start, end };
}

// Offset of the start of line n (0-based); past the last line: the end of the text.
function offsetOfLine(text: string, n: number): number {
    let at = 0;
    for (let i = 0; i < n; i++) {
        const next = text.indexOf('\n', at);
        if (next < 0) return text.length;
        at = next + 1;
    }
    return at;
}

function lineNumberAt(text: string, pos: number): number {
    let n = 0;
    for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
    return n;
}

// ---------- Formatting ----------

// Wrap the selection with a marker, e.g. ** for bold. If the selection is already wrapped, the marker is removed.
// Without a selection: insert a pair of markers and put the cursor in between. The selected text stays selected, with
// the cursor at its start; the selection is never empty in between (on X11 an empty one would clear the primary selection).
export function wrap(state: TextState, left: string, right = left): TextEdit {
    const from = Math.min(state.anchor, state.head), to = Math.max(state.anchor, state.head);
    if (from === to) return { changes: [{ from, to, insert: left + right }], selection: cursorAt(from + left.length) };
    const txt = state.text.slice(from, to);
    if (txt.length >= left.length + right.length && txt.startsWith(left) && txt.endsWith(right)) {
        return {
            changes: [{ from, to: from + left.length, insert: '' }, { from: to - right.length, to, insert: '' }],
            selection: { anchor: to - left.length - right.length, head: from },
        };
    }
    return {
        changes: [{ from, to: from, insert: left }, { from: to, to, insert: right }],
        selection: { anchor: to + left.length + right.length, head: from },
    };
}

// Selected text → [text](), selected URL → [](url). The cursor is placed in the empty part.
export function link(state: TextState): TextEdit {
    const from = Math.min(state.anchor, state.head), to = Math.max(state.anchor, state.head);
    if (from === to) return { changes: [{ from, to, insert: '[]()' }], selection: cursorAt(from + 1) };
    const txt = state.text.slice(from, to);
    const isUrl = /^(https?:|mailto:)/.test(txt);
    const insert = isUrl ? `[](${txt})` : `[${txt}]()`;
    return { changes: [{ from, to, insert }], selection: cursorAt(isUrl ? from + 1 : from + insert.length - 1) };
}

// Insert a block (code block, table) at the cursor and put the cursor between before and after. On a line that has
// text, a blank line comes first.
export function block(state: TextState, before: string, after: string): TextEdit {
    const lead = lineAround(state.text, state.head).line.trim() ? '\n\n' : '';
    return {
        changes: [{ from: state.head, to: state.head, insert: lead + before + after }],
        selection: cursorAt(state.head + lead.length + before.length),
    };
}

// Add/remove a line prefix ("> ", "- ", "1. ") on all selected lines. If all lines already have the prefix, the prefix
// is removed. "1. " numbers the lines.
export function togglePrefix(state: TextState, pattern: RegExp, prefix: string): TextEdit {
    const from = Math.min(state.anchor, state.head), to = Math.max(state.anchor, state.head);
    const start = lineStart(state.text, from);
    const lines = state.text.slice(start, lineEnd(state.text, to)).split('\n');
    const remove = lines.every(l => pattern.test(l));
    const changes: TextChange[] = [];
    let at = start;
    lines.forEach((line, i) => {
        if (remove) changes.push({ from: at, to: at + pattern.exec(line)![0].length, insert: '' });
        else changes.push({ from: at, to: at, insert: prefix === '1. ' ? `${i + 1}. ` : prefix });
        at += line.length + 1;
    });
    return withSelection(state, changes);
}

// Make the selected lines a level 1–6 heading, whatever they were; level 0 or the same level = plain paragraph.
export function heading(state: TextState, level: number): TextEdit {
    return setLineKind(state, level > 0 ? `h${Math.min(level, 6)}` as LineKind : 'paragraph');
}

// What a line is, for the visual editor's style menu and its / menu: a paragraph, a heading, a quote, or a list item.
export type LineKind = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'quote' | 'bullet' | 'numbered' | 'task';

// The kind of a line, the length of the prefix that makes it that kind, and the indent a list item keeps.
export function lineKindOf(line: string): { kind: LineKind; prefix: number; indent: string } {
    const h = RE.heading.exec(line);
    if (h) return { kind: `h${h[1].length}` as LineKind, prefix: h[0].length, indent: '' };
    const q = RE.quote.exec(line);
    if (q) return { kind: 'quote', prefix: q[0].length, indent: '' };
    const l = RE.list.exec(line);
    if (l) return { kind: l[4] ? 'task' : /\d/.test(l[2]) ? 'numbered' : 'bullet', prefix: l[0].length, indent: l[1] };
    return { kind: 'paragraph', prefix: 0, indent: '' };
}

// Make every selected line one kind, replacing the prefix it has ("- " becomes "1. ", not "1. - "). When all of them
// are that kind already, they become paragraphs. A list item keeps its indent; a numbered list counts from 1.
export function setLineKind(state: TextState, kind: LineKind): TextEdit {
    const from = Math.min(state.anchor, state.head), to = Math.max(state.anchor, state.head);
    const start = lineStart(state.text, from);
    const lines = state.text.slice(start, lineEnd(state.text, to)).split('\n');
    const now = lines.map(lineKindOf);
    const target = now.every(k => k.kind === kind) ? 'paragraph' : kind;
    const changes: TextChange[] = [];
    let at = start;
    lines.forEach((line, i) => {
        const { prefix, indent } = now[i];
        const insert = target === 'paragraph' ? '' : target === 'quote' ? '> '
            : target.startsWith('h') ? `${'#'.repeat(Number(target[1]))} `
            : indent + (target === 'numbered' ? `${i + 1}. ` : target === 'task' ? '- [ ] ' : '- ');
        if (line.slice(0, prefix) !== insert) changes.push({ from: at, to: at + prefix, insert });
        at += line.length + 1;
    });
    return withSelection(state, changes);
}

// ---------- Lists and quotes ----------

// Is line lineNo inside a ``` code block?
export function isInCodeBlock(lines: readonly string[], lineNo: number): boolean {
    let open: string | null = null;
    for (let i = 0; i < lineNo && i < lines.length; i++) {
        const m = RE.fence.exec(lines[i]);
        if (!m) continue;
        if (!open) open = m[2][0];
        else if (m[2][0] === open && !m[3].trim()) open = null;
    }
    return open !== null;
}

// The prefix the next item of a list line continues with: "9. a" → "10. ", "- [x] a" → "- [ ] ".
function nextItemPrefix(quote: string, item: RegExpExecArray): string {
    const num = parseInt(item[2]);
    const marker = isNaN(num) ? item[2] : `${num + 1}${item[2].slice(-1)}`;
    return `${quote}${item[1]}${marker}${item[3] || ' '}${item[4] ? '[ ] ' : ''}`;
}

// Enter on a list/quote line; null if the line is neither:
//   "- one"   → new line "- "
//   "9. a"     → new line "10. "
//   "- [x] a"  → new line "- [ ] "
//   "> a"      → new line "> "
//   empty item ("- " or "> ") → its prefix is removed, the list/quote ends
export function continueBlock(state: TextState): TextEdit | null {
    const { line, start, end } = lineAround(state.text, state.head);
    const quote = /^(?:[ \t]*>[ \t]?)*/.exec(line)![0];
    const rest = line.slice(quote.length);
    const item = RE.list.exec(rest);
    if (item && !rest.slice(item[0].length).trim()) {
        return withSelection(state, [{ from: start, to: end, insert: quote.replace(/[ \t]*>[ \t]?$/, '') }]);
    }
    if (!item && quote && !rest.trim()) return withSelection(state, [{ from: start, to: end, insert: '' }]);
    if (!item && !quote) return null;
    const prefix = item ? nextItemPrefix(quote, item) : quote.endsWith(' ') ? quote : `${quote} `;
    return withSelection(state, [{ from: state.head, to: state.head, insert: `\n${prefix}` }]);
}

// Tab / Shift+Tab on a list line: increase or decrease the indentation by 4 spaces; null if not a list line.
export function indentListItem(state: TextState, outdent: boolean): TextEdit | null {
    const { line, start } = lineAround(state.text, state.head);
    if (!RE.list.test(line.replace(/^(?:[ \t]*>[ \t]?)+/, ''))) return null;
    if (!outdent) return withSelection(state, [{ from: start, to: start, insert: '    ' }]);
    const indent = /^( {1,4}|\t)/.exec(line);
    return indent ? withSelection(state, [{ from: start, to: start + indent[0].length, insert: '' }]) : unchanged(state);
}

// ---------- Tables ----------
//
// The table commands read the whole document (a table is found from its first line), so they take the whole text.

export type TableCommand =
    | 'row-below' | 'row-above' | 'col-right' | 'col-left' | 'delete-row' | 'delete-col'
    | 'align-left' | 'align-center' | 'align-right' | 'format';

// Why a table command could not run; the frontend words it.
export type TableFailure = 'not-in-table' | 'row-above-header' | 'delete-header' | 'delete-last-column';

export type TableResult = { ok: true; edit: TextEdit } | { ok: false; reason: TableFailure };

// Cursor position inside a table. Rows are counted "logically": 0 = header (the separator row is considered part of
// the header), 1 = first body row, etc.
interface Where {
    table: TableRange;
    lines: string[];
    row: number;
    col: number;
    columns: number;
}

const lineOfRow = (table: TableRange, row: number): number => table.start + (row === 0 ? 0 : row + 1);
const lastRow = (table: TableRange): number => table.end - table.start - 1;

function whereIsCursor(state: TextState): Where | null {
    const lines = state.text.split('\n');
    const line = lineNumberAt(state.text, state.head);
    const table = findTables(lines).find(t => line >= t.start && line <= t.end);
    if (!table) return null;
    const columns = splitRow(lines[table.start]).length;
    return {
        table, lines, columns,
        row: line <= table.start + 1 ? 0 : line - table.start - 1,
        col: Math.min(cellIndexAt(lines[line], state.head - lineStart(state.text, state.head)), columns - 1),
    };
}

// The changes, then the cursor at the start of the contents of cell col on line `line` of the text after them. A row
// with fewer cells: the end of the row.
function toCell(state: TextState, changes: readonly TextChange[], line: number, col: number): TextEdit {
    const text = applyChanges(state.text, changes);
    const start = offsetOfLine(text, line);
    return { changes, selection: cursorAt(start + cellStart(text.slice(start, lineEnd(text, start)), col)) };
}

// Replace lines start..end with newLines.
function replaceLines(text: string, start: number, end: number, newLines: readonly string[]): TextChange {
    return { from: offsetOfLine(text, start), to: lineEnd(text, offsetOfLine(text, end)), insert: newLines.join('\n') };
}

// One blank row below the table's last row.
function appendRow(text: string, table: TableRange, columns: number): TextChange {
    const at = lineEnd(text, offsetOfLine(text, table.end));
    return { from: at, to: at, insert: `\n${renderRow(Array<string>(columns).fill(''))}` };
}

// Tab / Shift+Tab: move to the next / previous cell. In the last cell, Tab adds a new row. null if the cursor is not in
// a table (the key is not handled).
export function tabInTable(state: TextState, backward: boolean): TextEdit | null {
    const at = whereIsCursor(state);
    if (!at) return null;
    const { table, row, col, columns } = at;
    let toRow = row, toCol = col;
    if (!backward) {
        if (col + 1 < columns) toCol = col + 1;
        else { toRow = row + 1; toCol = 0; }
    } else if (col > 0) {
        toCol = col - 1;
    } else if (row > 0) {
        toRow = row - 1;
        toCol = columns - 1;
    } else {
        return unchanged(state);  // first cell: there is nothing before it
    }
    const changes = toRow > lastRow(table) ? [appendRow(state.text, table, columns)] : [];
    return toCell(state, changes, lineOfRow(table, toRow), toCol);
}

// Enter: move to the same cell in the next row (a new row if already on the last row). On an empty last body row,
// Enter deletes that row and leaves the table, like Enter on an empty list item. null if not in a table.
export function enterInTable(state: TextState): TextEdit | null {
    const at = whereIsCursor(state);
    if (!at) return null;
    const { table, lines, row, col, columns } = at;
    if (row > 0 && row === lastRow(table) && splitRow(lines[table.end]).every(c => c.text === '')) {
        const below = lines[table.end + 1];
        // A blank line below the table already: delete the row with its line break, and the cursor moves to that line.
        const change = below !== undefined && below.trim() === ''
            ? { from: offsetOfLine(state.text, table.end) - 1, to: lineEnd(state.text, offsetOfLine(state.text, table.end)), insert: '' }
            : replaceLines(state.text, table.end, table.end, ['']);   // leave a blank line as a separator
        return toCell(state, [change], table.end, 0);
    }
    const changes = row + 1 > lastRow(table) ? [appendRow(state.text, table, columns)] : [];
    return toCell(state, changes, lineOfRow(table, row + 1), col);
}

const ALIGN_OF: Partial<Record<TableCommand, Align>> = { 'align-left': 'left', 'align-center': 'center', 'align-right': 'right' };

interface Transformed {
    model: Table;
    row: number;
    col: number;
}

// The table after a command, and the cell the cursor goes to.
function transform(model: Table, command: TableCommand, at: Where): Transformed | TableFailure {
    const { row, col, columns } = at;
    const body = row - 1;   // index into model.rows; -1 = header
    switch (command) {
        case 'row-below': return { model: insertRow(model, body + 1), row: row + 1, col };
        case 'row-above': return row === 0 ? 'row-above-header' : { model: insertRow(model, body), row, col };
        case 'delete-row': {
            if (row === 0) return 'delete-header';
            const after = deleteRow(model, body);
            return { model: after, row: Math.min(row, after.rows.length), col };
        }
        case 'col-right': return { model: insertColumn(model, col + 1), row, col: col + 1 };
        case 'col-left': return { model: insertColumn(model, col), row, col };
        case 'delete-col':
            return columns <= 1 ? 'delete-last-column' : { model: deleteColumn(model, col), row, col: Math.min(col, columns - 2) };
        case 'format': return { model, row, col };
        default: return { model: setAlign(model, col, ALIGN_OF[command] ?? null), row, col };
    }
}

// Runs a command on the table at the cursor. The result is always a tidied table (column widths equalized), because
// adding or deleting columns changes their widths.
export function runTableCommand(state: TextState, command: TableCommand): TableResult {
    const at = whereIsCursor(state);
    if (!at) return { ok: false, reason: 'not-in-table' };
    const { table, lines } = at;
    const done = transform(parseTable(lines.slice(table.start, table.end + 1)), command, at);
    if (typeof done === 'string') return { ok: false, reason: done };
    const change = replaceLines(state.text, table.start, table.end, renderTable(done.model));
    const after = { start: table.start, end: table.start + done.model.rows.length + 1 };
    return { ok: true, edit: toCell(state, [change], lineOfRow(after, done.row), done.col) };
}
