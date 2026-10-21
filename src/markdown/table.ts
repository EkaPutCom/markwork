// Markdown tables (GFM): recognizing table blocks, splitting lines into cells, and
// table operations (add/delete rows and columns, align left/center/right,
// tidying up). Pure TypeScript, so it is easy to test.
//
// Table shape:
//
//   | Name  | Value |      ← header row
//   | :---- | ----: |      ← separator row; colons set the alignment
//   | one   |     1 |      ← body row (the edge pipes may be omitted)

import { RE, startsTable } from './syntax.js';

export type Align = 'left' | 'center' | 'right' | null;

// Line range of a table in the document (inclusive): header row … last body row.
export interface TableRange {
    start: number;
    end: number;
}

// Table contents. The number of columns is set by the header row, as in GFM: extra cells in
// body rows are dropped, missing cells are treated as empty.
export interface Table {
    header: string[];
    aligns: Align[];
    rows: string[][];
}

// ---------- Recognizing table blocks ----------

// Last body row of the table whose header is at line `start` (separator at start + 1).
// The table ends at a blank line, a line without a pipe, or the start of another block.
export function tableEnd(lines: string[], start: number): number {
    let end = start + 1;
    while (end + 1 < lines.length) {
        const line = lines[end + 1];
        if (!line.trim() || !line.includes('|') || RE.heading.test(line) || RE.fence.test(line)
            || RE.hr.test(line) || /^\s{0,3}>/.test(line)) break;
        end++;
    }
    return end;
}

// All tables in the document, excluding those inside code blocks.
export function findTables(lines: string[]): TableRange[] {
    const tables: TableRange[] = [];
    let fence: { ch: string; len: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
        const m = RE.fence.exec(lines[i]);
        if (fence) {
            if (m && m[2][0] === fence.ch && m[2].length >= fence.len && !m[3].trim()) fence = null;
            continue;
        }
        if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
            fence = { ch: m[2][0], len: m[2].length };
            continue;
        }
        if (startsTable(lines, i) && !RE.heading.test(lines[i])) {
            const end = tableEnd(lines, i);
            tables.push({ start: i, end });
            i = end;
        }
    }
    return tables;
}

// ---------- Splitting lines ----------

export interface CellSpan {
    text: string;    // cell contents without surrounding spaces; raw Markdown (\| stays)
    start: number;   // start position of the contents in the line (UTF-16); empty cell: a sensible cursor position
    end: number;
}

// Positions of pipes that are not part of \|.
function pipePositions(line: string): number[] {
    const pipes: number[] = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') i++;
        else if (line[i] === '|') pipes.push(i);
    }
    return pipes;
}

// Splits one table line into cells. Pipes at the start and end of the line are only delimiters,
// not empty cells: "| a | b |" and "a | b" both contain two cells.
export function splitRow(line: string): CellSpan[] {
    const pipes = pipePositions(line);
    const leading = pipes.length > 0 && line.slice(0, pipes[0]).trim() === '';
    const lastPipe = pipes[pipes.length - 1];
    const trailing = pipes.length > 0 && !(leading && pipes.length === 1) && line.slice(lastPipe + 1).trim() === '';

    // Boundaries between cells; -1 and line.length are virtual boundaries if there are no edge pipes.
    const bounds = [...(leading ? [] : [-1]), ...pipes, ...(trailing ? [] : [line.length])];
    const cells: CellSpan[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
        const from = bounds[k] + 1, to = bounds[k + 1];
        const raw = line.slice(from, to);
        const text = raw.trim();
        if (text) {
            const start = from + raw.length - raw.trimStart().length;
            cells.push({ text, start, end: start + text.length });
        } else {
            const at = Math.min(from + (raw.startsWith(' ') ? 1 : 0), to);  // after "| "
            cells.push({ text: '', start: at, end: at });
        }
    }
    return cells;
}

// The column (from 0) containing position `offset` (UTF-16) in a table line.
export function cellIndexAt(line: string, offset: number): number {
    const pipes = pipePositions(line);
    const leading = pipes.length > 0 && line.slice(0, pipes[0]).trim() === '';
    const before = pipes.filter(p => p < offset).length;
    return Math.max(0, before - (leading ? 1 : 0));
}

// Cursor position (UTF-16) at the start of the contents of cell `col`; at the end of the line if that cell does not exist.
export function cellStart(line: string, col: number): number {
    const cells = splitRow(line);
    return cells[col]?.start ?? line.trimEnd().length;
}

// The text of a cell as it is written in a line: a pipe that is not already escaped becomes \|, and a line break a space.
export const escapeCell = (text: string): string => text.replace(/\r?\n/g, ' ').replace(/(\\.)|\|/g, (m, escaped) => escaped ?? '\\|');

// The change that makes cell `col` of a table line hold `text`, as a range of the line (UTF-16) and what replaces it; the
// rest of the line, spaces and other cells, stays as it was. A column the line does not have gives null.
export function setCellText(line: string, col: number, text: string): { from: number; to: number; insert: string } | null {
    const cell = splitRow(line)[col];
    return cell ? { from: cell.start, to: cell.end, insert: escapeCell(text) } : null;
}

// ---------- Reading and writing ----------

const alignOf = (cell: string): Align => {
    const left = cell.startsWith(':'), right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
};

const fitCells = (cells: string[], n: number): string[] =>
    Array.from({ length: n }, (_, i) => cells[i] ?? '');

// lines: header row, separator row, then body rows.
export function parseTable(lines: string[]): Table {
    const header = splitRow(lines[0]).map(c => c.text);
    const n = header.length;
    const separators = splitRow(lines[1]);
    const aligns = Array.from({ length: n }, (_, c) => alignOf(separators[c]?.text ?? ''));
    const rows = lines.slice(2).map(line => fitCells(splitRow(line).map(c => c.text), n));
    return { header, aligns, rows };
}

// Display width of text in monospace columns: CJK letters and emoji take two columns,
// joiners and emoji modifiers take zero columns.
const WIDE: [number, number][] = [
    [0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
    [0xA000, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE30, 0xFE6F], [0xFF00, 0xFF60],
    [0xFFE0, 0xFFE6], [0x1F300, 0x1F64F], [0x1F680, 0x1F6FF], [0x1F900, 0x1F9FF], [0x20000, 0x3FFFD],
];
const ZERO: [number, number][] = [
    [0x0300, 0x036F], [0x200B, 0x200F], [0x20D0, 0x20FF], [0xFE00, 0xFE0F], [0x1F3FB, 0x1F3FF],
];
const within = (ranges: [number, number][], cp: number) => ranges.some(([a, b]) => cp >= a && cp <= b);

export function displayWidth(text: string): number {
    let width = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        width += within(ZERO, cp) ? 0 : within(WIDE, cp) ? 2 : 1;
    }
    return width;
}

function fit(text: string, width: number, align: Align): string {
    const gap = width - displayWidth(text);
    if (gap <= 0) return text;
    if (align === 'right') return ' '.repeat(gap) + text;
    if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2));
    return text + ' '.repeat(gap);
}

function separator(width: number, align: Align): string {
    if (align === 'center') return `:${'-'.repeat(width - 2)}:`;
    if (align === 'left') return `:${'-'.repeat(width - 1)}`;
    if (align === 'right') return `${'-'.repeat(width - 1)}:`;
    return '-'.repeat(width);
}

// Writes a table as Markdown lines with tidy columns (equal column widths).
export function renderTable(table: Table): string[] {
    const n = table.header.length;
    const widths = Array.from({ length: n }, (_, c) =>
        Math.max(3, displayWidth(table.header[c]), ...table.rows.map(r => displayWidth(r[c]))));
    const row = (cells: string[]) => `| ${cells.map((t, c) => fit(t, widths[c], table.aligns[c])).join(' | ')} |`;
    return [
        row(table.header),
        `| ${widths.map((w, c) => separator(w, table.aligns[c])).join(' | ')} |`,
        ...table.rows.map(row),
    ];
}

// One line only, without tidying the columns (for new rows inserted while typing).
export const renderRow = (cells: string[]): string => `| ${cells.join(' | ')} |`;

// ---------- Operations ----------
// All operations return a new table; the original table is not changed.

// Insert a blank row before rows[at] (at = rows.length: at the end).
export function insertRow(table: Table, at: number): Table {
    const rows = [...table.rows];
    rows.splice(at, 0, table.header.map(() => ''));
    return { ...table, rows };
}

export function deleteRow(table: Table, at: number): Table {
    return { ...table, rows: table.rows.filter((_, i) => i !== at) };
}

// Insert a blank column before column `at` (at = number of columns: at the far right).
export function insertColumn(table: Table, at: number): Table {
    const put = <T>(cells: T[], value: T) => [...cells.slice(0, at), value, ...cells.slice(at)];
    return {
        header: put(table.header, ''),
        aligns: put<Align>(table.aligns, null),
        rows: table.rows.map(r => put(r, '')),
    };
}

// The last column cannot be deleted: a table without columns is not a table.
export function deleteColumn(table: Table, at: number): Table {
    if (table.header.length <= 1) return table;
    const drop = <T>(cells: T[]) => cells.filter((_, i) => i !== at);
    return { header: drop(table.header), aligns: drop(table.aligns), rows: table.rows.map(drop) };
}

export function setAlign(table: Table, col: number, align: Align): Table {
    return { ...table, aligns: table.aligns.map((a, c) => (c === col ? align : a)) };
}

// ---------- Drawing a table as a grid ----------

const MIN_COLUMN = 56;  // smallest column width (pixels) when the table has to be narrowed

// Column widths so that they fit in `available`. Columns that are already narrow are left alone,
// the remaining space is divided evenly among the wide columns (their text wraps onto the next line).
export function fitColumns(natural: number[], available: number): number[] {
    const widths = [...natural];
    if (natural.reduce((a, b) => a + b, 0) <= available) return widths;

    let remaining = available;
    let open = natural.map((_, i) => i);
    for (let changed = true; changed && open.length;) {
        changed = false;
        const share = remaining / open.length;
        for (const i of [...open]) {
            if (natural[i] > share) continue;
            remaining -= natural[i];
            open = open.filter(j => j !== i);
            changed = true;
        }
    }
    for (const i of open) widths[i] = Math.max(MIN_COLUMN, Math.floor(remaining / open.length));
    return widths;
}
