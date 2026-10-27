// Read-only tools for structured documents (a board, list, table, calendar, timeline, gallery, or chart): describe_schema
// tells the model what a document declares, and query_notes filters and counts its notes by field. Like the browsing
// tools they work on the file list they are given and never throw. Pure TypeScript.

import { describeDef, displayValue, parseSchema, parseValue, readItem, type FieldDef, type Item, type Scalar } from '../markdown/fields';
import { matchMention, type SourceFile } from './context';
import { frontmatterOptions, notesOf, rawValue, resolveWords, structuredDoc, valueHint, valueOfItem, type StructuredDoc } from './notes';
import type { ToolSpec } from './provider';
import type { ToolOutcome } from './tools';

const MAX_ROWS = 100;
const DEFAULT_ROWS = 30;

const OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'empty', 'not_empty'] as const;
type Op = typeof OPS[number];

export const SCHEMA_TOOLS: ToolSpec[] = [
    {
        name: 'describe_schema',
        description: 'Describe how a structured document is set up: its layout (board, list, table, calendar, timeline, gallery, chart), its one-line options, its fields with their types, select options and defaults, and its groups with the number of notes. Without a name it summarizes every structured file in the folder. Use it before edit_note or edit_schema so you write values the document accepts.',
        parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'File name as in list_files (optional)' } },
            additionalProperties: false,
        },
    },
    {
        name: 'query_notes',
        description: 'Find the notes of structured documents by their fields, e.g. everything due this week, or the number of notes per status. Filter with "where" (all conditions must hold), then list the notes (optionally sorted) or count them per value of a field with count_by. Use it for questions about many notes at once instead of reading every file.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Limit to one file (default: every structured file)' },
                where: { type: 'array', maxItems: 8, description: 'Conditions that must all hold', items: { type: 'object', properties: {
                    field: { type: 'string', description: 'A field of the document, or title, tag, group, or done (true/false)' },
                    op: { type: 'string', enum: [...OPS], description: 'eq, ne, lt, lte, gt, gte (dates, numbers, progress), contains, empty, not_empty' },
                    value: { type: 'string', description: 'What to compare with; a date field also accepts "today". Not used for empty/not_empty' },
                }, required: ['field', 'op'], additionalProperties: false } },
                sort_by: { type: 'string', description: 'A field to sort the result by (notes without a value go last)' },
                desc: { type: 'boolean', description: 'Sort from high to low' },
                count_by: { type: 'string', description: 'Instead of listing notes, count them per value of this field' },
                limit: { type: 'integer', description: `Maximum number of notes listed (1–${MAX_ROWS}, default ${DEFAULT_ROWS})` },
            },
            additionalProperties: false,
        },
    },
];

const asText = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ---------- describe_schema ----------

function describeDoc(file: SourceFile, doc: StructuredDoc): string {
    const notes = notesOf(doc.board);
    const groups = doc.board.columns.map(c => `${c.title || '(no heading)'} ${c.cards.length}`).join(', ');
    const lines = [`${file.name} — layout: ${doc.layout} · ${plural(notes.length, 'note', 'notes')}${groups ? ` in ${plural(doc.board.columns.length, 'group', 'groups')} (${groups})` : ''}`];
    const options = frontmatterOptions(file.text).map(([k, v]) => `${k}: ${v}`);
    if (options.length) lines.push(`options: ${options.join('; ')}`);
    lines.push(doc.schema.length ? 'fields (written in a note as [name:: value]):' : 'fields: none declared');
    for (const def of doc.schema) {
        const builtin = doc.declared.some(d => d.key === def.key) ? '' : ' (built in to boards)';
        lines.push(`- ${def.key}: ${describeDef(def)}${builtin} — ${valueHint(def)}`);
    }
    const problems = parseSchema(doc.board.head.join('\n')).problems;
    if (problems.length) lines.push(`problems in the declaration: ${problems.join('; ')}`);
    return lines.join('\n');
}

export function describeSchema(files: SourceFile[], args: Record<string, unknown>): ToolOutcome {
    const name = asText(args.name);
    if (name) {
        const file = matchMention(name, files);
        if (!file) return { content: `File "${name}" was not found. Call list_files to see the existing names.`, summary: 'file not found' };
        const doc = structuredDoc(file.text);
        if (!doc) return { content: `${file.name} is an ordinary document: its frontmatter has no "layout:", so it has no fields. edit_schema with set_layout can give it a layout.`, summary: 'ordinary document' };
        return { content: describeDoc(file, doc), summary: `${doc.layout}, ${plural(doc.schema.length, 'field', 'fields')}` };
    }
    const docs = files.flatMap(f => { const d = structuredDoc(f.text); return d ? [{ file: f, doc: d }] : []; });
    if (!docs.length) return { content: 'No file in the folder has a layout in its frontmatter yet.', summary: 'none' };
    return { content: docs.map(d => describeDoc(d.file, d.doc)).join('\n\n'), summary: plural(docs.length, 'document', 'documents') };
}

// ---------- query_notes ----------

interface Condition { field: string; op: Op; value: string }

// Where a note can be tested: its parsed item plus the facts about where it sits.
interface Row { file: string; group: string; done: boolean | null; item: Item; doc: StructuredDoc }

const SPECIAL = ['title', 'tag', 'group', 'done'];

function readConditions(raw: unknown): Condition[] | string {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return 'The "where" argument must be a list of conditions.';
    const out: Condition[] = [];
    for (const c of raw) {
        const field = asText(c?.field), op = asText(c?.op) as Op;
        if (!field || !OPS.includes(op)) return `Each condition needs a "field" and an "op" (one of ${OPS.join(', ')}).`;
        const value = rawValue(c.value) ?? '';
        if (op !== 'empty' && op !== 'not_empty' && !value.trim()) return `The condition on "${field}" needs a "value".`;
        out.push({ field, op, value: value.trim() });
    }
    return out;
}

// The values a row has for `field`, as comparable scalars; special names are title, tag, group, and done.
function valuesOf(row: Row, def: FieldDef | null, field: string): Scalar[] {
    const f = field.toLowerCase();
    if (!def && f === 'title') return [row.item.title];
    if (!def && f === 'tag') return row.item.tags;
    if (!def && f === 'group') return row.group ? [row.group] : [];
    if (!def && f === 'done') return row.done === null ? [] : [String(row.done)];
    const value = def ? valueOfItem(row.item, def) : null;
    return value === null ? [] : [value].flat();
}

// A scalar as something `<` can compare: dates by day (or day and time), progress by ratio, numbers as they are.
function keyOf(def: FieldDef | null, v: Scalar, dayOnly: boolean): string | number {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return v.toLowerCase().replace(/^#/, '');
    if ('date' in v) return dayOnly ? v.date : `${v.date} ${v.time ?? '00:00'}`;
    return v.done / v.total;
}

function wantedOf(def: FieldDef | null, cond: Condition, now: Date): Scalar | string {
    if (!def) return cond.value.toLowerCase().replace(/^#/, '');
    const parsed = parseValue({ ...def, multiple: false }, resolveWords(def, cond.value, now));
    return parsed.ok ? [parsed.value].flat()[0] : cond.value;
}

function compare(op: Op, actual: string | number, wanted: string | number): boolean {
    switch (op) {
        case 'eq': return actual === wanted;
        case 'ne': return actual !== wanted;
        case 'lt': return actual < wanted;
        case 'lte': return actual <= wanted;
        case 'gt': return actual > wanted;
        case 'gte': return actual >= wanted;
        default: return String(actual).includes(String(wanted));
    }
}

function holds(row: Row, cond: Condition, now: Date): boolean {
    const def = row.doc.schema.find(f => f.key.toLowerCase() === cond.field.toLowerCase()) ?? null;
    const values = valuesOf(row, def, cond.field);
    if (cond.op === 'empty') return !values.length;
    if (cond.op === 'not_empty') return values.length > 0;
    if (!values.length) return cond.op === 'ne';
    const wanted = wantedOf(def, cond, now);
    const dayOnly = typeof wanted === 'object' && 'date' in wanted && !wanted.time;
    const w = typeof wanted === 'object' || typeof wanted === 'number' ? keyOf(def, wanted, dayOnly) : wanted;
    const keys = values.map(v => keyOf(def, v, dayOnly));
    return cond.op === 'ne' ? keys.every(k => k !== w) : keys.some(k => compare(cond.op, k, w));
}

// The first condition that names no field of any of the documents, as a message; null if all do.
function unknownField(conds: Condition[], docs: { doc: StructuredDoc }[]): string | null {
    const known = new Set(docs.flatMap(d => d.doc.schema.map(f => f.key.toLowerCase())));
    const bad = conds.find(c => !SPECIAL.includes(c.field.toLowerCase()) && !known.has(c.field.toLowerCase()));
    return bad ? `No structured document has a field "${bad.field}". Fields: ${[...new Set(docs.flatMap(d => d.doc.schema.map(f => f.key)))].join(', ') || '(none)'}; also title, tag, group, done.` : null;
}

function rowsOf(docs: { file: SourceFile; doc: StructuredDoc }[]): Row[] {
    return docs.flatMap(({ file, doc }) => notesOf(doc.board).map(n => {
        const card = doc.board.columns[n.at.column].cards[n.at.index];
        return { file: file.name, group: n.group, done: card.done, item: readItem(card.text, doc.schema), doc };
    }));
}

// The sort key of a row for field `key`: null when it has no value.
function sortKey(row: Row, key: string): string | number | null {
    const def = row.doc.schema.find(f => f.key.toLowerCase() === key.toLowerCase()) ?? null;
    const first = valuesOf(row, def, key)[0];
    return first === undefined ? null : keyOf(def, first, false);
}

function sortRows(rows: Row[], key: string, desc: boolean): Row[] {
    const keyed = rows.map(row => ({ row, key: sortKey(row, key) }));
    const order = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0) * (desc ? -1 : 1);
    return keyed.sort((a, b) => a.key === null || b.key === null ? Number(a.key === null) - Number(b.key === null) : order(a.key, b.key)).map(k => k.row);
}

const rowLine = (r: Row): string => `${r.file}${r.group ? ` › ${r.group}` : ''} · ${r.done === null ? '' : r.done ? '[x] ' : '[ ] '}${r.item.title}${Object.keys(r.item.fields).length || r.item.tags.length ? ` — ${noteSummary(r)}` : ''}`;

function noteSummary(r: Row): string {
    const fields = Object.entries(r.item.fields).map(([key, p]) => {
        const def = r.doc.schema.find(f => f.key === key);
        return `${key}: ${p.ok && def ? displayValue(def, p.value) : p.ok ? '' : p.raw}`;
    });
    return [...fields, ...r.item.tags.map(t => `#${t}`)].join('; ');
}

function countBy(rows: Row[], key: string): ToolOutcome {
    const counts = new Map<string, number>();
    for (const r of rows) {
        const def = r.doc.schema.find(f => f.key.toLowerCase() === key.toLowerCase()) ?? null;
        const values = valuesOf(r, def, key);
        for (const v of values.length ? values : ['—']) {
            const name = typeof v === 'object' ? JSON.stringify(v) : String(v);
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    const lines = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${name}: ${n}`);
    return { content: `${plural(rows.length, 'note', 'notes')} counted by ${key} ("—" = no value):\n${lines.join('\n')}`, summary: plural(counts.size, 'value', 'values') };
}

export function queryNotes(files: SourceFile[], args: Record<string, unknown>, now = new Date()): ToolOutcome {
    const conds = readConditions(args.where);
    if (typeof conds === 'string') return { content: conds, summary: 'invalid where' };
    let docs = files.flatMap(f => { const d = structuredDoc(f.text); return d ? [{ file: f, doc: d }] : []; });
    const only = asText(args.file);
    if (only) {
        const file = matchMention(only, files);
        if (!file) return { content: `File "${only}" was not found. Call list_files to see the existing names.`, summary: 'file not found' };
        docs = docs.filter(d => d.file === file);
        if (!docs.length) return { content: `${file.name} is an ordinary document without fields.`, summary: 'ordinary document' };
    }
    if (!docs.length) return { content: 'No file in the folder has a layout in its frontmatter yet.', summary: 'none' };
    const bad = unknownField(conds, docs);
    if (bad) return { content: bad, summary: 'unknown field' };
    const rows = rowsOf(docs).filter(r => conds.every(c => holds(r, c, now)));
    const by = asText(args.count_by);
    if (by) return countBy(rows, by);
    const sorted = asText(args.sort_by) ? sortRows(rows, asText(args.sort_by), args.desc === true) : rows;
    const limit = Math.min(Math.max(typeof args.limit === 'number' ? Math.trunc(args.limit) : DEFAULT_ROWS, 1), MAX_ROWS);
    if (!sorted.length) return { content: 'No note matches.', summary: 'no notes' };
    const more = sorted.length > limit ? `\n[… ${sorted.length - limit} more not shown; narrow the conditions or raise limit …]` : '';
    return { content: `${plural(sorted.length, 'note matches', 'notes match')}:\n${sorted.slice(0, limit).map(rowLine).join('\n')}${more}`, summary: plural(sorted.length, 'note', 'notes') };
}
