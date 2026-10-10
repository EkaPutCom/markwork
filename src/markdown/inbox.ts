// Inbox: a place to capture ideas, links, and quick notes in a Markdown file. Frontmatter
// marks the document as an inbox:
//
//   ---
//   inbox: true
//   ---
//
//   # Inbox                          ← title and description (anything before the first item) are kept
//
//   - Read the GNOME HIG article #read [created:: 2026-10-07 14:32]
//     item note (indented)           ← an indented line = item note
//   - [x] Workbench name idea #nyerat [created:: 2026-10-07 09:10]
//
// One item = one list bullet; the `created` field (see fields.ts) is the capture time. Items without
// a time are still valid. Pure TypeScript without
// GTK; all operations return a new inbox.

import { addOption, fieldChips, findSegments, missingFields, parseSchema, readItem, setField, type DateValue, type FieldChip, type FieldDef } from './fields.js';
import { parseColumn, trimBlankEnds, type Card } from './kanban.js';

export const CREATED_FIELD: FieldDef = { key: 'created', type: 'date', multiple: false, options: [] };
export const INBOX_SCHEMA: FieldDef[] = [CREATED_FIELD];

export type InboxItem = Card;

export interface Inbox {
    head: string[];        // frontmatter, title, and description: all lines before the first item
    items: InboxItem[];    // from the top; new items are inserted at the top
    outro: string[];       // plain lines after the last item, kept as is
}

export const DEFAULT_HEAD = ['---', 'inbox: true', '---'];

const MARKER = /^inbox:\s*["']?(?:true|yes)["']?\s*$/i;
const ITEM = /^[-*+]\s/;

export function isInbox(text: string): boolean {
    const lines = text.split('\n', 40);
    if (lines[0]?.trim() !== '---') return false;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') return false;
        if (MARKER.test(lines[i])) return true;
    }
    return false;
}

export function parseInbox(text: string): Inbox {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    // List bullets inside the frontmatter (e.g. "tags:\n- a") are not items.
    let from = 0;
    if (lines[0]?.trim() === '---') {
        const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
        from = close < 0 ? lines.length : close + 1;
    }
    const first = lines.findIndex((l, i) => i >= from && ITEM.test(l));
    if (first < 0) return { head: trimBlankEnds(lines), items: [], outro: [] };
    const column = parseColumn('', lines.slice(first));
    return { head: trimBlankEnds(lines.slice(0, first)), items: column.cards, outro: column.outro };
}

export function serializeInbox(inbox: Inbox): string {
    const out: string[] = [...(inbox.head.length ? inbox.head : DEFAULT_HEAD), ''];
    for (const item of inbox.items) {
        const box = item.done === null ? '' : item.done ? '[x] ' : '[ ] ';
        out.push(`- ${box}${item.text}`, ...item.notes.map(n => (n ? `  ${n}` : '')));
    }
    if (inbox.items.length) out.push('');
    if (inbox.outro.length) out.push(...inbox.outro, '');
    return `${trimBlankEnds(out).join('\n')}\n`;
}

export function newInbox(title = 'Inbox'): Inbox {
    return { head: [...DEFAULT_HEAD, '', `# ${title}`], items: [], outro: [] };
}

// ---------- Operations ----------

const pad = (n: number): string => String(n).padStart(2, '0');

// "2026-10-07 14:32" for the local time of `date`.
export const stamp = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

// New item at the very top with capture time `now`. Text that already contains a capture time → used as is.
export function captureItem(inbox: Inbox, text: string, now: Date, notes: string[] = []): Inbox {
    const body = text.trim();
    if (!body) return inbox;
    const full = findSegments(body).some(s => s.key === CREATED_FIELD.key) ? body : setField(body, CREATED_FIELD, stamp(now));
    return { ...inbox, items: [{ done: null, text: full, notes }, ...inbox.items] };
}

export function updateItem(inbox: Inbox, index: number, patch: Partial<InboxItem>): Inbox {
    return { ...inbox, items: inbox.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) };
}

export const deleteItem = (inbox: Inbox, index: number): Inbox =>
    ({ ...inbox, items: inbox.items.filter((_, i) => i !== index) });

// ---------- Fields ----------

// The fields every note understands plus those the inbox declares in its frontmatter `fields:` block.
export function inboxSchema(inbox: Inbox): FieldDef[] {
    const declared = parseSchema(inbox.head.join('\n')).fields;
    return [...INBOX_SCHEMA, ...declared.filter(f => f.key !== CREATED_FIELD.key)];
}

// The chips for a note's fields; the capture time is shown as its age instead.
export const itemFields = (text: string, schema: FieldDef[]): FieldChip[] =>
    fieldChips(readItem(text, schema), schema, [CREATED_FIELD.key]);

// The fields a note has no value for yet. The capture time is set by capturing, not by hand.
export const itemMissingFields = (text: string, schema: FieldDef[]): FieldDef[] =>
    missingFields(readItem(text, schema), schema, [CREATED_FIELD.key]);

// The note at `index` with its field `def` set from `raw` (empty removes it; a value that does not fit changes nothing).
export function setItemField(inbox: Inbox, index: number, def: FieldDef, raw: string): Inbox {
    const item = inbox.items[index];
    if (!item) return inbox;
    const text = setField(item.text, def, raw);
    return text === item.text ? inbox : updateItem(inbox, index, { text });
}

// The inbox with `option` added to the select field `key` in its frontmatter; unchanged if it cannot be added.
export function withInboxOption(inbox: Inbox, key: string, option: string): Inbox {
    const head = inbox.head.join('\n');
    const next = addOption(head, key, option);
    return next === head ? inbox : { ...inbox, head: next.split('\n') };
}

// ---------- Item content ----------

export interface ItemMeta {
    title: string;            // text without #tags and capture time
    tags: string[];
    captured: Date | null;    // local time; an item without a time of day is treated as midnight
}

export function itemMeta(text: string): ItemMeta {
    const item = readItem(text, INBOX_SCHEMA);
    const created = item.fields.created;
    let captured: Date | null = null;
    if (created?.ok) {
        const { date, time } = created.value as DateValue;
        const [y, mo, d] = date.split('-').map(Number);
        const [h, mi] = (time ?? '0:0').split(':').map(Number);
        captured = new Date(y, mo - 1, d, h, mi);
    }
    return { title: item.title, tags: item.tags, captured };
}

// Compose the item text from an edited title and tags; every field in `oldText` (the capture time among them) is kept.
export function composeItem(title: string, tags: string[], oldText = ''): string {
    const tagText = tags.map(t => t.replace(/^#+/, '')).filter(Boolean).map(t => `#${t}`);
    const fields = findSegments(oldText).map(s => oldText.slice(s.start, s.end));
    return [title.trim(), ...tagText, ...fields].filter(Boolean).join(' ');
}

export type AgeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'date';
export interface Age { unit: AgeUnit; n: number }

// Item age for the "10 minutes ago" label; more than a week falls back to the date.
export function ageOf(captured: Date, now: Date): Age {
    const minutes = Math.floor((now.getTime() - captured.getTime()) / 60000);
    if (minutes < 1) return { unit: 'now', n: 0 };
    if (minutes < 60) return { unit: 'minutes', n: minutes };
    if (minutes < 60 * 24) return { unit: 'hours', n: Math.floor(minutes / 60) };
    if (minutes < 60 * 24 * 7) return { unit: 'days', n: Math.floor(minutes / (60 * 24)) };
    return { unit: 'date', n: 0 };
}
