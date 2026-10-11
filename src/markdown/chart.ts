// What a `layout: chart` document shows: counts and charts over its notes. It never changes the notes. The model is the
// same as a board's or a list's (kanban.ts), so the same file can be shown as any of them.
//
//   ---
//   layout: chart
//   by: created                      ← optional; the date field to count notes per period by (default `created`)
//   group: status                    ← optional; the select field for the donut (default the first select field)
//   period: week                     ← optional; week or month (default week)
//   fields:
//     created: date = today
//     status: select(todo, doing, done)
//   ---
//
// Pure TypeScript without GTK.

import type { FieldDef } from './fields.js';
import { readItem } from './fields.js';
import { optionOf } from './layout.js';
import { boardSchema, type Board, type Card } from './kanban.js';
import { addDays, daysBetween, monthOf, startOfWeek } from './dates.js';
import { dateField, dateOf } from './calendar.js';

export type Period = 'week' | 'month';

export interface Slice { name: string; count: number; color: string | null }   // color: an option color name, if the option has one

export interface ChartData {
    total: number;
    done: number;
    overdue: number;           // not done and past the `due` field
    perPeriod: { start: string; count: number }[];   // `start`: the Monday or the "YYYY-MM-01" the period begins at
    period: Period;
    byGroup: Slice[];          // the notes per value of the group field (a note without a value is "—")
    groupKey: string | null;
    byTag: Slice[];
    averagePerWeek: number;
}

export function chartPeriod(board: Board): Period {
    return optionOf(board.head.join('\n'), 'period')?.toLowerCase() === 'month' ? 'month' : 'week';
}

// The select field for the donut: `group:` if it names a single select field, else the first one.
export function groupField(board: Board, schema: FieldDef[] = boardSchema(board)): FieldDef | null {
    const selects = schema.filter(f => f.type === 'select' && !f.multiple);
    return selects.find(f => f.key === optionOf(board.head.join('\n'), 'group')) ?? selects[0] ?? null;
}

export const NO_VALUE = '—';

type Counted = Map<string, number>;
const bump = (m: Counted, key: string): void => { m.set(key, (m.get(key) ?? 0) + 1); };

// Notes per period of the `by` date field: oldest first, the last twelve periods.
function perPeriod(cards: Card[], by: FieldDef | null, period: Period): { counts: { start: string; count: number }[]; days: string[] } {
    const counts: Counted = new Map();
    const days: string[] = [];
    for (const card of cards) {
        const date = by ? dateOf(card, by)?.date : undefined;
        if (!date) continue;
        days.push(date);
        bump(counts, period === 'week' ? startOfWeek(date) : `${monthOf(date)}-01`);
    }
    const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12);
    return { counts: sorted.map(([start, count]) => ({ start, count })), days: days.sort() };
}

const selectValue = (card: Card, def: FieldDef | null, schema: FieldDef[]): string => {
    const value = def ? readItem(card.text, schema).fields[def.key] : undefined;
    return value?.ok && !Array.isArray(value.value) && typeof value.value === 'string' ? value.value : NO_VALUE;
};

// The notes per value of the group field, in the order of its options, then the biggest first.
function groupSlices(cards: Card[], group: FieldDef | null, schema: FieldDef[]): Slice[] {
    const counts: Counted = new Map();
    for (const card of cards) bump(counts, selectValue(card, group, schema));
    const order = group?.options ?? [];
    return [...counts.entries()]
        .sort(([a, x], [b, y]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || y - x || a.localeCompare(b))
        .map(([name, count]): Slice => ({ name, count, color: group?.colors?.[name] ?? null }));
}

function tagSlices(cards: Card[], schema: FieldDef[]): Slice[] {
    const counts: Counted = new Map();
    for (const card of cards) for (const tag of new Set(readItem(card.text, schema).tags)) bump(counts, tag);
    return [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 8).map(([name, count]): Slice => ({ name: `#${name}`, count, color: null }));
}

// Notes that are not done and whose `due` date has passed.
function overdueCount(cards: Card[], schema: FieldDef[], today: string): number {
    const due = schema.find(f => f.key === 'due' && f.type === 'date');
    return due ? cards.filter(card => card.done !== true && (dateOf(card, due)?.date ?? today) < today).length : 0;
}

export function chartData(board: Board, today: string, schema: FieldDef[] = boardSchema(board)): ChartData {
    const cards = board.columns.flatMap(c => c.cards);
    const period = chartPeriod(board);
    const group = groupField(board, schema);
    const { counts, days } = perPeriod(cards, dateField(board, schema, 'by', 'created'), period);
    const dated = days.length;
    const weeks = dated ? Math.max(1, Math.ceil(daysBetween(startOfWeek(days[0]), addDays(startOfWeek(days[dated - 1]), 7)) / 7)) : 1;
    return {
        total: cards.length,
        done: cards.filter(c => c.done === true).length,
        overdue: overdueCount(cards, schema, today),
        perPeriod: counts, period,
        byGroup: groupSlices(cards, group, schema), groupKey: group?.key ?? null,
        byTag: tagSlices(cards, schema),
        averagePerWeek: Math.round((dated / weeks) * 10) / 10,
    };
}
