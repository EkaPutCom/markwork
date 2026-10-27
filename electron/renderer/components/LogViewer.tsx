// The agent log: the tree of each turn (model rounds, reasoning, tools) on the left and
// everything about the selected step on the right. It reads the copy of the core's log that the panel keeps (`chat.log`) and
// follows the newest step until the user picks one.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TraceReplica } from '../../../src/agent/tracefeed';
import { AgentTrace, type TraceEvent, type TraceKind } from '../../../src/agent/trace';
import { descendants, formatCount, formatMs, formatSize, traceStats, traceTree, turnEvents, type TraceNode } from '../../../src/agent/tracetree';
import { LOG_HEADERS, settledNewest, visibleSteps } from '../../../src/agent/logrows';
import { Icon } from './Icons';
import { Modal } from './Modals';
import { useChat, useClient, useStore } from '../lib/useClient';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

const FILTERS: [string, TraceKind[]][] = [['All', []], ['Tools', ['tool']], ['Reasoning', ['reasoning']], ['Model', ['round', 'text']]];
const KIND_NAME: Record<TraceKind, string> = { turn: 'Question', round: 'Model round', reasoning: 'Reasoning', text: 'Answer', tool: 'Tool call', usage: 'Usage', note: 'Note', error: 'Error' };

function rowLabel(e: TraceEvent): string {
    if (e.kind === 'round') return `Round ${e.round ?? ''}`;
    if (e.kind === 'reasoning') return 'Reasoning';
    if (e.kind === 'text') return 'Answer';
    return e.title.replace(/^(New turn|Tool): /, '');
}

const rowMeta = (e: TraceEvent): string => e.ms !== undefined ? formatMs(e.ms) : e.status === 'running' ? '…' : e.time.slice(11);

type Metric = [value: string, caption: string];
const duration = (e: TraceEvent): string => e.ms !== undefined ? formatMs(e.ms) : e.status === 'running' ? '…' : '–';

function metricsOf(e: TraceEvent, nodes: TraceNode[]): Metric[] {
    if (e.kind === 'tool') {
        const busy = traceStats(turnEvents(nodes, e.seq)).ms;
        const share = e.ms !== undefined && busy > 0 ? `${Math.max(1, Math.round(e.ms / busy * 100))}%` : '–';
        return [[duration(e), 'Duration'], [formatSize((e.result ?? '').length), 'Result size'], [share, 'Of the turn’s time'], [`#${e.seq}`, 'Event']];
    }
    if (e.kind === 'round') {
        const tools = descendants(nodes, e.seq).filter(x => x.kind === 'tool').length, u = e.usage;
        return [[duration(e), 'Model time'], [u ? formatCount(u.prompt) : '–', u ? `Tokens in (${formatCount(u.cached)} cached)` : 'Tokens in'], [u ? formatCount(u.completion) : '–', 'Tokens out'], [`${tools}`, 'Tool calls']];
    }
    if (e.kind === 'turn') {
        const s = traceStats(turnEvents(nodes, e.seq));
        return [[formatMs(s.ms), 'Model and tools'], [`${s.rounds}`, 'Rounds'], [`${s.tools}${s.failed ? ` · ${s.failed} ✗` : ''}`, 'Tool calls'], [`${formatCount(s.prompt)} / ${formatCount(s.completion)}`, 'Tokens in / out']];
    }
    return [[e.time.slice(11), 'Time'], [e.round !== undefined ? `${e.round}` : '–', 'Round'], [formatSize((e.detail + (e.result ?? '')).length), 'Size'], [`#${e.seq}`, 'Event']];
}

const preview = (text: string, lines: number): string => {
    const all = text.split('\n');
    return all.length > lines ? `${all.slice(0, lines).join('\n')}\n…` : text;
};

type Tab = 'summary' | 'args' | 'result' | 'raw';

function Detail({ event, nodes }: { event: TraceEvent | null; nodes: TraceNode[] }) {
    const [tab, setTab] = useState<Tab>('summary');
    const seq = event?.seq;
    useEffect(() => { setTab('summary'); }, [seq]);
    if (!event) return <div className="log-detail empty"><b>Nothing selected</b><span className="side-meta">Choose a step on the left to see its details.</span></div>;
    const tool = event.kind === 'tool';
    const name = tool ? event.title.replace(/^Tool: /, '') : event.kind === 'turn' ? event.title.replace(/^New turn: /, '') : ['round', 'reasoning', 'text'].includes(event.kind) ? KIND_NAME[event.kind] : event.title;
    const state = event.status === 'running' ? 'Running…' : event.status === 'failed' ? 'Failed' : event.status === 'ok' ? 'Done' : '';
    const copy = (text: string) => void navigator.clipboard.writeText(text);
    const blocks: [string, string][] = [
        ['Context sent', (event.items ?? []).map(i => `• ${i}`).join('\n')],
        ['Arguments', tool ? preview(event.args ?? '', 20) : ''],
        ['Result (preview)', tool ? preview(event.result ?? '', 12) : ''],
        ['Details', event.detail],
    ];
    const tabs: [Tab, string][] = [['summary', 'Summary'], ...tool ? [['args', 'Arguments'], ['result', 'Result']] as [Tab, string][] : [], ['raw', 'Raw']];
    return (
        <div className="log-detail">
            <div className="head">
                <b className="name">{name}</b>
                {state && <Badge variant="secondary" className={`note-chip ${event.status}`}>{state}</Badge>}
                <span className="side-meta">{KIND_NAME[event.kind]}{event.round !== undefined && event.kind !== 'round' ? ` · round ${event.round}` : ''} · {event.time.slice(11)}</span>
            </div>
            <div className="metrics">{metricsOf(event, nodes).map(([value, caption]) => <div key={caption} className="metric"><b>{value}</b><span className="side-meta">{caption}</span></div>)}</div>
            <Tabs value={tab} onValueChange={value => setTab(value as Tab)} className="contents">
                <TabsList className="self-start">{tabs.map(([id, label]) => <TabsTrigger key={id} value={id}>{label}</TabsTrigger>)}</TabsList>
                <TabsContent value={tab} className="page">
                    {tab === 'summary' && blocks.filter(([, text]) => text).map(([caption, text]) => <div key={caption}><div className="side-meta">{caption}</div><pre>{text}</pre></div>)}
                    {tab === 'args' && <pre>{event.args || '(no arguments)'}</pre>}
                    {tab === 'result' && <pre>{event.result || (event.status === 'running' ? 'Waiting for the result…' : '(empty)')}</pre>}
                    {tab === 'raw' && <pre>{AgentTrace.format(event)}</pre>}
                </TabsContent>
            </Tabs>
            <div className="actions">
                {tool && <Button variant="outline" size="sm" onClick={() => copy(event.args ?? '')}>Copy arguments</Button>}
                {tool && <Button variant="outline" size="sm" onClick={() => copy(event.result ?? '')}>Copy result</Button>}
                <Button variant="outline" size="sm" onClick={() => copy(AgentTrace.format(event))}>Copy event</Button>
            </div>
        </div>
    );
}

// The tree and the detail of one log. `rev` changes whenever the log does, so the tree is built again.
export function LogPanel({ log, rev, empty }: { log: TraceReplica; rev: number; empty: string }) {
    const [filter, setFilter] = useState(0);
    const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
    const [picked, setPicked] = useState<number | null>(null);   // a step the user chose: the log stops following the newest
    const list = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const nodes = useMemo(() => traceTree(log.events), [log, rev]);   // eslint-disable-line react-hooks/exhaustive-deps
    const kinds = FILTERS[filter][1];
    const shown = useMemo(() => visibleSteps(nodes, kinds, collapsed), [nodes, kinds, collapsed]);
    const newest = settledNewest(nodes, shown);
    const selected = picked !== null && nodes.some(n => n.event.seq === picked) ? picked : newest;
    const event = nodes.find(n => n.event.seq === selected)?.event ?? null;
    useLayoutEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; });

    const rounds = log.events.filter(e => e.kind === 'round').length, tools = log.events.filter(e => e.kind === 'tool').length;
    const toggle = (seq: number) => setCollapsed(c => { const next = new Set(c); if (!next.delete(seq)) next.add(seq); return next; });
    return (
        <div className="log">
            <div className="log-bar">
                <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(log.text())}>Copy all</Button>
                <Button variant="outline" size="sm" onClick={() => { setPicked(null); log.clear(); }}>Clear</Button>
                <ToggleGroup type="single" variant="outline" size="sm" className="filters" aria-label="Show" value={String(filter)} onValueChange={value => { if (value) setFilter(Number(value)); }}>
                    {FILTERS.map(([label], i) => <ToggleGroupItem key={label} value={String(i)} className="px-3">{label}</ToggleGroupItem>)}
                </ToggleGroup>
                <span className="side-meta summary">{log.events.length ? `${rounds} model rounds · ${tools} tool calls` : empty}</span>
            </div>
            <div className="log-body">
                <div className="log-tree" ref={list} role="tree" aria-label="Steps"
                    onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24; }}>
                    {nodes.filter(n => shown.has(n.event.seq)).map(n => {
                        const e = n.event, header = LOG_HEADERS.has(e.kind);
                        return (
                            <div key={e.seq} role="treeitem" aria-selected={e.seq === selected} aria-level={n.depth + 1} tabIndex={0}
                                className={`step ${e.kind}${e.seq === selected ? ' selected' : ''}${e.status === 'failed' ? ' failed' : ''}`} style={{ paddingLeft: 4 + n.depth * 14 }}
                                onClick={() => setPicked(e.seq === newest ? null : e.seq)} onKeyDown={ev => { if (ev.key === 'Enter') setPicked(e.seq === newest ? null : e.seq); }}>
                                {header ? <IconButton size="icon-xs" className="size-5" label={collapsed.has(e.seq) ? 'Expand' : 'Collapse'} aria-expanded={!collapsed.has(e.seq)}
                                    onClick={ev => { ev.stopPropagation(); toggle(e.seq); }}><Icon name={collapsed.has(e.seq) ? 'pan-end' : 'pan-down'} size={12} /></IconButton> : <span className="gap" />}
                                <span className="label">{rowLabel(e)}{e.status === 'failed' ? ' — failed' : ''}</span>
                                <span className="side-meta">{rowMeta(e)}</span>
                            </div>
                        );
                    })}
                </div>
                <Detail event={event} nodes={nodes} />
            </div>
        </div>
    );
}

// The Assistant's log, a window of its own.
export function LogViewer() {
    const client = useClient();
    const { logOpen, logRev } = useChat();
    if (!logOpen) return null;
    return (
        <Modal title="Agent log" onClose={() => client.chat.openLog(false)} wide>
            <LogPanel log={client.chat.log} rev={logRev} empty="No activity yet. Send a question to the Assistant." />
        </Modal>
    );
}

// The log of an agent run (View Log in a card's menu): the window opened last, in front.
export function RunLogs() {
    const client = useClient();
    const { runLogs } = useStore();
    const front = runLogs.at(-1);
    if (!front) return null;
    return (
        <Modal key={front.run} title={front.title} onClose={() => client.closeRunLog(front.run)} wide>
            <LogPanel log={front.log} rev={front.rev} empty="No activity yet." />
        </Modal>
    );
}
