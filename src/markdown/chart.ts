// What a `layout: chart` document shows: counts and charts over its notes. It never changes the notes. The model is the
// same as a board's or a list's (kanban.ts), so the same file can be shown as any of them.
//
//   ---
//   layout: chart
//   by: created                      ← optional; the date field to count notes per period by (default `created`)
//   group: status                    ← optional; the select field for the donut (default the first select field)
//   period: week                     ← optional; week or month (default week)
//   charts: [kpi, bar, donut:status, tags]   ← optional; which panels to show, in order (default: kpi, bar, donut, tags)
//   fields:
//     created: date = today
//     status: select(todo, doing, done)
//   ---
//
// `charts:` names the panels: `kpi` (the four numbers), `bar` (notes per period of a date field: `bar:due`,
// `bar:due:month`), `donut` (notes per value of a select field: `donut:priority`), and `tags`. `bar` and `donut` without
// a field use `by:` and `group:`. A name that is none of those, or a field that does not fit, is left out.
//
// Pure TypeScript.

import type { FieldDef } from './fields';
import { readItem } from './fields';
import { optionOf, withOption } from './layout';
import { boardSchema, type Board, type Card } from './kanban';
import { addDays, daysBetween, monthOf, startOfWeek } from './dates';
import { dateField, dateOf } from './calendar';

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

export type ChartItem =
    | { kind: 'kpi' }
    | { kind: 'tags' }
    | { kind: 'bar'; field: string | null; period: Period | null }
    | { kind: 'donut'; field: string | null };

export const DEFAULT_CHARTS: readonly ChartItem[] = [
    { kind: 'kpi' }, { kind: 'bar', field: null, period: null }, { kind: 'donut', field: null }, { kind: 'tags' },
];

// The date fields a bar can count by and the select fields a donut can split by.
export const dateFields = (schema: FieldDef[]): FieldDef[] => schema.filter(f => f.type === 'date' && !f.multiple);
export const selectFields = (schema: FieldDef[]): FieldDef[] => schema.filter(f => f.type === 'select' && !f.multiple);

// One entry of `charts:` as text, the way it is written in the frontmatter.
export function chartItemText(item: ChartItem): string {
    if (item.kind === 'bar') return item.period ? `bar:${item.field ?? ''}:${item.period}` : item.field ? `bar:${item.field}` : 'bar';
    if (item.kind === 'donut') return item.field ? `donut:${item.field}` : 'donut';
    return item.kind;
}

function parseItem(raw: string, schema: FieldDef[]): ChartItem | null {
    const [kind, field, period] = raw.split(':').map(p => p.trim());
    if (kind === 'kpi' || kind === 'tags') return field === undefined ? { kind } : null;
    if (kind === 'bar') {
        if (field && !dateFields(schema).some(f => f.key === field)) return null;
        return { kind, field: field || null, period: period === 'week' || period === 'month' ? period : null };
    }
    if (kind === 'donut') return !field || selectFields(schema).some(f => f.key === field) ? { kind, field: field || null } : null;
    return null;
}

// The panels to show, in order: `charts:` if it names any, else the default four. Names are lowercase; a panel may
// be named more than once (two donuts over two fields).
export function chartItems(board: Board, schema: FieldDef[] = boardSchema(board)): ChartItem[] {
    const listed = optionOf(board.head.join('\n'), 'charts');
    if (listed === null) return [...DEFAULT_CHARTS];
    const items = listed.replace(/^\[|\]$/g, '').split(',').map(n => n.trim().toLowerCase()).filter(Boolean)
        .map(n => parseItem(n, schema)).filter((i): i is ChartItem => i !== null);
    return items.length ? items : [...DEFAULT_CHARTS];
}

// The board with `charts:` written from `items` (null, or the default four, removes it). Nothing else changes.
export function withCharts(board: Board, items: ChartItem[] | null): Board {
    const same = items !== null && items.length === DEFAULT_CHARTS.length && items.every((item, i) => chartItemText(item) === chartItemText(DEFAULT_CHARTS[i]));
    const head = board.head.join('\n');
    const next = withOption(head, 'charts', items === null || same ? null : `[${items.map(chartItemText).join(', ')}]`);
    return next === head ? board : { ...board, head: next.split('\n') };
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

// The notes per period of the date field `key` (null: the one `by:` names, else `created`), for a panel.
export function barData(board: Board, key: string | null, period: Period | null, schema: FieldDef[] = boardSchema(board)): { field: string | null; period: Period; counts: { start: string; count: number }[] } {
    const by = (key ? dateFields(schema).find(f => f.key === key) : null) ?? dateField(board, schema, 'by', 'created');
    const chosen = period ?? chartPeriod(board);
    return { field: by?.key ?? null, period: chosen, counts: perPeriod(board.columns.flatMap(c => c.cards), by, chosen).counts };
}

// The notes per value of the select field `key` (null: the one `group:` names), for a panel.
export function donutData(board: Board, key: string | null, schema: FieldDef[] = boardSchema(board)): { field: string | null; slices: Slice[] } {
    const group = (key ? selectFields(schema).find(f => f.key === key) : null) ?? groupField(board, schema);
    return { field: group?.key ?? null, slices: groupSlices(board.columns.flatMap(c => c.cards), group, schema) };
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
