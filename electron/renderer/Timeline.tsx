// The timeline: a bar per note from its start to its end date. Dragging the bar moves both dates, dragging an edge changes
// one; a click on the bar edits the note. Whole days only: the bar follows the pointer and the dates change on release.

import { useEffect, useMemo, useRef, useState } from 'react';
import { daysBetween } from '../../src/markdown/dates.js';
import { boardSchema, type Board } from '../../src/markdown/kanban.js';
import { barSpan, PIXELS_PER_DAY, timelineRange, timelineRows, timelineTicks, timelineZoom, ZOOMS, type TimelineRow, type Zoom } from '../../src/markdown/timeline.js';
import { dayMonth, formatDate, PageHeader, refOf, todayString, useNoteDialog } from './notes.js';
import { useClient } from './useClient.js';

const ROW_HEIGHT = 34, HEAD_HEIGHT = 30, LABEL_WIDTH = 200, CLICK_SLOP = 4;
const ZOOM_LABEL: Record<Zoom, string> = { week: 'Week', month: 'Month', quarter: 'Quarter' };

type Grab = { row: TimelineRow; mode: 'shift' | 'start' | 'end'; x0: number; dx: number };

export function Timeline({ board }: { board: Board }) {
    const client = useClient();
    const schema = useMemo(() => boardSchema(board), [board.head.join('\n')]);   // eslint-disable-line react-hooks/exhaustive-deps
    const [zoomOverride, setZoomOverride] = useState<Zoom | null>(null);
    const [grab, setGrab] = useState<Grab | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const { node, edit, add } = useNoteDialog(board, schema);
    const head = board.head.join('\n');
    useEffect(() => setZoomOverride(null), [head]);
    const zoom = zoomOverride ?? timelineZoom(board);
    const rows = useMemo(() => timelineRows(board, schema), [board, schema]);
    const today = todayString();
    const range = timelineRange(rows, today);
    const px = PIXELS_PER_DAY[zoom];
    const height = HEAD_HEIGHT + rows.length * ROW_HEIGHT;

    // The view opens at today.
    useEffect(() => { scroller.current?.scrollTo({ left: Math.max(0, daysBetween(range.start, today) * px - 120) }); }, [head, zoom]);   // eslint-disable-line react-hooks/exhaustive-deps

    const finish = (g: Grab) => {
        setGrab(null);
        const days = Math.round(g.dx / px);
        const ref = refOf(g.row.at, g.row.card);
        if (g.mode === 'shift' && Math.abs(g.dx) < CLICK_SLOP) edit(g.row.at);
        else if (days) client.editNotes(g.mode === 'shift' ? { kind: 'shift', ...ref, days } : { kind: 'resize', ...ref, edge: g.mode, days });
    };
    const begin = (row: TimelineRow, mode: Grab['mode']) => (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setGrab({ row, mode, x0: e.clientX, dx: 0 });
    };
    const handlers = (row: TimelineRow, mode: Grab['mode']) => ({
        onPointerDown: begin(row, mode),
        onPointerMove: (e: React.PointerEvent) => { if (grab?.row === row && grab.mode === mode) setGrab({ ...grab, dx: e.clientX - grab.x0 }); },
        onPointerUp: () => { if (grab?.row === row && grab.mode === mode) finish(grab); },
        onPointerCancel: () => setGrab(null),
    });
    const state = (row: TimelineRow) => row.card.done === true ? { css: 'done', text: 'done' } : row.end && row.end < today ? { css: 'late', text: 'past its end date' } : null;
    const offsetToday = daysBetween(range.start, today);

    return (
        <div className="layout-page timeline" data-page="timeline">
            <PageHeader board={board} fallback="Timeline" onNew={() => add()} />
            <div className="timeline-controls">
                <span className="linked">{ZOOMS.map(z => <button key={z} className={`button${zoom === z ? ' checked' : ''}`} aria-pressed={zoom === z} onClick={() => setZoomOverride(z)}>{ZOOM_LABEL[z]}</button>)}</span>
                <button className="button" title="Scroll to today" onClick={() => scroller.current?.scrollTo({ left: Math.max(0, offsetToday * px - 120), behavior: 'smooth' })}>Today</button>
            </div>
            <div className="timeline-chart">
                <div className="timeline-labels" style={{ width: LABEL_WIDTH }}>
                    <div className="timeline-head" style={{ height: HEAD_HEIGHT }}>Notes</div>
                    {rows.map(row => (
                        <button key={`${row.at.column}:${row.at.index}`} className={`timeline-label${row.card.done === true ? ' dim' : ''}`} style={{ height: ROW_HEIGHT }}
                            title={row.start ? undefined : 'This note has no date, so it has no bar.'} onClick={() => edit(row.at)}>{row.title}</button>
                    ))}
                </div>
                <div className="timeline-scroll" ref={scroller}>
                    <div className="timeline-canvas" style={{ width: range.days * px, height }}>
                        {timelineTicks(range, zoom).map(tick => (
                            <div key={tick.date} className="timeline-tick" style={{ left: tick.offset * px, height }}>
                                <span className="timeline-head" style={{ height: HEAD_HEIGHT }}>{zoom === 'week' ? `${formatDate(tick.date, { weekday: 'short' })} ${Number(tick.date.slice(8, 10))}` : dayMonth(tick.date)}</span>
                            </div>
                        ))}
                        {offsetToday >= 0 && offsetToday <= range.days && <div className="timeline-today" title="Today" style={{ left: offsetToday * px, height }} />}
                        {rows.map((row, i) => {
                            const span = barSpan(row, range);
                            if (!span) return null;
                            const g = grab?.row === row ? grab : null;
                            const days = g ? Math.round(g.dx / px) : 0;
                            const left = (span.offset + (g && g.mode !== 'end' ? days : 0)) * px;
                            const width = Math.max(px, (span.length + (g ? (g.mode === 'shift' ? 0 : g.mode === 'start' ? -days : days) : 0)) * px);
                            const s = state(row);
                            const dates = row.start === row.end ? row.start : `${row.start} → ${row.end}`;
                            const title = `${row.title}: ${s ? `${dates} (${s.text})` : dates}`;
                            const pct = row.progress !== null && row.progress < 1 ? ` · ${Math.round(row.progress * 100)}%` : '';
                            return (
                                <div key={`${row.at.column}:${row.at.index}`} className={`timeline-bar${s ? ` ${s.css}` : ''}${g ? ' grabbed' : ''}`} role="img" aria-label={title} title={title}
                                    style={{ left, width, top: HEAD_HEIGHT + i * ROW_HEIGHT + 6, height: ROW_HEIGHT - 12 }}>
                                    {row.progress !== null && row.progress > 0 && <div className="timeline-fill" style={{ width: `${Math.min(1, row.progress) * 100}%` }} />}
                                    <span className="handle start" title="Drag to change the start date" {...handlers(row, 'start')} />
                                    <span className="bar-title" {...handlers(row, 'shift')}>{row.title}{pct}</span>
                                    <span className="handle end" title="Drag to change the end date" {...handlers(row, 'end')} />
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
            {rows.length === 0 && <p className="dim">There are no notes to put on the timeline yet.</p>}
            {node}
        </div>
    );
}
