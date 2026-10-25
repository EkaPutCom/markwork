// The Editor Inspector (docs/design/debugger.md, docs/design/shadcn/Debugger.html), in dev mode only: the focused pane's
// text as the file holds it, with what the visual editor hides, draws as a widget, or keeps the cursor out of; the
// transactions the recorder kept; the decorations around the cursor; and what the checks found. It only reads the editor.

import { useEffect, useMemo, useReducer, useState, type CSSProperties, type ReactNode } from 'react';
import type { ChangeSet, EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { recordingOf, type Finding, type Recording, type TxEntry } from '../lib/inspect/recorder.js';
import { snapshot, type Snapshot } from '../lib/inspect/snapshot.js';
import { CHECKS, stateAfter } from '../lib/inspect/checks.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Icon } from './Icons.js';
import { NO_REPLAY, Replay, type ReplayState } from './InspectorReplay.js';
import { entryJSON } from '../lib/inspect/bridge.js';
import { Button } from '../ui/button.js';
import { IconButton } from '../ui/icon-button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';

const AROUND = 12;   // lines shown above and below the cursor's

type DockTab = 'tx' | 'deco' | 'checks' | 'replay';

const copy = (text: string) => navigator.clipboard.writeText(text);

// Redraws on each change of the recording, at most once a frame.
function useRecording(recording: Recording | null): void {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        if (!recording) return;
        let frame = 0;
        const off = recording.subscribe(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; bump(); }); });
        return () => { off(); cancelAnimationFrame(frame); };
    }, [recording]);
}

// The text before entry `n`: the recording's start with the entries before it applied.
function docBefore(recording: Recording, n: number): Text {
    let doc = recording.base.doc;
    for (const e of recording.entries) { if (e.n >= n) break; doc = e.changes.apply(doc); }
    return doc;
}

interface Edit { from: number; to: number; removed: string; inserted: string }
function editsOf(changes: ChangeSet, doc: Text): Edit[] {
    const edits: Edit[] = [];
    changes.iterChanges((from, to, _fb, _tb, inserted) => edits.push({ from, to, removed: doc.sliceString(from, to), inserted: inserted.toString() }));
    return edits;
}

const show = (text: string) => JSON.stringify(text.length > 30 ? `${text.slice(0, 27)}…` : text);
const changeLabel = (edits: Edit[]) => edits.length === 0 ? '—'
    : edits.map(e => e.removed && e.inserted ? `${e.from}–${e.to} → ${show(e.inserted)}` : e.inserted ? `+${show(e.inserted)} @${e.from}` : `−${show(e.removed)} ${e.from}–${e.to}`).join(', ');
const selLabel = (e: TxEntry) => {
    const at = (s: TxEntry['before']) => s.ranges.map(r => r.empty ? `${r.head}` : `${r.anchor}–${r.head}`).join(' ');
    const a = at(e.before), b = at(e.after);
    return a === b ? a : `${a} → ${b}`;
};
const eventKind = (event: string | null) => !event ? '' : event.startsWith('input') ? 'input' : event.startsWith('delete') ? 'delete' : event.startsWith('select') ? 'select' : '';
const inputLabel = (e: TxEntry) => !e.input ? '' : e.input.kind === 'key' ? [e.input.mods, e.input.key].filter(Boolean).join('+') : e.input.kind;
const worst = (findings: Finding[] | null) => findings?.some(f => f.severity === 'fail') ? 'fail' : findings?.length ? 'warn' : null;

// One line of the source: its text cut where a hidden range, a replacing widget, the prefix, or the cursor starts or ends.
// The range under the pointer on one side, to find on the other: a piece of the source, a place in the editor.
interface Hover { hot: number | null; onHover: (range: [number, number] | null) => void }

function SourceLine({ state, snap, n, replaced, hot, onHover }: { state: EditorState; snap: Snapshot; n: number; replaced: [number, number][] } & Hover) {
    const line = state.doc.line(n);
    const prefixEnd = snap.prefixes.find(([from]) => from === line.from)?.[1];
    const head = snap.cursor.pos;
    const cuts = new Set([line.from, line.to]);
    const inside = (p: number) => p > line.from && p < line.to && cuts.add(p);
    for (const [a, b] of [...snap.hidden, ...replaced]) { inside(a); inside(b); }
    if (prefixEnd !== undefined) inside(prefixEnd);
    inside(head);
    const points = [...cuts].sort((a, b) => a - b);
    const parts: ReactNode[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        if (a === head) parts.push(<span key={`c${a}`} className="ins-caret" />);
        const hidden = snap.hidden.some(([x, y]) => a >= x && b <= y);
        const widget = replaced.some(([x, y]) => a >= x && b <= y);
        const prefix = prefixEnd !== undefined && b <= prefixEnd;
        const cls = [hidden && 'ins-hidden', widget && 'ins-widget', prefix && 'ins-prefix'].filter(Boolean).join(' ');
        const lit = hot !== null && a <= hot && hot < b;
        parts.push(<span key={a} className={[cls, lit && 'hot'].filter(Boolean).join(' ') || undefined} title={`${a}–${b}`}
            onMouseEnter={() => onHover([a, b])} onMouseLeave={() => onHover(null)}>{state.doc.sliceString(a, b)}</span>);
    }
    if (head === line.to && head >= line.from) parts.push(<span key="end" className="ins-caret" />);
    return (
        <div className={`ins-line${n === snap.cursor.line ? ' current' : ''}`}>
            <span className="ins-gutter"><b>{n}</b>{line.from}</span>
            <span className="ins-text">{parts}</span>
        </div>
    );
}

function Source({ state, snap, hot, onHover }: { state: EditorState; snap: Snapshot } & Hover) {
    const first = Math.max(1, snap.cursor.line - AROUND), last = Math.min(snap.lines, snap.cursor.line + AROUND);
    const replaced = snap.decorations.filter(d => d.kind === 'replace' && d.what).map(d => [d.from, d.to] as [number, number]);
    return (
        <div className="ins-source" aria-label="Source">
            {Array.from({ length: last - first + 1 }, (_, i) => <SourceLine key={first + i} state={state} snap={snap} n={first + i} replaced={replaced} hot={hot} onHover={onHover} />)}
        </div>
    );
}

// What a transaction's detail offers: the text as the one before it left it (Paused), a test made from the recording,
// and the transaction as the bridge gives it to a script.
interface TxActions { before: (() => void) | null; test: () => void }

function TxDetail({ recording, entry, actions }: { recording: Recording; entry: TxEntry; actions: TxActions }) {
    const edits = editsOf(entry.changes, docBefore(recording, entry.n));
    const [copied, setCopied] = useState(false);
    return (
        <div className="ins-detail">
            <h4>#{entry.n} <span className={`ins-ev ${eventKind(entry.userEvent)}`}>{entry.userEvent ?? 'no user event'}</span></h4>
            {entry.findings?.map((f, i) => (
                <div key={i} className={`ins-finding ${f.severity}`}><b>{f.check}</b> {f.message}</div>
            ))}
            {entry.findings?.length === 0 && <p className="dim">All checks pass.</p>}
            <dl>
                <dt>input</dt><dd>{inputLabel(entry) || '—'}</dd>
                <dt>handler</dt><dd>{entry.handler ?? '—'}</dd>
                <dt>selection</dt><dd>{selLabel(entry)}</dd>
                <dt>effects</dt><dd>{entry.effects.join(', ') || '—'}</dd>
            </dl>
            {entry.trace?.map((line, i) => <p key={i} className="ins-trace">{line}</p>)}
            {edits.map((e, i) => (
                <div key={i} className="ins-diff">
                    <span className="dim">{e.from}–{e.to}</span>
                    {e.removed && <del>{e.removed}</del>}
                    {e.inserted && <ins>{e.inserted}</ins>}
                </div>
            ))}
            <div className="ins-acts">
                <Button variant="outline" size="xs" disabled={!actions.before} title={actions.before ? undefined : 'Dev mode keeps no state from before the first transaction it saw'} onClick={() => actions.before?.()}>Show the State Before</Button>
                <Button variant="outline" size="xs" onClick={actions.test}>Make a Test from This</Button>
                <Button variant="outline" size="xs" onClick={() => void copy(JSON.stringify(entryJSON(entry), null, 2)).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy as JSON'}</Button>
            </div>
        </div>
    );
}

function Transactions({ recording, picked, pick, actions }: { recording: Recording; picked: number | null; pick: (n: number) => void; actions: (entry: TxEntry) => TxActions }) {
    const rows = recording.entries.slice(-200).reverse();
    // The text before each entry, walking forward once (the recording only grows at its end and drops at its start).
    const first = recording.entries[0]?.n, count = recording.entries.length;
    const docs = useMemo(() => {
        const map = new Map<number, Text>();
        let doc = recording.base.doc;
        for (const e of recording.entries) { map.set(e.n, doc); doc = e.changes.apply(doc); }
        return map;
    }, [recording, first, count]);
    const entry = recording.entries.find(e => e.n === picked) ?? null;
    return (
        <>
            <div className="ins-list">
                <table>
                    <thead><tr><th>#</th><th>Event</th><th>Input</th><th>Change</th><th>Selection</th></tr></thead>
                    <tbody>
                        {rows.map(e => (
                            <tr key={e.n} className={[e.n === picked && 'picked', worst(e.findings)].filter(Boolean).join(' ')} onClick={() => pick(e.n)}>
                                <td>{e.n}</td>
                                <td><span className={`ins-ev ${eventKind(e.userEvent)}`}>{e.userEvent ?? (e.effects.join(', ') || '—')}</span></td>
                                <td>{inputLabel(e)}</td>
                                <td>{changeLabel(editsOf(e.changes, docs.get(e.n) ?? recording.base.doc))}</td>
                                <td>{selLabel(e)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {!rows.length && <p className="dim ins-empty">Nothing recorded yet. Type in the editor.</p>}
            </div>
            {entry && <TxDetail key={entry.n} recording={recording} entry={entry} actions={actions(entry)} />}
        </>
    );
}

function Decorations({ state, snap }: { state: EditorState; snap: Snapshot }) {
    return (
        <div className="ins-list wide">
            <table>
                <thead><tr><th>Range</th><th>Kind</th><th>Made by</th><th>Text under it</th></tr></thead>
                <tbody>
                    {snap.decorations.filter(d => d.kind !== 'line').map((d, i) => (
                        <tr key={i}>
                            <td>{d.from}–{d.to}</td>
                            <td><span className={`ins-ev ${d.kind}`}>{d.kind}{d.block ? ' block' : ''}</span></td>
                            <td>{d.what || 'hidden'}</td>
                            <td>{show(state.sliceDoc(d.from, d.to))}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Checks({ recording, open }: { recording: Recording; open: (n: number) => void }) {
    const found = recording.entries.flatMap(e => (e.findings ?? []).map(f => ({ ...f, n: e.n })));
    const checked = recording.entries.filter(e => e.findings).length;
    return (
        <div className="ins-list wide">
            {CHECKS.map(({ name }) => {
                const mine = found.filter(f => f.check === name), bad = mine.find(f => f.severity === 'fail') ?? mine[0];
                return (
                    <div key={name} className="ins-check">
                        <span className={`ins-state ${bad?.severity ?? 'ok'}`}>{bad ? (bad.severity === 'fail' ? '!' : '?') : '✓'}</span>
                        <div className="grow">
                            <b>{name}</b>
                            <small>{bad ? `#${bad.n}: ${bad.message}` : `${checked} transactions checked`}{mine.length > 1 ? ` (and ${mine.length - 1} more)` : ''}</small>
                        </div>
                        {bad && <Button variant="outline" size="xs" onClick={() => open(bad.n)}>Show #{bad.n}</Button>}
                    </div>
                );
            })}
        </div>
    );
}

// Where a range of the text is drawn in the editor, as a box in the window: a hidden range has no width, so it is a bar.
function boxOf(view: EditorView, [from, to]: [number, number]): CSSProperties | null {
    const a = view.coordsAtPos(from, 1), b = view.coordsAtPos(to, -1);
    if (!a) return null;
    const oneLine = b && Math.abs(b.top - a.top) < 2;
    return { left: a.left - 1, top: a.top, width: oneLine ? Math.max(3, b.left - a.left + 2) : 3, height: a.bottom - a.top };
}

export function Inspector({ onClose }: { onClose: () => void }) {
    const client = useClient();
    const store = useStore();   // a switch of pane or tab draws it again
    const editor = client.currentEditor;
    const [, refresh] = useReducer((n: number) => n + 1, 0);
    const [tab, setTab] = useState<DockTab>('tx');
    const [picked, setPicked] = useState<number | null>(null);
    // Paused: the text as transaction `paused` left it, from the states dev mode keeps (checks.ts stateAfter).
    const [paused, setPaused] = useState<number | null>(null);
    const [flash, setFlash] = useState<[number, number] | null>(null);
    const [hot, setHot] = useState<number | null>(null);
    const [replay, setReplayState] = useState<ReplayState>(NO_REPLAY);
    const setReplay = (change: Partial<ReplayState>) => setReplayState(old => ({ ...old, ...change }));
    const [copiedSnapshot, setCopiedSnapshot] = useState(false);
    const view = editor?.view ?? null;
    const recording = view ? recordingOf(view.state) : null;
    useRecording(recording);
    // A selection that moves without a recorded change (setState on a tab switch) is caught on the next frame.
    useEffect(() => { const timer = setInterval(refresh, 500); return () => clearInterval(timer); }, []);
    // The picture of the hidden parts in the editor itself: widgets get an outline. On the editor's host, since CodeMirror
    // sets the class of its own element again on each update.
    useEffect(() => {
        const host = view?.dom.parentElement;
        host?.classList.add('inspecting');
        return () => host?.classList.remove('inspecting');
    }, [view]);

    // The place in the editor under the pointer, found in the source (live only: a paused text is another text).
    useEffect(() => {
        if (!view || paused !== null) return;
        let frame = 0, last: MouseEvent | null = null;
        const move = (e: MouseEvent) => {
            last = e;
            if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (last) setHot(view.posAtCoords({ x: last.clientX, y: last.clientY })); });
        };
        const leave = () => { last = null; setHot(null); };
        view.contentDOM.addEventListener('mousemove', move);
        view.contentDOM.addEventListener('mouseleave', leave);
        return () => { cancelAnimationFrame(frame); view.contentDOM.removeEventListener('mousemove', move); view.contentDOM.removeEventListener('mouseleave', leave); setHot(null); };
    }, [view, paused]);

    const steps = recording?.entries.filter(e => stateAfter(e)) ?? [];
    const at = paused === null ? -1 : steps.findIndex(e => e.n === paused);
    const pausedState = at >= 0 ? stateAfter(steps[at]) : null;
    const live = !pausedState;
    const state = pausedState ?? view?.state ?? null;
    const pause = (n: number | undefined) => { if (n === undefined) return; setPaused(n); setPicked(n); setFlash(null); };
    const pick = (n: number) => { setPicked(n); if (!live) pause(n); };
    const snap = state ? snapshot(state, Math.max(1, state.doc.lineAt(state.selection.main.head).number - AROUND), state.doc.lineAt(state.selection.main.head).number + AROUND) : null;
    const failing = recording?.entries.filter(e => worst(e.findings) === 'fail').length ?? 0;
    const tabName = store.tabs.find(t => t.id === store.active)?.name;
    const open = (n: number) => { setTab('tx'); pick(n); };
    // The state the transaction before `entry` left (dev mode keeps one for each it saw).
    const txActions = (entry: TxEntry): TxActions => {
        const before = steps.filter(e => e.n < entry.n).at(-1);
        return { before: before ? () => pause(before.n) : null, test: () => { setReplay({ repro: null, label: '', message: null }); setTab('replay'); } };
    };
    const copySnapshot = () => {
        if (!snap) return;
        void copy(JSON.stringify({ tab: tabName ?? null, pane: store.panes.current, paused: live ? null : steps[at]?.n, ...snap }, null, 2)).then(() => {
            setCopiedSnapshot(true);
            setTimeout(() => setCopiedSnapshot(false), 1500);
        });
    };
    const flashBox = live && flash && view ? boxOf(view, flash) : null;

    return (
        <section className="inspector" aria-label="Editor Inspector">
            <header>
                <Icon name="search" />
                <b>Editor Inspector</b>
                {tabName && <span className="dim ins-where">{tabName} · pane {store.panes.current}</span>}
                {recording && <span className="ins-badge">{recording.entries.length} transactions</span>}
                {failing > 0 && <span className="ins-badge fail">{failing} failed {failing === 1 ? 'check' : 'checks'}</span>}
                <span className="grow" />
                {recording && (
                    <ToggleGroup type="single" size="xs" className="ins-seg gap-0.5 rounded-md bg-muted p-0.5" aria-label="Live or paused" value={live ? 'live' : 'paused'}
                        onValueChange={value => { if (value === 'live') setPaused(null); else if (value === 'paused') pause(steps[steps.length - 1]?.n); }}>
                        <ToggleGroupItem value="live" className="h-6 rounded-sm px-2 aria-checked:bg-background aria-checked:shadow-xs">Live</ToggleGroupItem>
                        <ToggleGroupItem value="paused" className="h-6 rounded-sm px-2 aria-checked:bg-background aria-checked:shadow-xs" disabled={!steps.length}>Paused</ToggleGroupItem>
                    </ToggleGroup>
                )}
                {!live && <>
                    <IconButton size="icon-xs" label="Step back" disabled={at <= 0} onClick={() => pause(steps[at - 1]?.n)}><Icon name="go-previous" /></IconButton>
                    <span className="ins-badge">#{steps[at].n} of {steps[steps.length - 1].n}</span>
                    <IconButton size="icon-xs" label="Step forward" disabled={at >= steps.length - 1} onClick={() => pause(steps[at + 1]?.n)}><Icon name="go-next" /></IconButton>
                </>}
                {snap && <Button variant="ghost" size="xs" className="ins-copy" onClick={copySnapshot}>{copiedSnapshot ? 'Copied' : 'Copy Snapshot'}</Button>}
                <IconButton size="icon-xs" label="Close the inspector" shortcut="Ctrl+Alt+I" onClick={onClose}><Icon name="window-close" /></IconButton>
            </header>
            {!state || !snap || !recording ? <p className="dim ins-empty">No text is open in this pane.</p> : (
                <div className="ins-body">
                    <div className="ins-left">
                        <div className="ins-head">
                            <b>Source</b>
                            <span className="ins-key hidden">hidden</span><span className="ins-key widget">widget</span><span className="ins-key prefix">prefix</span>
                            <span className="grow" /><span className="dim">{live ? '' : `after #${paused} · `}{snap.mode} · {snap.length} chars</span>
                        </div>
                        <Source state={state} snap={snap} hot={live ? hot : null} onHover={setFlash} />
                        <div className="ins-strip">
                            <span>cursor <b>{snap.cursor.pos}</b></span>
                            <span>line <b>{snap.cursor.line}</b> col <b>{snap.cursor.col}</b></span>
                            <span>in prefix <b className={snap.cursor.inPrefix ? 'bad' : undefined}>{snap.cursor.inPrefix ? 'yes' : 'no'}</b></span>
                            {snap.visibleBefore && <span>before it <b>{show(snap.visibleBefore.char)}</b> {snap.visibleBefore.from}–{snap.visibleBefore.to}</span>}
                            {snap.visibleAfter && <span>after it <b>{show(snap.visibleAfter.char)}</b> {snap.visibleAfter.from}–{snap.visibleAfter.to}</span>}
                            <span>parse <b>{snap.parseMs.toFixed(1)} ms</b></span>
                            <span>draw <b>{snap.drawMs.toFixed(1)} ms</b></span>
                        </div>
                    </div>
                    <Tabs value={tab} onValueChange={value => setTab(value as typeof tab)} className="ins-right gap-0">
                        <TabsList className="ins-tabs">
                            {([['tx', 'Transactions'], ['deco', 'Decorations'], ['checks', 'Checks'], ['replay', 'Replay & test']] as const).map(([id, name]) => (
                                <TabsTrigger key={id} value={id}>{name}</TabsTrigger>
                            ))}
                        </TabsList>
                        <TabsContent value={tab} className="ins-pane">
                            {tab === 'tx' && <Transactions recording={recording} picked={picked} pick={pick} actions={txActions} />}
                            {tab === 'deco' && <Decorations state={state} snap={snap} />}
                            {tab === 'checks' && <Checks recording={recording} open={open} />}
                            {tab === 'replay' && <Replay view={view} state={replay} setState={setReplay} />}
                        </TabsContent>
                    </Tabs>
                </div>
            )}
            {flashBox && <div className="ins-flash" aria-hidden="true" style={flashBox} />}
        </section>
    );
}
