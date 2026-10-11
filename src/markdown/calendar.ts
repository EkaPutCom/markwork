// What a `layout: calendar` document shows: every note on the day of one of its date fields, and the notes that have no
// date yet. The model is the same as a board's or a list's (kanban.ts), so the same file can be shown as any of them.
//
//   ---
//   layout: calendar
//   date: due                        ← optional; the date field to place notes by (default `due`, else the first date field)
//   fields:
//     due: date
//   ---
//
// Pure TypeScript without GTK.

import type { DateValue, FieldDef } from './fields.js';
import { readItem, writeField } from './fields.js';
import { optionOf } from './layout.js';
import { boardSchema, setCardField, type Board, type Card, type Position } from './kanban.js';
import { dayNumber } from './dates.js';

export interface CalendarItem {
    at: Position;
    card: Card;
    title: string;
    date: string;           // "YYYY-MM-DD"
    time: string | null;    // "HH:MM"
}

export interface CalendarData {
    key: string | null;                    // the date field notes are placed by; null if the document has none
    byDate: Map<string, CalendarItem[]>;   // notes with a date, a day's notes without a time first, then in time order
    undated: { at: Position; card: Card; title: string }[];
}

// The date field the calendar places notes by: `date:` if it names a date field, else `due`, else the first date field.
export function dateField(board: Board, schema: FieldDef[] = boardSchema(board), option = 'date', fallback = 'due'): FieldDef | null {
    const dates = schema.filter(f => f.type === 'date' && !f.multiple);
    const wanted = optionOf(board.head.join('\n'), option);
    return dates.find(f => f.key === wanted) ?? dates.find(f => f.key === fallback) ?? dates[0] ?? null;
}

// The date and time a note has in `def`, or null if it has none (or a value that is not a real date).
export function dateOf(card: Card, def: FieldDef): DateValue | null {
    const parsed = readItem(card.text, [def]).fields[def.key];
    if (!parsed?.ok || Array.isArray(parsed.value) || typeof parsed.value !== 'object' || !('date' in parsed.value)) return null;
    return dayNumber(parsed.value.date) === null ? null : parsed.value;
}

export function calendarData(board: Board, schema: FieldDef[] = boardSchema(board)): CalendarData {
    const def = dateField(board, schema);
    const byDate = new Map<string, CalendarItem[]>();
    const undated: CalendarData['undated'] = [];
    board.columns.forEach((column, c) => column.cards.forEach((card, index) => {
        const at = { column: c, index };
        const title = readItem(card.text, schema).title;
        const value = def ? dateOf(card, def) : null;
        if (!value) { undated.push({ at, card, title }); return; }
        const day = byDate.get(value.date) ?? [];
        day.push({ at, card, title, date: value.date, time: value.time });
        byDate.set(value.date, day);
    }));
    for (const day of byDate.values()) day.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    return { key: def?.key ?? null, byDate, undated };
}

// The note at `at` placed on `date` (a time it already has is kept); an empty `date` takes it off the calendar.
export function moveToDate(board: Board, at: Position, date: string, schema: FieldDef[] = boardSchema(board)): Board {
    const def = dateField(board, schema);
    const card = board.columns[at.column]?.cards[at.index];
    if (!def || !card) return board;
    if (!date) return setCardField(board, at, def, '');
    if (dayNumber(date) === null) return board;
    const time = dateOf(card, def)?.time ?? null;
    return setCardField(board, at, def, time ? `${date} ${time}` : date);
}

// A note added on `date` (from the calendar): text with the date field set.
export function textForDate(text: string, date: string, board: Board, schema: FieldDef[] = boardSchema(board)): string {
    const def = dateField(board, schema);
    return def && dayNumber(date) !== null ? writeField(text, def, { date, time: null }) : text;
}
