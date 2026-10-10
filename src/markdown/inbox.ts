// The notes of a `layout: list` document (an inbox, a reading list, …). The model is the same as a board's
// (kanban.ts): the notes before the first `##` heading are one unnamed group and every heading starts another, so a
// document can be shown as a board or as a list without being converted. Frontmatter marks the document (layout.ts):
//
//   ---
//   layout: list
//   add: top             ← where a new note goes: top (default) or bottom
//   fields:
//     created: date = now
//   ---
//
//   # Inbox                          ← title and description (anything before the first item) are kept
//
//   - Read the GNOME HIG article #read [created:: 2026-10-07 14:32]
//     item note (indented)           ← an indented line = item note
//   - [x] Workbench name idea #nyerat [created:: 2026-10-07 09:10]
//
// One item = one list bullet; the `created` field (see fields.ts) is the capture time. Items without a time are
// still valid. Pure TypeScript without GTK; all operations return a new board.

import { applyDefaults, fieldChips, findSegments, missingFields, readItem, type DateValue, type FieldChip, type FieldDef } from './fields.js';
import { boardSchema, type Board, type Card, type Column } from './kanban.js';
import { optionOf } from './layout.js';

export const CREATED_FIELD: FieldDef = { key: 'created', type: 'date', multiple: false, options: [] };

export const DEFAULT_HEAD = ['---', 'layout: list', 'add: top', 'fields:', '  created: date = now', '---'];

// An empty list: the frontmatter and a title, no notes.
export function newList(title = 'Inbox'): Board {
    return { head: [...DEFAULT_HEAD, '', `# ${title}`], columns: [], footer: [] };
}

// ---------- Operations ----------

const emptyGroup = (): Column => ({ title: '', intro: [], cards: [], outro: [] });

// Where a new note goes: `add: top` (the default) or `add: bottom`, and `add-to: Name` for the group of that name
// instead of the first (top) or last (bottom) group of the document.
export interface AddTarget { position: 'top' | 'bottom'; group: string | null }

export function addTarget(board: Board): AddTarget {
    const head = board.head.join('\n');
    return { position: optionOf(head, 'add')?.toLowerCase() === 'bottom' ? 'bottom' : 'top', group: optionOf(head, 'add-to') };
}

// The index of the group a new note goes into: the one named by `add-to` if there is one, else the first group (top)
// or the last (bottom).
function targetGroup(columns: Column[], target: AddTarget): number {
    const named = target.group === null ? -1 : columns.findIndex(c => c.title.toLowerCase() === target.group!.toLowerCase());
    return named >= 0 ? named : target.position === 'top' ? 0 : columns.length - 1;
}

// A new note, put where the document says (see addTarget; at the very top of the first group by default; a group
// without a name is made if there is none), with the default of every field of the document that the text does not
// set itself (the capture time, for a list that declares `created: date = now`).
export function captureItem(board: Board, text: string, now: Date, notes: string[] = []): Board {
    const body = text.trim();
    if (!body) return board;
    const item: Card = { done: null, text: applyDefaults(body, boardSchema(board), now), notes };
    const columns = board.columns.length ? board.columns : [emptyGroup()];
    const target = addTarget(board);
    const into = targetGroup(columns, target);
    return {
        ...board,
        columns: columns.map((c, i) => (i !== into ? c : { ...c, cards: target.position === 'top' ? [item, ...c.cards] : [...c.cards, item] })),
    };
}

// ---------- Fields ----------

// The chips for a note's fields; the capture time is shown as its age instead.
export const itemFields = (text: string, schema: FieldDef[]): FieldChip[] =>
    fieldChips(readItem(text, schema), schema, [CREATED_FIELD.key]);

// The fields a note has no value for yet. The capture time is set by capturing, and an agent has its own menu.
export const itemMissingFields = (text: string, schema: FieldDef[]): FieldDef[] =>
    missingFields(readItem(text, schema), schema, [CREATED_FIELD.key, 'agent']);

// ---------- Item content ----------

export interface ItemMeta {
    title: string;            // text without #tags and capture time
    tags: string[];
    captured: Date | null;    // local time; an item without a time of day is treated as midnight
}

export function itemMeta(text: string): ItemMeta {
    const item = readItem(text, [CREATED_FIELD]);
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
