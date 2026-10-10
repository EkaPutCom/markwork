// Typed fields on a Markdown item (a kanban card or an inbox note).
//
// A document declares its fields in the frontmatter, one line per field as `key: type(arguments)`:
//
//   ---
//   fields:
//     prioritas: select(tinggi, sedang, rendah)
//     due: date
//     progres: progress
//     pemilik: person[]
//   ---
//
// and an item carries its values in the first line, after the title, as `[key:: value]`:
//
//   - [ ] Write the parser #design [prioritas:: tinggi] [due:: 2026-10-24 09:00] [progres:: 3/5]
//
// `#tag` is the only other marker. Types: text, number, select, date, progress, person, agent, link; a
// `[]` after the type (`person[]`, `select[](a, b)`) allows several comma-separated values.
//
// The functions are pure. They never reject and never rewrite text they do not understand: a value that
// does not fit its field is returned as `{ ok: false, raw, error }`, and a key that is not in the schema
// is kept as an unknown field. Writing one field replaces only that `[key:: value]` and leaves the rest
// of the line exactly as it was.

export type FieldType = 'text' | 'number' | 'select' | 'date' | 'progress' | 'person' | 'agent' | 'link';

export interface FieldDef {
    key: string;
    type: FieldType;
    multiple: boolean;
    options: string[];   // select only; empty = any value
}

export interface DateValue { date: string; time: string | null }   // "YYYY-MM-DD", "HH:MM"
export interface ProgressValue { done: number; total: number; percent: boolean }
export type Scalar = string | number | DateValue | ProgressValue;
export type Value = Scalar | Scalar[];

export type Parsed = { ok: true; value: Value } | { ok: false; raw: string; error: string };

export interface Segment { key: string; raw: string; start: number; end: number }   // `[key:: raw]` at text[start, end)

export interface Item {
    title: string;                       // text without fields and #tags
    tags: string[];
    fields: Record<string, Parsed>;      // declared fields that have a value; the first occurrence of a key wins
    unknown: { key: string; raw: string }[];   // keys that are not in the schema
}

const FIELD_TYPES: readonly FieldType[] = ['text', 'number', 'select', 'date', 'progress', 'person', 'agent', 'link'];
const KEY = /^[\p{L}][\p{L}\p{N}_-]*$/u;
const KEY_START = /^\[([\p{L}][\p{L}\p{N}_-]*)::[ \t]*/u;
const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/;
export const TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

const pad = (n: number): string => String(n).padStart(2, '0');

// ---------- Schema in the frontmatter ----------

export interface SchemaResult { fields: FieldDef[]; problems: string[] }

// The lines of the frontmatter block, or null if the document has none.
function frontmatterLines(text: string): string[] | null {
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return null;
    const end = lines.indexOf('---', 1);
    return end < 0 ? null : lines.slice(1, end);
}

const FIELD_LINE = /^[ \t]+([^:\s][^:]*?):\s*(.*?)\s*$/;
const TYPE_SPEC = /^([a-z]+)(\[\])?(?:\((.*)\))?$/;

function parseDef(key: string, spec: string): FieldDef | string {
    if (!KEY.test(key)) return `"${key}" is not a valid field name`;
    const m = TYPE_SPEC.exec(spec);
    const type = m?.[1] as FieldType | undefined;
    if (!m || !type || !FIELD_TYPES.includes(type)) return `${key}: unknown type "${spec}"`;
    const options = (m[3] ?? '').split(',').map(o => o.trim()).filter(Boolean);
    if (options.length && type !== 'select') return `${key}: only select takes options`;
    return { key, type, multiple: m[2] === '[]', options };
}

// The fields declared in the `fields:` block of the frontmatter, in order. A line that cannot be read is
// left out and described in `problems`.
export function parseSchema(text: string): SchemaResult {
    const result: SchemaResult = { fields: [], problems: [] };
    const lines = frontmatterLines(text);
    const start = lines?.findIndex(l => /^fields:\s*$/.test(l)) ?? -1;
    if (!lines || start < 0) return result;
    for (const line of lines.slice(start + 1)) {
        if (!line.trim()) continue;
        const m = FIELD_LINE.exec(line);
        if (!m) break;   // the next top-level key ends the block
        const def = parseDef(m[1], m[2]);
        if (typeof def === 'string') result.problems.push(def);
        else if (result.fields.some(f => f.key === def.key)) result.problems.push(`${def.key} is declared twice`);
        else result.fields.push(def);
    }
    return result;
}

export function describeDef(def: FieldDef): string {
    const args = def.options.length ? `(${def.options.join(', ')})` : '';
    return `${def.type}${def.multiple ? '[]' : ''}${args}`;
}

// The frontmatter with `option` added to the select field `key`, or the text unchanged if there is no such
// select field or it already lists the option.
export function addOption(text: string, key: string, option: string): string {
    const def = parseSchema(text).fields.find(f => f.key === key);
    const value = option.trim();
    if (!def || def.type !== 'select' || !value || /[,()]/.test(value) || def.options.includes(value)) return text;
    const lines = text.split('\n');
    const at = lines.findIndex(l => FIELD_LINE.exec(l)?.[1] === key);
    if (at < 0) return text;
    const indent = /^[ \t]+/.exec(lines[at])?.[0] ?? '  ';
    lines[at] = `${indent}${key}: ${describeDef({ ...def, options: [...def.options, value] })}`;
    return lines.join('\n');
}

// The declared option closest to `input`: equal ignoring case, or one typo away. Used to offer an existing
// option before a new one is added.
export function nearestOption(def: FieldDef, input: string): string | null {
    const wanted = input.trim().toLowerCase();
    if (!wanted) return null;
    return def.options.find(o => o.toLowerCase() === wanted)
        ?? def.options.find(o => withinOneEdit(o.toLowerCase(), wanted)) ?? null;
}

function withinOneEdit(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    return short.slice(i) === long.slice(i + 1);
}

// ---------- Values ----------

const fail = (raw: string, error: string): Parsed => ({ ok: false, raw, error });
const good = (value: Value): Parsed => ({ ok: true, value });

function parseDate(raw: string): Parsed {
    const m = DATE.exec(raw);
    if (!m) return fail(raw, 'not a date (YYYY-MM-DD, optionally with HH:MM)');
    const [, y, mo, d, h, mi] = m;
    const probe = new Date(Date.UTC(+y, +mo - 1, +d));
    if (probe.getUTCMonth() !== +mo - 1 || probe.getUTCDate() !== +d) return fail(raw, 'no such day');
    if (h !== undefined && (+h > 23 || +mi > 59)) return fail(raw, 'no such time');
    return good({ date: `${y}-${mo}-${d}`, time: h === undefined ? null : `${pad(+h)}:${mi}` });
}

function parseProgress(raw: string): Parsed {
    const percent = /^(\d{1,3})%$/.exec(raw);
    if (percent) return +percent[1] > 100 ? fail(raw, 'more than 100%') : good({ done: +percent[1], total: 100, percent: true });
    const ratio = /^(\d+)\/(\d+)$/.exec(raw);
    if (!ratio) return fail(raw, 'not a progress (3/5 or 60%)');
    return +ratio[2] === 0 || +ratio[1] > +ratio[2] ? fail(raw, 'the total must be at least the done count')
        : good({ done: +ratio[1], total: +ratio[2], percent: false });
}

function parseNumber(raw: string): Parsed {
    const n = Number(raw);
    return raw !== '' && Number.isFinite(n) ? good(n) : fail(raw, 'not a number');
}

function parseSelect(def: FieldDef, raw: string): Parsed {
    if (!def.options.length) return good(raw);
    const found = def.options.find(o => o.toLowerCase() === raw.toLowerCase());
    return found === undefined ? fail(raw, `not one of: ${def.options.join(', ')}`) : good(found);
}

function parseScalar(def: FieldDef, raw: string): Parsed {
    switch (def.type) {
        case 'number': return parseNumber(raw);
        case 'date': return parseDate(raw);
        case 'progress': return parseProgress(raw);
        case 'select': return parseSelect(def, raw);
        case 'agent': return AGENT_NAME.test(raw.toLowerCase()) ? good(raw.toLowerCase()) : fail(raw, 'not an agent name');
        case 'link': return good(/^\[\[(.+)\]\]$/.exec(raw)?.[1] ?? raw);
        default: return good(raw);
    }
}

// Split a comma-separated list; commas inside quotes or [[…]] do not separate.
function splitList(raw: string): string[] {
    const parts: string[] = [];
    let depth = 0, quoted = false, from = 0;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '"') quoted = !quoted;
        else if (!quoted && c === '[') depth++;
        else if (!quoted && c === ']') depth = Math.max(0, depth - 1);
        else if (!quoted && depth === 0 && c === ',') { parts.push(raw.slice(from, i)); from = i + 1; }
    }
    parts.push(raw.slice(from));
    return parts.map(p => p.trim()).filter(Boolean);
}

// The value of `raw` (the text between `::` and `]`, already unquoted) for field `def`.
export function parseValue(def: FieldDef, raw: string): Parsed {
    const text = raw.trim();
    if (!text) return fail(raw, 'empty');
    if (!def.multiple) return parseScalar(def, text);
    const values: Scalar[] = [];
    for (const part of splitList(text)) {
        const one = parseScalar(def, unquote(part));
        if (!one.ok) return fail(raw, one.error);
        values.push(...[one.value].flat());
    }
    return values.length ? good(values) : fail(raw, 'empty');
}

function formatScalar(def: FieldDef, value: Scalar): string {
    if (typeof value === 'string') return def.type === 'link' ? `[[${value}]]` : value;
    if (typeof value === 'number') return String(value);
    if ('date' in value) return value.time ? `${value.date} ${value.time}` : value.date;
    return value.percent ? `${value.done}%` : `${value.done}/${value.total}`;
}

const needsQuotes = (s: string): boolean => /[\]\n"]|^\s|\s$/.test(s) && !/^\[\[.+\]\]$/.test(s);
const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

function unquote(s: string): string {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
    return m ? m[1].replace(/\\(.)/g, '$1') : s;
}

// The text written between `::` and `]` for `value`.
export function formatValue(def: FieldDef, value: Value): string {
    const parts = [value].flat().map(v => formatScalar(def, v));
    return (def.multiple ? parts.map(p => needsQuotes(p) || p.includes(',') && !p.startsWith('[[') ? quote(p) : p).join(', ')
        : needsQuotes(parts[0]) ? quote(parts[0]) : parts[0]);
}

// ---------- Fields in item text ----------

// Index just past the `]` that closes the `[` at `from`: brackets nest (`[[link]]`), quotes protect `]`.
function closingBracket(text: string, from: number): number {
    let depth = 0, quoted = false;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c === '\\' && quoted) i++;
        else if (c === '"') quoted = !quoted;
        else if (!quoted && c === '[') depth++;
        else if (!quoted && c === ']' && --depth === 0) return i + 1;
    }
    return -1;
}

// Every `[key:: value]` in the text, in order. An unclosed one is not a field.
export function findSegments(text: string): Segment[] {
    const segments: Segment[] = [];
    for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
        const head = KEY_START.exec(text.slice(i));
        if (!head) continue;
        const end = closingBracket(text, i);
        if (end < 0) continue;
        segments.push({ key: head[1], raw: text.slice(i + head[0].length, end - 1).trim(), start: i, end });
        i = end - 1;
    }
    return segments;
}

const unquoteRaw = (raw: string, multiple: boolean): string => multiple ? raw : unquote(raw);

function stripSegments(text: string, segments: Segment[]): string {
    let out = '', at = 0;
    for (const s of segments) { out += text.slice(at, s.start); at = s.end; }
    return (out + text.slice(at)).replace(TAG, '$1').replace(/\s{2,}/g, ' ').trim();
}

// Read the first line of an item against the schema.
export function readItem(text: string, schema: FieldDef[]): Item {
    const segments = findSegments(text);
    const item: Item = { title: stripSegments(text, segments) || text.trim(), tags: [...text.matchAll(TAG)].map(m => m[2]), fields: {}, unknown: [] };
    for (const s of segments) {
        const def = schema.find(f => f.key === s.key);
        if (!def) item.unknown.push({ key: s.key, raw: s.raw });
        else if (!(s.key in item.fields)) item.fields[s.key] = parseValue(def, unquoteRaw(s.raw, def.multiple));
    }
    return item;
}

// `text` with the field `def.key` set to `value`, or removed if `value` is null. Only that field changes:
// the rest of the line stays as it was. A field that is not in the text yet is added at the end.
export function writeField(text: string, def: FieldDef, value: Value | null): string {
    const at = findSegments(text).find(s => s.key === def.key);
    const written = value === null ? '' : `[${def.key}:: ${formatValue(def, value)}]`;
    if (!at) return written ? `${text.trimEnd()} ${written}` : text;
    if (written) return text.slice(0, at.start) + written + text.slice(at.end);
    return [text.slice(0, at.start).trimEnd(), text.slice(at.end).trimStart()].filter(Boolean).join(' ');
}

// `text` with field `def` set from what a user typed: empty removes the field, a valid value is written in
// its normal form, and a value that does not fit leaves the text as it was.
export function setField(text: string, def: FieldDef, raw: string): string {
    if (!raw.trim()) return writeField(text, def, null);
    const parsed = parseValue(def, raw);
    return parsed.ok ? writeField(text, def, parsed.value) : text;
}

// ---------- Showing and editing fields ----------

// The text a field has in `text` for an edit control: its normal form if it is valid, what was written if
// not, empty if absent.
export function fieldInputText(text: string, def: FieldDef): string {
    const parsed = readItem(text, [def]).fields[def.key];
    if (!parsed) return '';
    return parsed.ok ? formatValue(def, parsed.value) : parsed.raw;
}

// One small label for a field on a card or row.
export interface FieldChip {
    key: string;
    text: string;
    type: FieldType | null;     // null = a key that is not in the schema
    option: number | null;      // select: the index of the chosen option, for its color
    invalid: string | null;     // why the value does not fit its field
}

function displayValue(def: FieldDef, value: Value): string {
    return [value].flat().map(v => formatScalar(def, v).replace(/^\[\[(.+)\]\]$/, '$1')).join(', ');
}

// The chips to show for the fields of `item`, in schema order, then unknown keys. `skip` lists fields that
// are shown some other way (a due date, an assigned agent).
export function fieldChips(item: Item, schema: FieldDef[], skip: readonly string[] = []): FieldChip[] {
    const chips: FieldChip[] = [];
    for (const def of schema) {
        const parsed = item.fields[def.key];
        if (!parsed || skip.includes(def.key)) continue;
        if (!parsed.ok) { chips.push({ key: def.key, text: `${def.key}: ${parsed.raw}`, type: def.type, option: null, invalid: parsed.error }); continue; }
        const text = displayValue(def, parsed.value);
        const option = def.type === 'select' && !def.multiple ? def.options.indexOf(text) : -1;
        chips.push({ key: def.key, text: def.type === 'select' ? text : `${def.key}: ${text}`, type: def.type, option: option >= 0 ? option : null, invalid: null });
    }
    for (const u of item.unknown) if (!skip.includes(u.key)) chips.push({ key: u.key, text: `${u.key}: ${u.raw}`, type: null, option: null, invalid: null });
    return chips;
}

// The fields of `schema` that `item` has no value for, in schema order. A value that does not fit its field
// counts as present, so it is fixed rather than silently replaced. `skip` lists fields that are set some other way.
export function missingFields(item: Item, schema: FieldDef[], skip: readonly string[] = []): FieldDef[] {
    return schema.filter(def => !(def.key in item.fields) && !skip.includes(def.key));
}
