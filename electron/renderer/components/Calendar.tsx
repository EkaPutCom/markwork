// The calendar: notes on the day of their date field, as a month, a week, or an agenda, with the notes that have no date
// at the side. A note is dragged to a day to give it that date, and to the side panel to take its date away; a double
// click on a day adds a note on it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, addMonths, monthOf, monthWeeks, startOfWeek, weekDays } from '../../../src/markdown/dates';
import { calendarData, type CalendarItem } from '../../../src/markdown/calendar';
import { boardSchema, type Board, type Position } from '../../../src/markdown/kanban';
import { formatDate, PageHeader, refOf, todayString, useNoteDialog } from './notes';
import { useClient } from '../lib/useClient';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { Icon } from './Icons';

type Mode = 'month' | 'week' | 'agenda';
const MODES: [Mode, string][] = [['month', 'Month'], ['week', 'Week'], ['agenda', 'Agenda']];
const MONTH_LIMIT = 3;   // notes shown in a day of the month grid before "+N more"

export function Calendar({ board }: { board: Board }) {
    const client = useClient();
    const schema = useMemo(() => boardSchema(board), [board.head.join('\n')]);   // eslint-disable-line react-hooks/exhaustive-deps
    const data = useMemo(() => calendarData(board, schema), [board, schema]);
    const [mode, setMode] = useState<Mode>('month');
    const [anchor, setAnchor] = useState('');   // a day inside the shown period; '' = today
    const [over, setOver] = useState<string | null>(null);
    const dragged = useRef<Position | null>(null);
    const { node, edit, add } = useNoteDialog(board, schema);
    const head = board.head.join('\n');
    useEffect(() => setAnchor(''), [head]);   // the frontmatter changed: forget the month the view chose
    const today = todayString();
    const day = anchor || today;
    const step = (direction: number) => setAnchor(mode === 'week' ? addDays(day, 7 * direction) : `${addMonths(monthOf(day), direction)}-01`);
    const month = monthOf(day);

    const schedule = (date: string) => {
        const at = dragged.current;
        dragged.current = null;
        setOver(null);
        const card = at && board.columns[at.column]?.cards[at.index];
        if (at && card) client.editNotes({ kind: 'date', ...refOf(at, card), date });
    };
    const target = (key: string, date: string) => data.key ? {
        onDragOver: (e: React.DragEvent) => { if (dragged.current) { e.preventDefault(); if (over !== key) setOver(key); } },
        onDragLeave: () => setOver(o => o === key ? null : o),
        onDrop: (e: React.DragEvent) => { e.preventDefault(); schedule(date); },
    } : {};

    const event = (item: CalendarItem) => {
        const done = item.card.done === true, late = !done && item.date < today;
        const label = (item.time ? `${item.time} ` : '') + item.title;
        return (
            <Button key={`${item.at.column}:${item.at.index}`} variant="ghost" size="xs" className={`calendar-event justify-start${done ? ' done' : late ? ' late' : ''} text-left`} draggable aria-label={label}
                // ui-allow: an event is cut off with an ellipsis; the title is its full name
                title={done ? `${item.title} (done)` : late ? `${item.title} (past its date)` : item.title}
                onDragStart={e => { e.dataTransfer.setData('text/plain', item.card.text); dragged.current = item.at; }} onDragEnd={() => { dragged.current = null; setOver(null); }}
                onClick={e => { e.stopPropagation(); edit(item.at); }}>{label}</Button>
        );
    };
    const cell = (date: string, limit: number) => {
        const items = data.byDate.get(date) ?? [];
        return (
            <div key={date} className={`calendar-day${monthOf(date) !== month ? ' other' : ''}${over === date ? ' drop' : ''}${limit === Infinity ? ' tall' : ''}`} data-date={date}
                title={data.key ? 'Double-click to add a note on this day' : undefined} onDoubleClick={() => data.key && add(date)} {...target(date, date)}>
                <span className={`daynum${date === today ? ' today' : ''}`}>{Number(date.slice(8))}</span>
                {items.slice(0, limit).map(event)}
                {items.length > limit && <Button variant="link" size="xs" className="more h-auto justify-start text-muted-foreground text-left" onClick={e => { e.stopPropagation(); setAnchor(date); setMode('week'); }}>+{items.length - limit} more</Button>}
            </div>
        );
    };
    const grid = (weeks: string[][], limit: number) => (
        <div className="calendar-grid" role="grid">
            {Array.from({ length: 7 }, (_, i) => <div key={i} className="weekday" role="columnheader">{formatDate(addDays(startOfWeek(today), i), { weekday: 'short' })}</div>)}
            {weeks.flat().map(date => cell(date, limit))}
        </div>
    );
    const days = [...data.byDate.keys()].filter(d => monthOf(d) === month).sort();
    const weekRange = weekDays(day);
    const period = mode === 'week'
        ? `${formatDate(weekRange[0], { day: 'numeric', month: 'short' })} – ${formatDate(weekRange[6], { day: 'numeric', month: 'short', year: 'numeric' })}`
        : formatDate(`${month}-01`, { month: 'long', year: 'numeric' });

    return (
        <div className="layout-page calendar" data-page="calendar">
            <PageHeader board={board} fallback="Calendar" onNew={() => add()} />
            <div className="calendar-bar">
                <h2 className="period">{period}</h2>
                <span className="flex">
                    <IconButton variant="outline" size="icon-sm" className="rounded-r-none" label="Previous" onClick={() => step(-1)}><Icon name="go-previous" /></IconButton>
                    <IconButton variant="outline" size="icon-sm" className="rounded-l-none border-l-0" label="Next" onClick={() => step(1)}><Icon name="go-next" /></IconButton>
                </span>
                <Button variant="outline" size="sm" onClick={() => setAnchor('')}>Today</Button>
                <ToggleGroup type="single" variant="outline" size="sm" aria-label="View" value={mode} onValueChange={value => { if (value) setMode(value as typeof mode); }}>
                    {MODES.map(([m, label]) => <ToggleGroupItem key={m} value={m} className="px-3">{label}</ToggleGroupItem>)}
                </ToggleGroup>
            </div>
            <div className="calendar-body">
                <div className="calendar-main">
                    {mode === 'week' ? grid([weekRange], Infinity) : mode === 'agenda' ? (
                        <div className="agenda">
                            {days.length === 0 && <p className="dim">No notes this month.</p>}
                            {days.map(date => (
                                <section key={date}><h3 className={date === today ? 'today' : ''}>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>{(data.byDate.get(date) ?? []).map(event)}</section>
                            ))}
                        </div>
                    ) : grid(monthWeeks(month), MONTH_LIMIT)}
                </div>
                <aside className={`calendar-undated${over === 'undated' ? ' drop' : ''}`} {...target('undated', '')}>
                    <h3>Not scheduled ({data.undated.length})</h3>
                    {!data.key && <p className="dim">Declare a date field in the frontmatter (fields: due: date) to place notes on days.</p>}
                    {data.undated.map(item => (
                        <Button key={`${item.at.column}:${item.at.index}`} variant="outline" size="sm" className="calendar-note justify-start font-normal text-left" draggable onClick={() => edit(item.at)}
                            onDragStart={e => { e.dataTransfer.setData('text/plain', item.card.text); dragged.current = item.at; }} onDragEnd={() => { dragged.current = null; setOver(null); }}>{item.title}</Button>
                    ))}
                    {data.key && <p className="dim caption">Drag a note to a day to schedule it.</p>}
                </aside>
            </div>
            {node}
        </div>
    );
}
