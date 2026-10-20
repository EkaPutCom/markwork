// What a `layout: table` document shows: the columns, the order of the rows, and the rows themselves. The model is the
// same as a board's or a list's (kanban.ts), so the same file can be shown as any of them.
//
//   ---
//   layout: table
//   columns: [title, status, due]    ← optional; the default is the title and every declared field
//   sort: -due                       ← optional; a field or `title`, a minus for descending
//   ---
//
// Pure TypeScript.

import type { DateValue, FieldDef, ProgressValue } from './fields.js';
import { readItem } from './fields.js';
import { optionOf } from './layout.js';
import { boardSchema, type Board, type Card, type Position } from './kanban.js';

export const TITLE_COLUMN = 'title';
export const SECTION_COLUMN = 'section';

export interface SortSpec { key: string; desc: boolean }

export interface TableRow { at: Position; card: Card; section: string }

// The columns to show, in order. `columns: [a, b]` lists them by name (`title`, `section`, or a field); a name that
// is none of those is left out. Without it: the title, every declared field, and the section when any group has a title.
export function tableColumns(board: Board, schema: FieldDef[] = boardSchema(board)): string[] {
    const known = [TITLE_COLUMN, SECTION_COLUMN, ...schema.map(f => f.key)];
    const listed = optionOf(board.head.join('\n'), 'columns');
    if (listed !== null) {
        const names = listed.replace(/^\[|\]$/g, '').split(',').map(n => n.trim()).filter(Boolean);
        const columns = names.filter((n, i) => known.includes(n) && names.indexOf(n) === i);
        if (columns.length) return columns;
    }
    return [TITLE_COLUMN, ...schema.map(f => f.key), ...(board.columns.some(c => c.title !== '') ? [SECTION_COLUMN] : [])];
}

// The order the document asks for with `sort:`, or null.
export function sortSpec(board: Board): SortSpec | null {
    const raw = optionOf(board.head.join('\n'), 'sort');
    if (!raw) return null;
    const desc = raw.startsWith('-');
    const key = (desc ? raw.slice(1) : raw).trim();
    return key ? { key, desc } : null;
}

// What to compare for one cell: a number or a string, or null if the note has no usable value (those go last).
function sortKey(row: TableRow, key: string, schema: FieldDef[], sections: string[]): string | number | null {
    const item = readItem(row.card.text, schema);
    if (key === TITLE_COLUMN) return item.title.toLowerCase();
    if (key === SECTION_COLUMN) return sections.indexOf(row.section);
    const def = schema.find(f => f.key === key);
    const parsed = item.fields[key];
    if (!def || !parsed?.ok || Array.isArray(parsed.value)) return null;
    const value = parsed.value;
    if (typeof value === 'number' || typeof value === 'string') {
        return def.type === 'select' && def.options.length ? def.options.indexOf(value as string) : typeof value === 'string' ? value.toLowerCase() : value;
    }
    if ('date' in value) return `${(value as DateValue).date} ${(value as DateValue).time ?? '00:00'}`;
    const progress = value as ProgressValue;
    return progress.total ? progress.done / progress.total : 0;
}

function compareKeys(a: string | number | null, b: string | number | null): number {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
}

// One row per note, in the order of the document or sorted by `sort`. A note without a value for the sort key goes
// last, whichever way it is sorted; notes that compare equal keep the order of the document.
export function tableRows(board: Board, sort: SortSpec | null, schema: FieldDef[] = boardSchema(board)): TableRow[] {
    const rows = board.columns.flatMap((column, c) => column.cards.map((card, index): TableRow => ({ at: { column: c, index }, card, section: column.title })));
    if (!sort) return rows;
    const sections = board.columns.map(c => c.title);
    const keyed = rows.map((row, order) => ({ row, order, key: sortKey(row, sort.key, schema, sections) }));
    keyed.sort((x, y) => {
        const missing = (x.key === null ? 1 : 0) - (y.key === null ? 1 : 0);
        if (missing) return missing;
        const diff = compareKeys(x.key, y.key);
        return (sort.desc ? -diff : diff) || x.order - y.order;
    });
    return keyed.map(k => k.row);
}

// The sort after a click on the header of `key`: ascending, then descending, then the document's own order.
export function nextSort(current: SortSpec | null, key: string): SortSpec | null {
    if (!current || current.key !== key) return { key, desc: false };
    return current.desc ? null : { key, desc: true };
}

// An empty table: the frontmatter, a title, and a status field to start from.
export const DEFAULT_TABLE_HEAD = ['---', 'layout: table', 'add: top', 'fields:', '  status: select(todo:gray, doing:blue, done:green) = todo', '---'];

export function newTable(title = 'Table'): Board {
    return { head: [...DEFAULT_TABLE_HEAD, '', `# ${title}`], columns: [], footer: [] };
}
