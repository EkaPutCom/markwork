// A CSV file as rows of cells, and the operations the CSV tab offers. Pure TypeScript.
//
// The file text stays the source of truth: parseCsv() reads it, the operations return a new table (the rows they leave
// alone are shared), and serializeCsv() writes it back. A row nobody touched is written exactly as it was read (its
// quoting, spacing, and extra cells), so saving after a one-cell edit changes one line in a diff, not the whole file.
// The delimiter, the line ending, the byte order mark, and whether the file ends with a line break are kept too.

import { replaceMatches } from './search';

export type Delimiter = ',' | ';' | '\t' | '|';

// One record. `raw` is its text as read, kept only while its cells are unchanged.
export interface CsvRow {
    readonly cells: readonly string[];
    readonly raw: string | null;
}

export interface CsvTable {
    readonly rows: readonly CsvRow[];   // rows[0] is the header; never empty
    readonly delimiter: Delimiter;
    readonly eol: '\n' | '\r\n';
    readonly finalEol: boolean;         // the file ends with a line break
    readonly bom: boolean;
}

// The most cells the table view takes (it keeps the whole table in memory and writes the whole text back on an edit); a
// bigger file is shown as text.
export const CSV_VIEW_CELLS = 1_000_000;

export const fitsTableView = (table: CsvTable): boolean => table.rows.length * columnCount(table) <= CSV_VIEW_CELLS;

export const CSV_EXTENSIONS = ['.csv'];
export const isCsvFile = (name: string | null): boolean => !!name && CSV_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext));

const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];
const BOM = '﻿';

// The text of a new file: a header to rename and one empty row to fill.
export function newCsvText(columns: readonly string[]): string {
    const table: CsvTable = {
        rows: [{ cells: columns, raw: null }, { cells: columns.map(() => ''), raw: null }],
        delimiter: ',', eol: '\n', finalEol: true, bom: false,
    };
    return serializeCsv(table);
}

// ---------- Reading ----------

// Which delimiter the first record uses: the one that splits it into the most cells; a comma when none splits it.
function detectDelimiter(text: string): Delimiter {
    let best: Delimiter = ',', most = 1;
    for (const delimiter of DELIMITERS) {
        const cells = readRecords(text, delimiter, 1)[0]?.cells.length ?? 1;
        if (cells > most) { best = delimiter; most = cells; }
    }
    return best;
}

// Up to `limit` records of `text` (all when 0), each with the text it came from. Quotes may hold delimiters and line
// breaks; a doubled quote inside them is a quote. A line break ends a record: \r\n, \n, or a lone \r.
function readRecords(text: string, delimiter: string, limit = 0): { cells: string[]; raw: string }[] {
    const records: { cells: string[]; raw: string }[] = [];
    let cells: string[] = [], field = '', quoted = false, start = 0, i = 0;
    const end = (at: number, next: number): void => {
        cells.push(field);
        records.push({ cells, raw: text.slice(start, at) });
        cells = []; field = ''; start = next;
    };
    while (i < text.length) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                quoted = false;
            } else field += ch;
            i++;
        } else if (ch === '"' && field === '') {
            quoted = true;
            i++;
        } else if (ch === delimiter) {
            cells.push(field); field = '';
            i++;
        } else if (ch === '\n' || ch === '\r') {
            const next = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1;
            end(i, next);
            if (limit && records.length >= limit) return records;
            i = next;
        } else {
            field += ch;
            i++;
        }
    }
    if (start < text.length) end(text.length, text.length);   // the last record has no line break
    return records;
}

export function parseCsv(source: string): CsvTable {
    const bom = source.startsWith(BOM);
    const text = bom ? source.slice(1) : source;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const delimiter = detectDelimiter(text);
    const rows = readRecords(text, delimiter).map((r): CsvRow => ({ cells: r.cells, raw: r.raw }));
    const finalEol = rows.length > 0 && /[\r\n]$/.test(text);
    return { rows: rows.length ? rows : [{ cells: [''], raw: null }], delimiter, eol, finalEol, bom };
}

// ---------- Writing ----------

function quoteField(field: string, delimiter: string): string {
    return field.includes(delimiter) || /["\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function serializeCsv(table: CsvTable): string {
    const lines = table.rows.map(row => row.raw ?? row.cells.map(cell => quoteField(cell, table.delimiter)).join(table.delimiter));
    return (table.bom ? BOM : '') + lines.join(table.eol) + (table.finalEol ? table.eol : '');
}

// ---------- Reading the table ----------

// The number of columns: the widest record.
export function columnCount(table: CsvTable): number {
    return table.rows.reduce((most, row) => Math.max(most, row.cells.length), 1);
}

export function cellAt(table: CsvTable, row: number, column: number): string {
    return table.rows[row]?.cells[column] ?? '';
}

// ---------- Operations ----------

const emptyCells = (count: number): string[] => new Array<string>(count).fill('');

function withRows(table: CsvTable, rows: readonly CsvRow[]): CsvTable {
    return { ...table, rows: rows.length ? rows : [{ cells: [''], raw: null }] };
}

// Cell (row, column) set to `value`; the row grows if it was shorter. The same table when nothing changes.
export function setCell(table: CsvTable, row: number, column: number, value: string): CsvTable {
    const current = table.rows[row];
    if (!current || cellAt(table, row, column) === value) return table;
    const cells = current.cells.length > column ? [...current.cells] : [...current.cells, ...emptyCells(column + 1 - current.cells.length)];
    cells[column] = value;
    return withRows(table, table.rows.map((r, i) => i === row ? { cells, raw: null } : r));
}

// An empty row at index `at` (1 = right below the header; the rows.length = at the end).
export function insertRow(table: CsvTable, at: number): CsvTable {
    const index = Math.min(Math.max(at, 1), table.rows.length);
    const rows = [...table.rows];
    rows.splice(index, 0, { cells: emptyCells(columnCount(table)), raw: null });
    return withRows(table, rows);
}

// Row `row` removed; the header cannot be.
export function deleteRow(table: CsvTable, row: number): CsvTable {
    if (row < 1 || row >= table.rows.length) return table;
    return withRows(table, table.rows.filter((_, i) => i !== row));
}

// A column at index `at` with the header `name` and empty cells; every record is written again (they all gain a cell).
export function insertColumn(table: CsvTable, at: number, name: string): CsvTable {
    const width = columnCount(table), index = Math.min(Math.max(at, 0), width);
    return withRows(table, table.rows.map((row, r) => {
        const cells = [...row.cells, ...emptyCells(width - row.cells.length)];
        cells.splice(index, 0, r === 0 ? name : '');
        return { cells, raw: null };
    }));
}

// Column `column` removed from every record; the last column cannot be.
export function deleteColumn(table: CsvTable, column: number): CsvTable {
    if (columnCount(table) < 2 || column < 0 || column >= columnCount(table)) return table;
    return withRows(table, table.rows.map(row => ({ cells: row.cells.filter((_, i) => i !== column), raw: null })));
}

// Row `from` moved so it ends at index `to` (of the rows as they are after the move); the header stays first and rows keep their
// text, so a move is a diff of the lines that changed place. The same table when nothing moves.
export function moveRow(table: CsvTable, from: number, to: number): CsvTable {
    const last = table.rows.length - 1, target = Math.min(Math.max(to, 1), last);
    if (from < 1 || from > last || target === from) return table;
    const rows = [...table.rows];
    rows.splice(target, 0, ...rows.splice(from, 1));
    return withRows(table, rows);
}

// Column `from` moved so it ends at index `to`; every record is written again.
export function moveColumn(table: CsvTable, from: number, to: number): CsvTable {
    const width = columnCount(table), target = Math.min(Math.max(to, 0), width - 1);
    if (from < 0 || from >= width || target === from) return table;
    return withRows(table, table.rows.map(row => {
        const cells = [...row.cells, ...emptyCells(Math.max(0, width - row.cells.length))];
        cells.splice(target, 0, ...cells.splice(from, 1));
        return { cells, raw: null };
    }));
}

// Where a row or column dragged from `from` ends up when it is dropped in the gap before index `gap` (0..length): the index it
// has after the move.
export const landing = (from: number, gap: number): number => gap > from ? gap - 1 : gap;

// The cells that match `pattern` (see buildPattern in search.ts), row by row from the header (row 0), left to right.
export function findCells(table: CsvTable, pattern: RegExp): { row: number; column: number }[] {
    const found: { row: number; column: number }[] = [];
    table.rows.forEach((row, r) => row.cells.forEach((cell, c) => { if (matches(cell, pattern)) found.push({ row: r, column: c }); }));
    return found;
}

function matches(cell: string, pattern: RegExp): boolean {
    pattern.lastIndex = 0;
    return pattern.test(cell);
}

// Every match in cell (row, column) replaced; the same table when there is none. With `regex` the replacement may use $1, $&.
export function replaceInCell(table: CsvTable, row: number, column: number, pattern: RegExp, replacement: string, regex: boolean): CsvTable {
    const { text, count } = replaceMatches(cellAt(table, row, column), pattern, replacement, regex);
    return count ? setCell(table, row, column, text) : table;
}

// Every match in every cell replaced, and how many matches that was. Rows without a match are the same rows as before.
export function replaceInCells(table: CsvTable, pattern: RegExp, replacement: string, regex: boolean): { table: CsvTable; count: number } {
    let count = 0;
    const rows = table.rows.map((row): CsvRow => {
        let changed = false;
        const cells = row.cells.map(cell => {
            const done = replaceMatches(cell, pattern, replacement, regex);
            if (!done.count) return cell;
            count += done.count;
            changed = true;
            return done.text;
        });
        return changed ? { cells, raw: null } : row;
    });
    return count ? { table: withRows(table, rows), count } : { table, count };
}

const NUMBER = /^[-+]?(\d[\d.,]*|[.,]\d+)%?$/;

// Whether a column holds numbers (it has a value, and every value in its first rows is one): the table aligns them right.
export function isNumericColumn(table: CsvTable, column: number, sample = 100): boolean {
    let seen = false;
    for (const row of table.rows.slice(1, sample + 1)) {
        const value = (row.cells[column] ?? '').trim();
        if (value === '') continue;
        if (!NUMBER.test(value)) return false;
        seen = true;
    }
    return seen;
}

// The header a new column gets: "Column 4" when there are three, or the next number that is free.
export function nextColumnName(table: CsvTable): string {
    const taken = new Set(table.rows[0].cells);
    for (let n = columnCount(table) + 1; ; n++) if (!taken.has(`Column ${n}`)) return `Column ${n}`;
}
