// What a `layout: timeline` document shows: one row per note with a bar from its start date to its end date. The model is
// the same as a board's or a list's (kanban.ts), so the same file can be shown as any of them.
//
//   ---
//   layout: timeline
//   start: start                     ← optional; the date field a bar starts at (default `start`)
//   end: due                         ← optional; the date field a bar ends at (default `due`)
//   zoom: month                      ← optional; week, month, or quarter (default month)
//   fields:
//     start: date
//     due: date
//   ---
//
// A note with only one of the two dates is a one-day marker; a note with neither has a row but no bar. Dragging a bar
// shifts both dates, dragging an edge changes one. Pure TypeScript.

import type { FieldDef } from './fields';
import { readItem } from './fields';
import { optionOf } from './layout';
import { boardSchema, setCardField, type Board, type Card, type Position } from './kanban';
import { addDays, dayNumber, daysBetween, startOfWeek } from './dates';
import { dateOf } from './calendar';

export type Zoom = 'week' | 'month' | 'quarter';
export const ZOOMS: readonly Zoom[] = ['week', 'month', 'quarter'];
// Pixels per day for each zoom, and the step between header labels in days.
export const PIXELS_PER_DAY: Record<Zoom, number> = { week: 48, month: 20, quarter: 7 };
export const TICK_DAYS: Record<Zoom, number> = { week: 1, month: 7, quarter: 14 };

export interface TimelineFields { start: FieldDef | null; end: FieldDef | null }

// The two date fields: `start:` and `end:` if they name date fields, else `start` and `due`; without an end field, the first
// other date field (so a document with a single date still shows markers).
export function timelineFields(board: Board, schema: FieldDef[] = boardSchema(board)): TimelineFields {
    const dates = schema.filter(f => f.type === 'date' && !f.multiple);
    const head = board.head.join('\n');
    const start = dates.find(f => f.key === optionOf(head, 'start')) ?? dates.find(f => f.key === 'start') ?? null;
    const end = dates.find(f => f.key === optionOf(head, 'end')) ?? dates.find(f => f.key === 'due') ?? dates.find(f => f !== start) ?? null;
    return { start, end };
}

export function timelineZoom(board: Board): Zoom {
    const raw = optionOf(board.head.join('\n'), 'zoom')?.toLowerCase();
    return ZOOMS.find(z => z === raw) ?? 'month';
}

export interface TimelineRow {
    at: Position;
    card: Card;
    title: string;
    start: string | null;     // first day of the bar; null: the note has no date at all
    end: string | null;       // last day of the bar (inclusive)
    progress: number | null;  // 0..1 from a `progress` field, 1 for a done note, else null
}

// Progress of a note: its `progress` field if it declares one, 1 if the note is checked, else null.
function progressOf(card: Card, schema: FieldDef[]): number | null {
    const def = schema.find(f => f.key === 'progress' && f.type === 'progress');
    const parsed = def ? readItem(card.text, [def]).fields.progress : undefined;
    if (parsed?.ok && !Array.isArray(parsed.value) && typeof parsed.value === 'object' && 'total' in parsed.value)
        return parsed.value.total ? Math.min(1, parsed.value.done / parsed.value.total) : 0;
    return card.done === true ? 1 : null;
}

export function timelineRows(board: Board, schema: FieldDef[] = boardSchema(board)): TimelineRow[] {
    const { start: startDef, end: endDef } = timelineFields(board, schema);
    const rows: TimelineRow[] = [];
    board.columns.forEach((column, c) => column.cards.forEach((card, index) => {
        const a = startDef ? dateOf(card, startDef)?.date ?? null : null;
        const b = endDef ? dateOf(card, endDef)?.date ?? null : null;
        const first = a ?? b, last = b ?? a;
        const [start, end] = first && last && daysBetween(first, last) < 0 ? [last, first] : [first, last];
        rows.push({ at: { column: c, index }, card, title: readItem(card.text, schema).title, start, end, progress: progressOf(card, schema) });
    }));
    return rows;
}

export interface TimelineRange { start: string; days: number }

// The days the timeline shows: from the Monday of the earliest date (or today) to a few days after the latest, and at
// least four weeks.
export function timelineRange(rows: TimelineRow[], today: string): TimelineRange {
    const dates = rows.flatMap(r => [r.start, r.end]).filter((d): d is string => d !== null);
    dates.push(today);
    const sorted = dates.sort();
    const start = startOfWeek(addDays(sorted[0], -2));
    const days = Math.max(28, daysBetween(start, sorted[sorted.length - 1]) + 8);
    return { start, days: Math.ceil(days / 7) * 7 };
}

// The labelled days of the header: every `TICK_DAYS` days from the start of the range.
export function timelineTicks(range: TimelineRange, zoom: Zoom): { date: string; offset: number }[] {
    const step = TICK_DAYS[zoom];
    return Array.from({ length: Math.ceil(range.days / step) }, (_, i) => ({ date: addDays(range.start, i * step), offset: i * step }));
}

// Where a bar sits: the offset of its first day from the start of the range and its length in days.
export function barSpan(row: TimelineRow, range: TimelineRange): { offset: number; length: number } | null {
    if (!row.start || !row.end) return null;
    return { offset: daysBetween(range.start, row.start), length: daysBetween(row.start, row.end) + 1 };
}

// The note at `at` moved by `days` days: both dates shift (a note with one date shifts that one). A time is kept.
export function shiftRow(board: Board, at: Position, days: number, schema: FieldDef[] = boardSchema(board)): Board {
    if (!days) return board;
    return changeEdges(board, at, schema, days, days);
}

// One edge of the bar moved by `days`; the other stays. The bar never gets shorter than a day.
export function resizeRow(board: Board, at: Position, edge: 'start' | 'end', days: number, schema: FieldDef[] = boardSchema(board)): Board {
    if (!days) return board;
    return edge === 'start' ? changeEdges(board, at, schema, days, 0) : changeEdges(board, at, schema, 0, days);
}

// The date field `def` of the note moved by `days`, written with the time it had; null if the note has no such date.
function moved(card: Card, def: FieldDef | null, days: number): { def: FieldDef; date: string; text: string } | null {
    const value = def ? dateOf(card, def) : null;
    if (!def || !value) return null;
    const date = addDays(value.date, days);
    return { def, date, text: value.time ? `${date} ${value.time}` : date };
}

function changeEdges(board: Board, at: Position, schema: FieldDef[], startBy: number, endBy: number): Board {
    const card = board.columns[at.column]?.cards[at.index];
    if (!card) return board;
    const fields = timelineFields(board, schema);
    const start = moved(card, fields.start, startBy);
    const end = moved(card, fields.end, endBy);
    if (start && end && daysBetween(start.date, end.date) < 0) return board;
    return [start, end].reduce((next, edge) => (edge ? setCardField(next, at, edge.def, edge.text) : next), board);
}

export const isRealDay = (date: string): boolean => dayNumber(date) !== null;
