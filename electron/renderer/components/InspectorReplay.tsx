// The Editor Inspector's Replay & test tab (docs/design/debugger.md, section 10; board 1 of docs/design/shadcn/Debugger.html):
// a repro, from a file (a person's report too) or from the recording shown, put in a tab of its own and played step by
// step with every check, as `npm run editor -- replay` plays it; then saved, or kept as a test as `test-from` keeps it.
// The steps are real input, sent by the main process (electron/inspect.ts, through inspect-run), so what plays here is
// what a person did.

import { useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { reproError, type Repro, type ReproStep } from '../lib/inspect/repro.js';
import { reproOfEditor } from '../lib/inspect/report.js';

type Answer = Record<string, unknown>;
interface Failing { check: string; message: string; step: number }

// What the tab holds; kept by the panel, so it stays while the replay's own tab takes the editor.
export interface ReplayState {
    repro: Repro | null;
    label: string;               // where the repro came from
    at: number;                  // the next step to play
    doc: string | null;          // the text after the steps played so far
    first: Failing | null;       // the first check that failed
    busy: boolean;
    message: string | null;
}
export const NO_REPLAY: ReplayState = { repro: null, label: '', at: 0, doc: null, first: null, busy: false, message: null };

// One request to the bridge of the main process; its error as an Error.
async function ask(request: Answer): Promise<Answer> {
    if (!window.markwork.inspectRun) throw new Error('the bridge is not there (dev mode only)');
    const { ok, error, ...rest } = await window.markwork.inspectRun(request);
    if (!ok) throw new Error((error as { message?: string } | undefined)?.message ?? 'the bridge failed');
    return rest;
}

const stepLabel = (step: ReproStep): string => {
    if ('key' in step) return `key ${step.key}`;
    if ('type' in step) return `type ${JSON.stringify(step.type)}`;
    if ('select' in step) return `select ${step.select.join('–')}`;
    if ('external' in step) return 'a change from outside';
    const c = step.click;
    return 'visible' in c ? `click ${c.edge ?? 'end'} of ${JSON.stringify(c.visible)}` : 'line' in c ? `click ${c.edge} of line ${c.line}` : `click at ${c.pos}${c.mods ? ` with ${c.mods}` : ''}`;
};

export function outcome(state: ReplayState): string | null {
    const { repro, at, first, doc } = state;
    if (!repro || at < repro.steps.length) return null;
    if (first) return `fail at step ${first.step}: ${first.check}, ${first.message}`;
    if (repro.expect?.doc !== undefined && repro.expect.doc !== doc) return 'differs: every check passed, but the text is not the one expected';
    return repro.expect?.doc !== undefined ? 'pass: every check, and the text expected' : 'pass: every check';
}

export function Replay({ view, state, setState }: { view: EditorView | null; state: ReplayState; setState: (change: Partial<ReplayState>) => void }) {
    const file = useRef<HTMLInputElement>(null);
    const [name, setName] = useState('');
    const { repro } = state;
    // The repro the buttons save: the one loaded, or else the recording shown.
    const current = (): Repro | null => repro ?? (view ? reproOfEditor(view) : null);

    const busy = async (work: () => Promise<void>) => {
        setState({ busy: true, message: null });
        try { await work(); } catch (e) { setState({ message: e instanceof Error ? e.message : String(e) }); } finally { setState({ busy: false }); }
    };
    const load = (r: Repro, label: string) => busy(async () => {
        await ask({ op: 'load', repro: r });
        setState({ repro: r, label, at: 0, doc: r.start.doc, first: null });
    });
    const playFrom = (from: number, count: number) => busy(async () => {
        if (!repro) return;
        let first = state.first, doc = state.doc, at = from;
        for (; at < Math.min(repro.steps.length, from + count); at++) {
            const answer = await ask({ op: 'play', step: repro.steps[at] });
            doc = answer.doc as string;
            const failing = (answer.entries as { findings: { check: string; severity: string; message: string }[] | null }[])
                .flatMap(e => e.findings ?? []).find(f => f.severity === 'fail');
            if (failing && !first) first = { check: failing.check, message: failing.message, step: at + 1 };
            setState({ at: at + 1, doc, first });
        }
    });
    const openFile = async (chosen: File | undefined) => {
        if (!chosen) return;
        let value: unknown;
        try { value = JSON.parse(await chosen.text()); } catch { setState({ message: `${chosen.name} is not JSON` }); return; }
        const error = reproError(value);
        if (error) { setState({ message: `${chosen.name}: ${error}` }); return; }
        await load(value as Repro, chosen.name);
    };
    const save = () => busy(async () => {
        const r = current();
        if (!r) return;
        const answer = await ask({ op: 'save-repro', repro: r });
        setState({ message: answer.canceled ? null : `Saved as ${String(answer.file)}` });
    });
    const keep = () => busy(async () => {
        const r = current();
        if (!r) return;
        const answer = await ask({ op: 'keep-test', repro: r, name });
        setState({ message: `Kept as a test: ${String(answer.file)}. tests/electron/repros.mjs plays it with every check.` });
    });
    const copy = () => {
        const r = current();
        if (r) void navigator.clipboard.writeText(JSON.stringify(r, null, 2)).then(() => setState({ message: 'The repro is copied as JSON.' }));
    };
    const result = outcome(state);
    const shown = current();

    return (
        <div className="ins-list wide ins-replay">
            <div className="ins-replay-bar">
                <input ref={file} type="file" accept=".json,application/json" hidden aria-label="Repro file" onChange={e => { void openFile(e.target.files?.[0]); e.target.value = ''; }} />
                <button className="button" disabled={state.busy} onClick={() => file.current?.click()}>Open Repro…</button>
                <button className="button" disabled={state.busy || !view} onClick={() => { const r = view && reproOfEditor(view); if (r) void load(r, 'this recording'); }}>Replay This Recording</button>
                <span className="grow" />
                <button className="button" disabled={state.busy || !shown} onClick={copy}>Copy as JSON</button>
                <button className="button" disabled={state.busy || !shown} onClick={() => void save()}>Save Repro…</button>
            </div>
            {repro && (
                <div className="ins-replay-run">
                    <div className="ins-replay-bar">
                        <b>{state.label}</b>
                        <span className="dim">{repro.steps.length} steps{repro.blurred ? ' · blurred' : ''}{repro.note ? ` · “${repro.note}”` : ''}</span>
                        <span className="grow" />
                        <button className="button flat" disabled={state.busy} onClick={() => void load(repro, state.label)}>Restart</button>
                        <button className="button" disabled={state.busy || state.at >= repro.steps.length} onClick={() => void playFrom(state.at, 1)}>Step ▶</button>
                        <button className="button suggested" disabled={state.busy || state.at >= repro.steps.length} onClick={() => void playFrom(state.at, repro.steps.length)}>Play All</button>
                    </div>
                    <ol className="ins-steps" aria-label="Steps">
                        {repro.steps.map((step, i) => (
                            <li key={i} className={[i < state.at && 'done', i === state.at && 'next', state.first?.step === i + 1 && 'fail'].filter(Boolean).join(' ')}>{stepLabel(step)}</li>
                        ))}
                        {!repro.steps.length && <li className="dim">No steps: the text as it was.</li>}
                    </ol>
                    {result && <p role="status" className={`ins-result ${result.split(':')[0]}`}>{result}</p>}
                </div>
            )}
            <div className="ins-replay-bar">
                <label className="ins-name">Test name<input value={name} placeholder="backspace-after-bold" onChange={e => setName(e.target.value)} /></label>
                <button className="button" disabled={state.busy || !shown || !name.trim()} onClick={() => void keep()}>Make a Test</button>
                <span className="dim">{repro ? 'From the repro above.' : 'From the recording shown.'} It must pass every check: make it from a bug once it is fixed.</span>
            </div>
            {state.message && <p role="status" className="ins-message">{state.message}</p>}
        </div>
    );
}
