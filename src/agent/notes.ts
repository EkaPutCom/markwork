// What the agent knows about the notes of a structured document (one with a `layout:` in its frontmatter: a board, list,
// table, calendar, timeline, gallery, or chart): its schema, its notes, and checks of both. Everything here is read-only
// and pure TypeScript; edit_note and edit_schema (notechanges.ts) and the read tools describe_schema and
// query_notes (schematools.ts) are built on it.

import type { Issue } from '../markdown/lint';
import { groupFieldOf } from '../markdown/boardgroup';
import { displayValue, formatValue, parseSchema, parseValue, readItem, resolveDefault, type FieldDef, type Item, type Value } from '../markdown/fields';
import { boardSchema, declaredFields, parseBoard, type Board, type Position } from '../markdown/kanban';
import { layoutOf, type Layout } from '../markdown/layout';

export type Found<T> = { ok: true; value: T } | { ok: false; message: string };
export const found = <T>(value: T): Found<T> => ({ ok: true, value });
export const missing = (message: string): Found<never> => ({ ok: false, message });

export interface StructuredDoc {
    layout: Layout;
    board: Board;
    schema: FieldDef[];     // declared fields, and for a board also due and agent
    declared: FieldDef[];   // only what the frontmatter declares
    groupField: FieldDef | null;   // the select field a `group:` board uses for its columns
}

// The document as notes with a schema, or null for an ordinary document.
export function structuredDoc(text: string): StructuredDoc | null {
    const layout = layoutOf(text);
    if (!layout) return null;
    const board = parseBoard(text);
    const schema = boardSchema(board);
    return { layout, board, schema, declared: declaredFields(board), groupField: layout === 'board' ? groupFieldOf(board, schema) : null };
}

export const NOT_STRUCTURED = (name: string): string =>
    `${name} is an ordinary document (its frontmatter has no "layout:"). Use edit_file, or edit_schema with set_layout to give it a layout.`;

// ---------- Reading a document's definition ----------

// How a value of `def` is written, for the model.
export function valueHint(def: FieldDef): string {
    const one = ((): string => {
        switch (def.type) {
            case 'number': return 'a number';
            case 'select': return def.options.length ? `one of: ${def.options.join(', ')}` : 'any text';
            case 'date': return 'YYYY-MM-DD, or YYYY-MM-DD HH:MM; "today" and "now" are accepted when writing';
            case 'progress': return 'done/total such as 3/5, or a percentage such as 60%';
            case 'person': return 'a name';
            case 'agent': return 'an agent name such as pi';
            case 'link': return 'the name of another note (written as [[name]])';
            default: return 'any text';
        }
    })();
    return def.multiple ? `several, comma-separated: ${one}` : one;
}

// The one-line options of the frontmatter (everything except `layout:` and the `fields:` block), as [key, value].
export function frontmatterOptions(text: string): [string, string][] {
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return [];
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    const options: [string, string][] = [];
    for (const line of lines.slice(1, end < 0 ? lines.length : end)) {
        const m = /^([A-Za-z][\w-]*):[ \t]*(.*?)\s*$/.exec(line);
        if (m && m[2] && m[1] !== 'layout') options.push([m[1], m[2]]);
    }
    return options;
}

// ---------- Finding notes ----------

export interface NoteRef { at: Position; text: string; group: string }

// Every note of the document, in order.
export const notesOf = (board: Board): NoteRef[] =>
    board.columns.flatMap((c, column) => c.cards.map((card, index) => ({ at: { column, index }, text: card.text, group: c.title })));

// The one note whose first line contains `fragment` (ignoring case), or why there is not exactly one.
export function findNote(board: Board, fragment: string, fileName: string): Found<Position> {
    const wanted = fragment.trim().toLowerCase();
    if (!wanted) return missing('The "note" argument is required: a piece of the text of the note.');
    const hits = notesOf(board).filter(n => n.text.toLowerCase().includes(wanted));
    if (hits.length === 1) return found(hits[0].at);
    const list = hits.slice(0, 5).map(n => `"${n.text}"${n.group ? ` (${n.group})` : ''}`).join('; ');
    return missing(hits.length ? `"${fragment}" matches ${hits.length} notes: ${list}. Extend the text until it is unique.` : `No note contains "${fragment}" in ${fileName}.`);
}

// The group named `name`: exactly, or else the only one that contains it.
export function findGroup(board: Board, name: string): Found<number> {
    const w = name.trim().toLowerCase();
    const titles = board.columns.map(c => c.title || '(no heading)').join(', ') || '(no groups yet)';
    if (!w) return missing(`The "group" argument is required. Groups: ${titles}.`);
    const exact = board.columns.flatMap((c, i) => c.title.toLowerCase() === w ? [i] : []);
    const hits = exact.length ? exact : board.columns.flatMap((c, i) => c.title.toLowerCase().includes(w) ? [i] : []);
    return hits.length === 1 ? found(hits[0]) : missing(`The group "${name}" ${hits.length ? 'matches more than one group' : 'does not exist'}. Groups: ${titles}.`);
}

// The field of a document named `key` (ignoring case), or why there is none.
export function findField(doc: StructuredDoc, key: string): Found<FieldDef> {
    const def = doc.schema.find(f => f.key.toLowerCase() === key.trim().toLowerCase());
    if (def) return found(def);
    const keys = doc.schema.map(f => f.key).join(', ') || '(none)';
    return missing(`The document has no field "${key}". Its fields: ${keys}. Declare a new one with edit_schema add_field.`);
}

// ---------- Values the model wrote ----------

// A value as the model gave it (text, a number, a list), for parseValue; null when it cannot be one.
export function rawValue(v: unknown): string | null {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number') ? v.join(', ') : null;
}

// `today` and `now` stand for the date and time on a date field.
export function resolveWords(def: FieldDef, raw: string, now: Date): string {
    const word = raw.trim().toLowerCase();
    return def.type === 'date' && (word === 'today' || word === 'now') ? resolveDefault({ ...def, multiple: false, default: word }, now) ?? raw : raw;
}

// The value a user would see for `def` in `item`, or null if the item has none (or an invalid one).
export function valueOfItem(item: Item, def: FieldDef): Value | null {
    const parsed = item.fields[def.key];
    return parsed?.ok ? parsed.value : null;
}

// ---------- Checks ----------

// Problems in the schema and in the values of the notes. Keys have no line number, so an old problem that merely moved
// is not new (the same idea as the Markdown structure check).
export function structuredIssues(text: string): Issue[] {
    const doc = structuredDoc(text);
    if (!doc) return [];
    const issues: Issue[] = parseSchema(doc.board.head.join('\n')).problems.map(p => ({ line: 1, key: `schema:${p}`, text: `field declaration: ${p}` }));
    for (const note of notesOf(doc.board)) {
        const item = readItem(note.text, doc.schema);
        for (const [key, parsed] of Object.entries(item.fields)) {
            if (!parsed.ok) issues.push({ line: 1, key: `value:${key}:${item.title}`, text: `"${item.title}": ${key} "${parsed.raw}" is not valid (${parsed.error})` });
        }
        for (const u of item.unknown) issues.push({ line: 1, key: `unknown:${u.key}:${item.title}`, text: `"${item.title}": the field "${u.key}" is not declared in the frontmatter` });
    }
    return issues;
}

// verify_work, kind note: exactly one note is `fragment` (its whole text, or its title without fields and tags; else the
// only note that contains it), optionally in group `group` and with the done status `done` (a note without a checkbox
// counts as not done).
export function checkNote(text: string, fragment: string, group: string | null, done: boolean | null): { label: string; passed: boolean } {
    const label = (tail: string): string => `note: ${fragment}${group ? ` → ${group}` : ''}${done === null ? '' : done ? ' (done)' : ' (not done)'}${tail}`;
    const doc = structuredDoc(text);
    if (!doc) return { label: label(' — the file is not a structured document'), passed: false };
    const wanted = group?.trim().toLowerCase() ?? null;
    const notes = notesOf(doc.board).filter(n => wanted === null || n.group.toLowerCase() === wanted);
    const lower = fragment.trim().toLowerCase();
    const exact = notes.filter(n => n.text === fragment || readItem(n.text, []).title === fragment);
    const hits = exact.length ? exact : notes.filter(n => n.text.toLowerCase().includes(lower));
    if (hits.length !== 1) return { label: label(` — ${hits.length ? `${hits.length} notes match` : 'no such note'}${wanted === null ? '' : ' in that group'}`), passed: false };
    const card = doc.board.columns[hits[0].at.column].cards[hits[0].at.index];
    const actual = card.done === true;
    return done === null || actual === done ? { label: label(''), passed: true } : { label: label(` — it is ${actual ? 'done' : 'not done'}`), passed: false };
}

// verify_work, kind field: the one note containing `fragment` has `expected` as the value of field `key` ('' = no value).
export function checkNoteField(text: string, fragment: string, key: string, expected: string, now = new Date()): { label: string; passed: boolean } {
    const label = (tail: string): string => `field: ${fragment} → ${key} = ${expected || '(none)'}${tail}`;
    const doc = structuredDoc(text);
    if (!doc) return { label: label(' — the file is not a structured document'), passed: false };
    const note = findNote(doc.board, fragment, 'the file');
    if (!note.ok) return { label: label(` — ${note.message}`), passed: false };
    const def = findField(doc, key);
    if (!def.ok) return { label: label(` — ${def.message}`), passed: false };
    const item = readItem(doc.board.columns[note.value.column].cards[note.value.index].text, doc.schema);
    const actual = item.fields[def.value.key];
    const shown = !actual ? '(none)' : actual.ok ? displayValue(def.value, actual.value) : actual.raw;
    const passed = expected.trim() ? sameValue(def.value, actual, expected, now) : !actual;
    return { label: label(passed ? '' : ` — actual: ${shown}`), passed };
}

function sameValue(def: FieldDef, actual: ReturnType<typeof readItem>['fields'][string] | undefined, expected: string, now: Date): boolean {
    if (!actual?.ok) return false;
    const wanted = parseValue(def, resolveWords(def, expected, now));
    return wanted.ok && formatValue(def, wanted.value) === formatValue(def, actual.value);
}
