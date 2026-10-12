// The two proposal tools for structured documents. edit_note changes one note of a board, list, table, calendar,
// timeline, gallery, or chart document (adding it, changing its title, tags, or fields, moving it, marking it, deleting
// it) and edit_schema changes how the document is set up (its fields, the options of a select, its layout and options).
// Both check what the model wrote against the document's own schema, so an unknown field or a value that does not fit
// comes back as an error the model can fix, never as text in the file. Like every change tool they only compute the
// new contents (changes.ts turns that into a Change for the user to review). Pure TypeScript without GTK.

import { countUses, fieldNameProblem, isOptionColor, optionProblem, parseSchema, parseValue, readItem, setField, writeField, writeSchema, type FieldDef, type FieldType, type OptionColor } from '../markdown/fields.js';
import { chartItems, chartItemText } from '../markdown/chart.js';
import { captureItem, composeItem } from '../markdown/inbox.js';
import { addCard, addColumn, deleteCard, deleteColumn, moveCard, parseBoard, renameColumn, serializeBoard, updateCard, type Board, type Position } from '../markdown/kanban.js';
import { LAYOUTS, withLayout, withOption, type Layout } from '../markdown/layout.js';
import { missingField } from '../markdown/layouthint.js';
import type { ToolSpec } from './provider.js';
import { findField, findGroup, findNote, notesOf, NOT_STRUCTURED, rawValue, resolveWords, structuredDoc, valueHint, type Found, type StructuredDoc } from './notes.js';

export type Planned = { ok: true; after: string } | { ok: false; message: string; summary: string };

const fail = (message: string, summary: string): Planned => ({ ok: false, message, summary });
const asText = (v: unknown): string => typeof v === 'string' ? v : '';
const singleLine = (text: string): boolean => !!text.trim() && !text.includes('\n');

export const NOTE_ACTIONS = ['add', 'update', 'move', 'mark', 'delete', 'add_group', 'rename_group', 'delete_group'] as const;
export const SCHEMA_ACTIONS = ['add_field', 'remove_field', 'add_option', 'remove_option', 'reorder_fields', 'set_layout', 'set_option'] as const;

export const NOTE_TOOLS: ToolSpec[] = [
    {
        name: 'edit_note',
        description: 'Propose a change to one note of a structured document (a file with "layout:" in its frontmatter: board, list, table, calendar, timeline, gallery, chart). Safer than edit_file because every field value is checked against the fields the document declares (see describe_schema). Actions: add (a new note, with its fields), update (change title, tags, or fields of a note), move (to another group), mark (done / not done), delete; and for the groups (the ## headings, i.e. the columns of a board): add_group, rename_group, delete_group (only an empty one). It is not written right away: the user sees the diff and then applies or rejects it.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'File name as in list_files' },
                action: { type: 'string', enum: [...NOTE_ACTIONS], description: 'add = a new note at the end of a group (or where the document says new notes go); update = change title, tags, and/or fields; move = move to the end of another group; mark = change the done status; delete = remove the note; add_group / rename_group / delete_group = manage the groups' },
                note: { type: 'string', description: 'update/move/mark/delete: a piece of the text of an existing note (must match exactly one note)' },
                text: { type: 'string', description: 'add: the title of the new note, a single line; it may contain #tags. Put field values in "fields", not in the title' },
                title: { type: 'string', description: 'update: the new title (the tags and fields are kept). rename_group: the new name of the group' },
                tags: { type: 'array', items: { type: 'string' }, description: 'update: the complete new list of tags, without #' },
                fields: { type: 'object', description: 'add/update: field values by field name, e.g. {"status": "doing", "due": "2026-10-20"}. A value must fit the field (see describe_schema); an empty string removes the field from the note', additionalProperties: true },
                group: { type: 'string', description: 'add_group: the name of the new group. rename_group/delete_group: the existing group. add/move: the group (the ## heading, i.e. the column of a board). On a board grouped by a field it is a value of that field. Required to add to a board' },
                done: { type: 'boolean', description: 'mark only: true = done, false = not done' },
                reason: { type: 'string', description: 'One sentence: why this change' },
            },
            required: ['name', 'action', 'reason'],
            additionalProperties: false,
        },
    },
    {
        name: 'edit_schema',
        description: 'Propose a change to how a structured document is set up, in its frontmatter: add or remove a field, add or remove an option of a select field, put the fields in another order, switch the layout, or set a layout option (group, sort, date, columns, …). The notes are not rewritten; a field or option that notes still use cannot be removed. Check the current setup with describe_schema first. It is not written right away: the user sees the diff and then applies or rejects it.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'File name as in list_files' },
                action: { type: 'string', enum: [...SCHEMA_ACTIONS], description: 'add_field = declare a field; remove_field = drop a declaration; add_option / remove_option = change the options of a select field; reorder_fields = new order; set_layout = switch the layout; set_option = set (or with an empty value, remove) a one-line option' },
                field: { type: 'string', description: 'add_field/remove_field/add_option/remove_option: the field name (a letter first, then letters, digits, _ or -)' },
                type: { type: 'string', description: 'add_field: text, number, select, date, progress, person, agent, or link; a select lists its options and may give each a color: select(todo:gray, doing:blue, done:green); add [] after the type for several values: person[]' },
                default: { type: 'string', description: 'add_field: the value a new note gets; for a date "today" or "now"' },
                option: { type: 'string', description: 'add_option/remove_option: the option text (no comma, parenthesis, or colon)' },
                color: { type: 'string', enum: ['red', 'amber', 'green', 'blue', 'purple', 'teal', 'pink', 'gray'], description: 'add_option: the color of the new option' },
                order: { type: 'array', items: { type: 'string' }, description: 'reorder_fields: every declared field name, in the new order' },
                layout: { type: 'string', enum: [...LAYOUTS], description: 'set_layout: the layout to switch to' },
                key: { type: 'string', description: 'set_option: add, add-to, group, sort, columns, charts, by, date, start, end, cover, period, size, or zoom' },
                value: { type: 'string', description: 'set_option: the value; empty removes the option. sort is a field name, with a leading "-" for descending' },
                force: { type: 'boolean', description: 'remove_field only: remove the declaration although notes still have a value for it (the values stay in the notes as undeclared fields)' },
                reason: { type: 'string', description: 'One sentence: why this change' },
            },
            required: ['name', 'action', 'reason'],
            additionalProperties: false,
        },
    },
];

// ---------- edit_note ----------

// One edit_note call on a parsed document: the arguments and the lookups every action uses.
class NoteTarget {
    constructor(readonly doc: StructuredDoc, readonly args: Record<string, unknown>, readonly fileName: string, readonly now: Date) {}

    get board(): Board { return this.doc.board; }

    note(): Found<Position> { return findNote(this.board, asText(this.args.note), this.fileName); }

    // `text` with every entry of the "fields" argument written, each checked against the schema.
    withFields(text: string): Found<string> {
        const given = this.args.fields;
        if (given === undefined) return { ok: true, value: text };
        if (!given || typeof given !== 'object' || Array.isArray(given)) return { ok: false, message: 'The "fields" argument must be an object of field values, e.g. {"status": "doing"}.' };
        let out = text;
        for (const [key, value] of Object.entries(given)) {
            const next = this.withField(out, key, value);
            if (!next.ok) return next;
            out = next.value;
        }
        return { ok: true, value: out };
    }

    private withField(text: string, key: string, value: unknown): Found<string> {
        const def = findField(this.doc, key);
        if (!def.ok) return def;
        const raw = rawValue(value);
        if (raw === null) return { ok: false, message: `The value of "${key}" must be text, a number, or a list of them.` };
        if (!raw.trim()) return { ok: true, value: writeField(text, def.value, null) };
        const parsed = parseValue(def.value, resolveWords(def.value, raw, this.now));
        if (!parsed.ok) return { ok: false, message: `Field "${def.value.key}": "${raw}" is not valid (${parsed.error}). Expected: ${valueHint(def.value)}.` };
        return { ok: true, value: writeField(text, def.value, parsed.value) };
    }

    // The option of the board's grouping field named by "group" (ignoring case).
    groupValue(def: FieldDef): Found<string> {
        const wanted = asText(this.args.group).trim().toLowerCase();
        const option = def.options.find(o => o.toLowerCase() === wanted);
        return option !== undefined ? { ok: true, value: option }
            : { ok: false, message: `"${asText(this.args.group)}" is not a value of ${def.key}. The board's columns are: ${def.options.join(', ')}.` };
    }
}

const failed = <T>(v: Found<T> | Board): v is Extract<Found<T>, { ok: false }> => 'ok' in v && !v.ok;

// A new note: where the document puts new notes (a board needs a group), with its fields and the defaults it declares.
function addNote(t: NoteTarget): Board | Found<never> {
    const title = asText(t.args.text).trim();
    if (!singleLine(title)) return { ok: false, message: 'The "text" argument (the title of the new note, a single line) is required.' };
    let text = t.withFields(title);
    if (failed(text)) return text;
    const grouped = t.doc.groupField;
    if (grouped && asText(t.args.group)) {
        const value = t.groupValue(grouped);
        if (failed(value)) return value;
        text = { ok: true, value: setField(text.value, grouped, value.value) };
    }
    return placeNote(t, text.value);
}

function placeNote(t: NoteTarget, text: string): Board | Found<never> {
    const { board, doc } = t;
    if (doc.layout === 'board' && !doc.groupField) {
        const column = findGroup(board, asText(t.args.group));
        return failed(column) ? column : addCard(board, column.value, text, Infinity, t.now);
    }
    if (doc.groupField && board.columns.length) return addCard(board, board.columns.length - 1, text, Infinity, t.now);
    if (!asText(t.args.group)) return captureItem(board, text, t.now);
    const column = findGroup(board, asText(t.args.group));
    if (failed(column)) return column;
    const added = addCard(board, column.value, text, Infinity, t.now);
    return updateCard(added, { column: column.value, index: added.columns[column.value].cards.length - 1 }, { done: null });
}

function titleAndTags(t: NoteTarget, text: string): Found<string> {
    const title = t.args.title, tags = t.args.tags;
    if (title === undefined && tags === undefined) return { ok: true, value: text };
    if (title !== undefined && (typeof title !== 'string' || !singleLine(title))) return { ok: false, message: 'The "title" argument must be a single line.' };
    if (tags !== undefined && !(Array.isArray(tags) && tags.every(x => typeof x === 'string'))) return { ok: false, message: 'The "tags" argument must be a list of text.' };
    const old = structuredNoteParts(text);
    return { ok: true, value: composeItem(typeof title === 'string' ? title : old.title, Array.isArray(tags) ? tags : old.tags, text) };
}

// The title and tags of a note's text, for composeItem.
function structuredNoteParts(text: string): { title: string; tags: string[] } {
    const { title, tags } = readItem(text, []);
    return { title, tags };
}

function updateNote(t: NoteTarget): Board | Found<never> {
    const at = t.note();
    if (failed(at)) return at;
    if (t.args.title === undefined && t.args.tags === undefined && t.args.fields === undefined) return { ok: false, message: 'Give "title", "tags", and/or "fields" for the update.' };
    const old = t.board.columns[at.value.column].cards[at.value.index].text;
    const retitled = titleAndTags(t, old);
    if (failed(retitled)) return retitled;
    const text = t.withFields(retitled.value);
    return failed(text) ? text : updateCard(t.board, at.value, { text: text.value });
}

function moveNote(t: NoteTarget): Board | Found<never> {
    const at = t.note();
    if (failed(at)) return at;
    const grouped = t.doc.groupField;
    if (grouped) {
        const value = t.groupValue(grouped);
        if (failed(value)) return value;
        const card = t.board.columns[at.value.column].cards[at.value.index];
        return updateCard(t.board, at.value, { text: setField(card.text, grouped, value.value) });
    }
    const column = findGroup(t.board, asText(t.args.group));
    if (failed(column)) return column;
    if (column.value === at.value.column) return { ok: false, message: 'That note is already in that group.' };
    return moveCard(t.board, at.value, { column: column.value, index: Infinity });
}

function markNote(t: NoteTarget): Board | Found<never> {
    const at = t.note();
    if (failed(at)) return at;
    const done = t.args.done;
    if (typeof done !== 'boolean') return { ok: false, message: 'The "done" argument (true/false) is required for the mark action.' };
    if (t.board.columns[at.value.column].cards[at.value.index].done === done) return { ok: false, message: 'That note already has that status.' };
    return updateCard(t.board, at.value, { done });
}

function deleteNote(t: NoteTarget): Board | Found<never> {
    const at = t.note();
    return failed(at) ? at : deleteCard(t.board, at.value);
}

const groupTaken = (board: Board, name: string, except = -1): boolean =>
    board.columns.some((c, i) => i !== except && c.title.toLowerCase() === name.toLowerCase());

function addGroup(t: NoteTarget): Board | Found<never> {
    const name = asText(t.args.group).trim();
    if (!singleLine(name)) return { ok: false, message: 'The "group" argument must be the name of the new group (a single line).' };
    if (groupTaken(t.board, name)) return { ok: false, message: `The group "${name}" already exists.` };
    return addColumn(t.board, name);
}

function renameGroup(t: NoteTarget): Board | Found<never> {
    const column = findGroup(t.board, asText(t.args.group));
    if (failed(column)) return column;
    const name = asText(t.args.title).trim();
    if (!singleLine(name)) return { ok: false, message: 'The "title" argument must be the new name of the group (a single line).' };
    if (groupTaken(t.board, name, column.value)) return { ok: false, message: `The group "${name}" already exists.` };
    return renameColumn(t.board, column.value, name);
}

// Notes must not disappear together with their group.
function deleteGroup(t: NoteTarget): Board | Found<never> {
    const column = findGroup(t.board, asText(t.args.group));
    if (failed(column)) return column;
    const { title, cards } = t.board.columns[column.value];
    if (cards.length) return { ok: false, message: `The group "${title}" still contains ${cards.length} notes. Move or delete the notes first.` };
    return deleteColumn(t.board, column.value);
}

const NOTE_HANDLERS: Record<string, (t: NoteTarget) => Board | Found<never>> = {
    add: addNote, update: updateNote, move: moveNote, mark: markNote, delete: deleteNote,
    add_group: addGroup, rename_group: renameGroup, delete_group: deleteGroup,
};

export function planNote(args: Record<string, unknown>, fileName: string, text: string, now = new Date()): Planned {
    const doc = structuredDoc(text);
    if (!doc) return fail(NOT_STRUCTURED(fileName), 'not a structured document');
    const action = Object.hasOwn(NOTE_HANDLERS, asText(args.action)) ? NOTE_HANDLERS[asText(args.action)] : null;
    if (!action) return fail(`The "action" argument must be one of: ${NOTE_ACTIONS.join(', ')}.`, 'invalid action');
    const next = action(new NoteTarget(doc, args, fileName, now));
    if (!('columns' in next)) return fail(next.ok ? 'Nothing changed.' : next.message, 'note does not fit');
    const after = serializeBoard(next);
    return after === text ? fail('Nothing changed in the document.', 'no change') : { ok: true, after };
}

// ---------- edit_schema ----------

// One edit_schema call: the whole text of the file, its parsed setup, and the arguments.
class SchemaTarget {
    constructor(readonly doc: StructuredDoc, readonly args: Record<string, unknown>, readonly text: string) {}

    arg(key: string): string { return asText(this.args[key]).trim(); }

    // A field the document declares (the built-in due and agent of a board are not declarations).
    declaredField(): Found<FieldDef> {
        const key = this.arg('field');
        const def = this.doc.declared.find(f => f.key.toLowerCase() === key.toLowerCase());
        if (def) return { ok: true, value: def };
        const kept = this.doc.declared.map(f => f.key).join(', ') || '(none)';
        return { ok: false, message: `The document does not declare a field "${key}". Declared fields: ${kept}.` };
    }

    texts(): string[] { return notesOf(this.doc.board).map(n => n.text); }

    withDeclared(defs: FieldDef[]): Found<string> { return { ok: true, value: writeSchema(this.text, defs) }; }

    replace(def: FieldDef): FieldDef[] { return this.doc.declared.map(d => (d.key === def.key ? def : d)); }
}

type SchemaResult = Found<string>;

function addField(t: SchemaTarget): SchemaResult {
    const key = t.arg('field'), type = t.arg('type'), preset = t.arg('default');
    const problem = fieldNameProblem(key, t.doc.schema.map(f => f.key));
    if (problem) return { ok: false, message: problem === 'taken' ? `The document already has a field "${key}". Fields: ${t.doc.schema.map(f => f.key).join(', ')}.` : `"${key}" is not a valid field name (a letter first, then letters, digits, _ or -).` };
    if (!type) return { ok: false, message: 'The "type" argument is required: text, number, select, date, progress, person, agent, or link (e.g. select(todo, doing, done)).' };
    const spec = preset && !type.includes('=') ? `${type} = ${preset}` : type;
    const read = parseSchema(`---\nfields:\n  ${key}: ${spec}\n---`);
    if (read.problems.length || !read.fields.length) return { ok: false, message: `The field cannot be declared: ${read.problems.join('; ') || 'unreadable type'}.` };
    return t.withDeclared([...t.doc.declared, read.fields[0]]);
}

function removeField(t: SchemaTarget): SchemaResult {
    const def = t.declaredField();
    if (!def.ok) return def;
    const uses = countUses(t.texts(), def.value.key);
    if (uses && t.args.force !== true) return { ok: false, message: `${uses} notes still have a value for "${def.value.key}". Removing the declaration keeps those values in the notes as undeclared fields; set force=true if that is what the user wants.` };
    return t.withDeclared(t.doc.declared.filter(f => f.key !== def.value.key));
}

function selectField(t: SchemaTarget): Found<FieldDef> {
    const def = t.declaredField();
    return def.ok && def.value.type !== 'select' ? { ok: false, message: `"${def.value.key}" is a ${def.value.type} field, not a select.` } : def;
}

function addOptionTo(t: SchemaTarget): SchemaResult {
    const def = selectField(t);
    if (!def.ok) return def;
    const option = t.arg('option'), color = t.arg('color');
    const problem = optionProblem(option, def.value.options);
    if (problem) return { ok: false, message: `"${option}" cannot be added: ${problem === 'taken' ? `${def.value.key} already has it (${def.value.options.join(', ')})` : problem === 'empty' ? 'the "option" argument is required' : 'an option has no comma, parenthesis, or colon'}.` };
    if (color && !isOptionColor(color)) return { ok: false, message: `"${color}" is not a color. Use red, amber, green, blue, purple, teal, pink, or gray.` };
    const colors = color && isOptionColor(color) ? { ...def.value.colors, [option]: color } : def.value.colors;
    return t.withDeclared(t.replace({ ...def.value, options: [...def.value.options, option], ...(colors ? { colors } : {}) }));
}

function removeOption(t: SchemaTarget): SchemaResult {
    const def = selectField(t);
    if (!def.ok) return def;
    const option = def.value.options.find(o => o.toLowerCase() === t.arg('option').toLowerCase());
    if (option === undefined) return { ok: false, message: `${def.value.key} has no option "${t.arg('option')}". Options: ${def.value.options.join(', ') || '(none)'}.` };
    const uses = countUses(t.texts(), def.value.key, option);
    if (uses) return { ok: false, message: `${uses} notes use "${option}" in ${def.value.key}. Change those notes first (edit_note), then remove the option.` };
    if (def.value.default === option) return { ok: false, message: `"${option}" is the default of ${def.value.key}. Change the default first.` };
    const colors = Object.entries(def.value.colors ?? {}).filter(([o]) => o !== option) as [string, OptionColor][];
    const { colors: _old, ...rest } = def.value;
    return t.withDeclared(t.replace({ ...rest, options: def.value.options.filter(o => o !== option), ...(colors.length ? { colors: Object.fromEntries(colors) } : {}) }));
}

function reorderFields(t: SchemaTarget): SchemaResult {
    const order = t.args.order;
    if (!Array.isArray(order) || !order.every(x => typeof x === 'string')) return { ok: false, message: 'The "order" argument must be a list of field names.' };
    const wanted = order.map(k => t.doc.declared.find(f => f.key.toLowerCase() === k.trim().toLowerCase()));
    const defs = wanted.filter((d): d is FieldDef => d !== undefined);
    if (defs.length !== order.length || new Set(defs).size !== defs.length || defs.length !== t.doc.declared.length) {
        return { ok: false, message: `The "order" argument must list every declared field exactly once: ${t.doc.declared.map(f => f.key).join(', ')}.` };
    }
    return t.withDeclared(defs);
}

function setLayout(t: SchemaTarget): SchemaResult {
    const layout = t.arg('layout').toLowerCase() as Layout;
    if (!LAYOUTS.includes(layout)) return { ok: false, message: `The "layout" argument must be one of: ${LAYOUTS.join(', ')}.` };
    if (layout === t.doc.layout) return { ok: false, message: `The document already has layout ${layout}.` };
    const text = withLayout(t.text, layout);
    const lacking = missingField(parseBoard(text), layout);
    if (lacking) return { ok: false, message: `A ${layout} layout needs a ${lacking.type} field and the document has none. Declare one first with edit_schema add_field (for example ${lacking.key}).` };
    return { ok: true, value: text };
}

// ---------- layout options ----------

const KEY_OPTION = /^[A-Za-z][\w-]*$/;
// The options that name a field, and the type that field must have (cover can be any).
const FIELD_OPTIONS: Record<string, FieldType | null> = { group: 'select', by: 'date', date: 'date', start: 'date', end: 'date', cover: null };
const CHOICES: Record<string, string[]> = { add: ['top', 'bottom'], period: ['week', 'month'], size: ['small', 'medium', 'large'], zoom: ['week', 'month', 'quarter'] };
const OTHER_OPTIONS = ['add-to', 'sort', 'columns', 'charts'];

// Why `value` is not a good value for the option `key`, or null.
function optionProblemOf(doc: StructuredDoc, key: string, value: string): string | null {
    const fields = doc.schema.map(f => f.key);
    if (Object.hasOwn(CHOICES, key)) return CHOICES[key].includes(value.toLowerCase()) ? null : `${key} must be one of: ${CHOICES[key].join(', ')}.`;
    if (Object.hasOwn(FIELD_OPTIONS, key)) {
        const type = FIELD_OPTIONS[key];
        const candidates = doc.schema.filter(f => !type || (f.type === type && !f.multiple)).map(f => f.key);
        return candidates.includes(value) ? null : `${key} must name ${type ? `a ${type} field` : 'a field'} of the document: ${candidates.join(', ') || '(none)'}.`;
    }
    if (key === 'sort') return [...fields, 'title', 'section'].includes(value.replace(/^-/, '')) ? null : `sort must name a field (or title), with a leading "-" for descending. Fields: ${fields.join(', ') || '(none)'}.`;
    if (key === 'columns') return value.replace(/^\[|\]$/g, '').split(',').every(c => [...fields, 'title', 'section'].includes(c.trim())) ? null : `columns lists title, section, and fields of the document: ${fields.join(', ') || '(none)'}.`;
    return null;
}

function setOption(t: SchemaTarget): SchemaResult {
    const key = t.arg('key').toLowerCase(), value = t.arg('value');
    const known = [...Object.keys(CHOICES), ...Object.keys(FIELD_OPTIONS), ...OTHER_OPTIONS];
    if (!KEY_OPTION.test(key) || !known.includes(key)) return { ok: false, message: `"${key}" is not a layout option. Options: ${known.join(', ')}. The layout itself changes with set_layout and the fields with add_field.` };
    if (value.includes('\n')) return { ok: false, message: 'The "value" argument must be a single line.' };
    const problem = value ? optionProblemOf(t.doc, key, value) : null;
    if (problem) return { ok: false, message: problem };
    const written = key === 'columns' && value && !value.startsWith('[') ? `[${value}]` : key === 'charts' && value && !value.startsWith('[') ? `[${value}]` : value;
    const text = withOption(t.text, key, value ? written : null);
    return key === 'charts' && value ? checkCharts(text, written) : { ok: true, value: text };
}

// A panel name that `charts:` cannot read would be left out silently, so compare what is read with what was written.
function checkCharts(text: string, written: string): SchemaResult {
    const names = written.replace(/^\[|\]$/g, '').split(',').map(n => n.trim().toLowerCase()).filter(Boolean);
    const read = chartItems(parseBoard(text)).map(chartItemText);
    return read.join(',') === names.join(',') ? { ok: true, value: text }
        : { ok: false, message: `Some charts cannot be read (they would be left out): wanted ${names.join(', ')}, understood ${read.join(', ')}. Use kpi, tags, bar[:dateField[:week|month]], donut[:selectField].` };
}

const SCHEMA_HANDLERS: Record<string, (t: SchemaTarget) => SchemaResult> = {
    add_field: addField, remove_field: removeField, add_option: addOptionTo, remove_option: removeOption,
    reorder_fields: reorderFields, set_layout: setLayout, set_option: setOption,
};

export function planSchema(args: Record<string, unknown>, fileName: string, text: string): Planned {
    const doc = structuredDoc(text);
    const action = Object.hasOwn(SCHEMA_HANDLERS, asText(args.action)) ? SCHEMA_HANDLERS[asText(args.action)] : null;
    if (!action) return fail(`The "action" argument must be one of: ${SCHEMA_ACTIONS.join(', ')}.`, 'invalid action');
    if (!doc) return asText(args.action) === 'set_layout' ? planFirstLayout(args, text) : fail(NOT_STRUCTURED(fileName), 'not a structured document');
    const next = action(new SchemaTarget(doc, args, text));
    if (!next.ok) return fail(next.message, 'schema does not fit');
    return next.value === text ? fail('Nothing changed in the document.', 'no change') : { ok: true, after: next.value };
}

// An ordinary document gets its first layout (a frontmatter is added if it has none).
function planFirstLayout(args: Record<string, unknown>, text: string): Planned {
    const layout = asText(args.layout).trim().toLowerCase() as Layout;
    if (!LAYOUTS.includes(layout)) return fail(`The "layout" argument must be one of: ${LAYOUTS.join(', ')}.`, 'invalid layout');
    const after = withLayout(text, layout);
    const lacking = missingField(parseBoard(after), layout);
    if (lacking) return fail(`A ${layout} layout needs a ${lacking.type} field. Declare it in the same batch (edit_schema add_field ${lacking.key}) after giving the document a layout such as list.`, 'needs a field');
    return { ok: true, after };
}
