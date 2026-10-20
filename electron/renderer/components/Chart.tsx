// The chart page: numbers and charts over the notes. The panels are the ones `charts:` names, in that order; the button
// at the top right moves, removes, and adds panels and picks their fields, and the core writes the list to the frontmatter.
// The charts are SVG drawn here from the model (markdown/chart.ts), so the colors are never the only information.

import { useMemo, useState, type ReactNode } from 'react';
import { barData, chartData, chartItems, dateFields, donutData, NO_VALUE, selectFields, type ChartData, type ChartItem, type Period, type Slice } from '../../../src/markdown/chart.js';
import { boardSchema, type Board } from '../../../src/markdown/kanban.js';
import { Icon } from './Icons.js';
import { dayMonth, formatDate, PageHeader, todayString } from './notes.js';
import { useClient } from '../lib/useClient.js';

const SLICE_COLORS: Record<string, string> = { red: '#e5484d', amber: '#e9a23b', green: '#3fa66b', blue: '#3b7dd8', purple: '#8e5bd6', teal: '#2f8f99', pink: '#c2417a', gray: '#8a8f98' };
const FALLBACK = ['#4c9a6a', '#3b7dd8', '#8e5bd6', '#d6602e', '#c2417a', '#2f8f99', '#8a7a1c', '#5e6c84'];
const NO_VALUE_COLOR = '#c9ccd2';
const BAR_AREA = 120, TAG_BAR = 220, DONUT = 140, RING = 26;
const PANEL_NAMES: Record<ChartItem['kind'], string> = { kpi: 'Numbers', bar: 'Bars', donut: 'Donut', tags: 'Tags' };
const ADDABLE: ChartItem[] = [{ kind: 'kpi' }, { kind: 'bar', field: null, period: null }, { kind: 'donut', field: null }, { kind: 'tags' }];

const colorOf = (slice: Slice, index: number): string => slice.name === NO_VALUE ? NO_VALUE_COLOR : slice.color ? SLICE_COLORS[slice.color] : FALLBACK[index % FALLBACK.length];

function Donut({ slices }: { slices: Slice[] }) {
    const total = slices.reduce((n, s) => n + s.count, 0);
    const radius = DONUT / 2 - RING / 2, c = 2 * Math.PI * radius;
    let offset = 0;
    const summary = slices.map(s => `${s.name}: ${s.count}`).join(', ');
    return (
        <div className="donut">
            <svg width={DONUT} height={DONUT} viewBox={`0 0 ${DONUT} ${DONUT}`} role="img" aria-label={summary}>
                <title>{summary}</title>
                <g transform={`rotate(-90 ${DONUT / 2} ${DONUT / 2})`}>
                    {slices.map((s, i) => {
                        const length = total ? (s.count / total) * c : 0;
                        const circle = <circle key={s.name} cx={DONUT / 2} cy={DONUT / 2} r={radius} fill="none" stroke={colorOf(s, i)} strokeWidth={RING} strokeDasharray={`${length} ${c - length}`} strokeDashoffset={-offset} />;
                        offset += length;
                        return circle;
                    })}
                </g>
                <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="chart-number">{total}</text>
            </svg>
            <ul className="legend">
                {slices.map((s, i) => <li key={s.name}><span className="swatch" style={{ background: colorOf(s, i) }} />{s.name}<span className="dim">{s.count}</span></li>)}
            </ul>
        </div>
    );
}

function Periods({ counts, period }: { counts: { start: string; count: number }[]; period: Period }) {
    if (!counts.length) return <p className="dim">No notes have a date in the “by” field.</p>;
    const max = Math.max(1, ...counts.map(p => p.count));
    return (
        <div className="bars">
            {counts.map(entry => (
                <div key={entry.start} className="bar-col" title={`${entry.start}: ${entry.count}`}>
                    <span className="caption">{entry.count}</span>
                    <div className="chart-bar" style={{ height: Math.max(4, Math.round((entry.count / max) * BAR_AREA)) }} />
                    <span className="dim caption">{period === 'week' ? dayMonth(entry.start) : formatDate(entry.start, { month: 'short', year: 'numeric' })}</span>
                </div>
            ))}
        </div>
    );
}

function Tagbars({ tags }: { tags: Slice[] }) {
    const max = Math.max(1, ...tags.map(t => t.count));
    return (
        <div className="tag-bars">
            {tags.map(tag => (
                <div key={tag.name} className="tag-row"><span>{tag.name}</span><div className="chart-bar" style={{ width: Math.max(4, Math.round((tag.count / max) * TAG_BAR)) }} /><span className="dim">{tag.count}</span></div>
            ))}
        </div>
    );
}

function Kpis({ data }: { data: ChartData }) {
    const items: [string, number, string][] = [['Notes', data.total, ''], ['Done', data.done, 'ok'], ['Overdue', data.overdue, data.overdue ? 'late' : ''], ['Per week', data.averagePerWeek, '']];
    return <div className="kpis">{items.map(([name, value, cls]) => <div key={name} className="card chart-kpi"><span className="dim">{name}</span><span className={`chart-number ${cls}`}>{value}</span></div>)}</div>;
}

export function Chart({ board }: { board: Board }) {
    const client = useClient();
    const schema = useMemo(() => boardSchema(board), [board.head.join('\n')]);   // eslint-disable-line react-hooks/exhaustive-deps
    const [settings, setSettings] = useState(false);
    const items = chartItems(board, schema);
    const data = useMemo(() => chartData(board, todayString(), schema), [board, schema]);
    const commit = (next: ChartItem[] | null) => client.editNotes({ kind: 'charts', items: next });
    const change = (at: number, next: ChartItem | null) => { const list = [...items]; if (next) list[at] = next; else list.splice(at, 1); commit(list); };
    const move = (at: number, by: number) => { const list = [...items]; [list[at], list[at + by]] = [list[at + by], list[at]]; commit(list); };

    const panel = (item: ChartItem, i: number) => {
        if (item.kind === 'kpi') return <Kpis key={i} data={data} />;
        let title: string, body: ReactNode = null;
        if (item.kind === 'tags') {
            if (!data.byTag.length) return null;
            title = 'By tag'; body = <Tagbars tags={data.byTag} />;
        } else if (item.kind === 'bar') {
            const bars = barData(board, item.field, item.period, schema);
            const per = bars.period === 'week' ? 'per week' : 'per month';
            title = bars.field === 'created' || bars.field === null ? `Created ${per}` : `${bars.field} ${per}`;
            body = <Periods counts={bars.counts} period={bars.period} />;
        } else {
            const donut = donutData(board, item.field, schema);
            if (!donut.field) return null;
            title = `By ${donut.field}`; body = <Donut slices={donut.slices} />;
        }
        return <section key={i} className={`card chart-panel panel-${item.kind}`}><h3>{title}</h3>{body}</section>;
    };

    return (
        <div className="layout-page chart" data-page="chart">
            <PageHeader board={board} fallback="Chart">
                <button className={`button settings-toggle${settings ? ' checked' : ''}`} aria-expanded={settings} aria-label="Edit the panels" title="Panels" onClick={() => setSettings(v => !v)}><Icon name="emblem-system" /></button>
            </PageHeader>
            {settings && (
                <div className="chart-settings" role="group" aria-label="Panels">
                    <h3>Panels</h3>
                    {items.map((item, at) => {
                        const bars = item.kind === 'bar' ? barData(board, item.field, item.period, schema) : null;
                        const donut = item.kind === 'donut' ? donutData(board, item.field, schema) : null;
                        return (
                            <div key={at} className="settings-row">
                                <span className="name">{PANEL_NAMES[item.kind]}</span>
                                {item.kind === 'bar' && bars && (
                                    <>
                                        {dateFields(schema).length > 0 && <select aria-label="Date field" value={bars.field ?? ''} onChange={e => change(at, { ...item, field: e.target.value })}>{dateFields(schema).map(f => <option key={f.key}>{f.key}</option>)}</select>}
                                        <select aria-label="Period" value={bars.period} onChange={e => change(at, { ...item, field: bars.field, period: e.target.value as Period })}><option value="week">Week</option><option value="month">Month</option></select>
                                    </>
                                )}
                                {item.kind === 'donut' && donut && selectFields(schema).length > 0 && (
                                    <select aria-label="Select field" value={donut.field ?? ''} onChange={e => change(at, { ...item, field: e.target.value })}>{selectFields(schema).map(f => <option key={f.key}>{f.key}</option>)}</select>
                                )}
                                <button className="icon-button" aria-label="Move up" title="Move up" disabled={at === 0} onClick={() => move(at, -1)}>↑</button>
                                <button className="icon-button" aria-label="Move down" title="Move down" disabled={at === items.length - 1} onClick={() => move(at, 1)}>↓</button>
                                <button className="icon-button" aria-label="Remove" title="Remove" disabled={items.length <= 1} onClick={() => change(at, null)}>−</button>
                            </div>
                        );
                    })}
                    <div className="settings-add">{ADDABLE.map(next => <button key={next.kind} className="button" title={`Add ${PANEL_NAMES[next.kind]}`} onClick={() => commit([...items, next])}>+ {PANEL_NAMES[next.kind]}</button>)}</div>
                    <button className="button flat" onClick={() => commit(null)}>Reset to default</button>
                </div>
            )}
            <div className="chart-body">{items.map(panel)}</div>
        </div>
    );
}
