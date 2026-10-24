// The page's half of the Editor Inspector's bridge (docs/design/debugger.md, section 8): it answers what the main process
// asks for another process (scripts/editor.mjs), about the focused pane's editor. Reading is done here; keys and clicks
// are sent by the main process as real input, and this half only says where to click and when the editor has settled.
// Dev mode only (renderer/main.tsx).

import { ChangeSet, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Client } from '../client.js';
import { drawnOf, focusOn, sourceOn, visualOn } from '../editor.js';
import { recordingOf, type Recording, type TxEntry } from './recorder.js';
import { reproError, reproOf, type Repro } from './repro.js';
import { snapshot } from './snapshot.js';

export interface InspectRequest { op: string; [arg: string]: unknown }
type Answer = Record<string, unknown>;

// A failure the other side shows as it is: `code` is for a script, `message` for a person.
export class InspectError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

const AROUND_LINES = 3;     // the decorations of a snapshot: the cursor's line and this many on each side
const QUIET_MS = 500;       // an action has settled when no transaction came for this long
const MIN_QUIET_MS = 40;    // the shortest wait asked for: two frames and a little
const SETTLE_LIMIT_MS = 5000;
const CORE_OPS = new Set(['open', 'mode', 'load']);
const STEADY_MS = 300;      // a tab's editor that kept one state this long has been given its text

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
    for (const end = performance.now() + ms; !condition();) {
        if (performance.now() > end) throw new InspectError('timeout', `${what} did not happen within ${ms} ms`);
        await sleep(20);
    }
}

// An entry as JSON: the changes as CodeMirror writes them, the selections as [anchor, head] pairs.
export function entryJSON(entry: TxEntry): Answer {
    return {
        n: entry.n, t: Math.round(entry.t), userEvent: entry.userEvent, changes: entry.changes.toJSON(),
        selBefore: entry.before.ranges.map(r => [r.anchor, r.head]), selAfter: entry.after.ranges.map(r => [r.anchor, r.head]),
        effects: entry.effects, input: entry.input, findings: entry.findings,
    };
}

const modeOf = (state: EditorState): 'visual' | 'live' | 'source' => sourceOn(state) ? 'source' : visualOn(state) ? 'visual' : 'live';

export class InspectBridge {
    private overlaid: HTMLElement | null = null;

    constructor(private readonly client: Client) {}

    private view(): EditorView {
        const view = this.client.currentEditor?.view;
        const tab = this.client.activeTab;
        if (!view || !tab || tab.page !== 'text') throw new InspectError('no-editor', 'the focused pane shows no text editor');
        return view;
    }
    private recording(): Recording {
        const recording = recordingOf(this.view().state);
        if (!recording) throw new InspectError('no-editor', 'the editor keeps no recording');
        return recording;
    }
    // Which text an answer is about.
    private where(): Answer {
        const state = this.client.getState(), tab = this.client.activeTab;
        return { pane: state.panes.current, tab: tab?.id ?? null, path: tab?.file ?? null, name: tab?.name ?? null };
    }

    async answer(request: InspectRequest): Promise<Answer> {
        // The ops that ask the core for something wait until it has answered the window's hello: a window that just
        // started (--headless) listens before it is connected, and a command sent then is lost.
        if (CORE_OPS.has(request.op)) await until(() => this.client.getState().commands.length > 0, SETTLE_LIMIT_MS, 'the connection to the core');
        switch (request.op) {
            case 'snapshot': return this.snapshot(request);
            case 'decorations': return this.decorations(request);
            case 'log': return this.log(request);
            case 'check': return this.check(request);
            case 'last': return { ...this.where(), n: this.recording().entries.at(-1)?.n ?? 0 };
            case 'settle': return this.settle(request);
            case 'select': return this.select(request);
            case 'coords': return this.coords(request);
            case 'apply': return this.apply(request);
            case 'open': return this.open(request);
            case 'mode': return this.mode(request);
            case 'repro': return this.repro(request);
            case 'load': return this.load(request);
            case 'area': return this.area(request);
            case 'focus': return this.focus();
            default: throw new InspectError('usage', `no such op: ${String(request.op)}`);
        }
    }

    // Keys go to the editor, as they would after a person clicked into it; a table cell or a code block being edited in
    // place keeps the focus it has.
    private focus(): Answer {
        const view = this.view();
        if (!view.dom.contains(document.activeElement)) view.focus();
        return this.where();
    }

    private snapshot(request: InspectRequest): Answer {
        const { state } = this.view();
        const line = state.doc.lineAt(this.at(state, request.at)).number;
        const shot = request.all === true ? snapshot(state) : snapshot(state, line - AROUND_LINES, line + AROUND_LINES);
        return { ...this.where(), ...shot, focus: focusOn(state) };
    }

    // `at`: 'cursor' (or nothing) or a position in the text.
    private at(state: EditorState, at: unknown): number {
        if (at === undefined || at === 'cursor') return state.selection.main.head;
        if (!Number.isInteger(at) || (at as number) < 0 || (at as number) > state.doc.length) throw new InspectError('usage', `--at ${String(at)} is not a position in the text (0–${state.doc.length})`);
        return at as number;
    }

    private decorations(request: InspectRequest): Answer {
        const { state } = this.view();
        const line = request.line === undefined ? state.doc.lineAt(state.selection.main.head).number : Number(request.line);
        if (!Number.isInteger(line) || line < 1 || line > state.doc.lines) throw new InspectError('usage', `--line ${String(request.line)} is not a line of the text (1–${state.doc.lines})`);
        const [first, last] = request.line === undefined ? [line - AROUND_LINES, line + AROUND_LINES] : [line, line];
        return { ...this.where(), lines: [Math.max(1, first), Math.min(state.doc.lines, last)], decorations: snapshot(state, first, last).decorations };
    }

    private log(request: InspectRequest): Answer {
        const since = Number(request.since ?? 0);
        let entries = this.recording().entries.filter(e => e.n > since);
        if (request.flagged === true) entries = entries.filter(e => e.findings?.length);
        return { ...this.where(), entries: entries.map(entryJSON) };
    }

    // The findings of the last transaction (the checks need one), or of those named.
    private async check(request: InspectRequest): Promise<Answer> {
        const recording = this.recording(), last = recording.entries.at(-1);
        if (!last) return { ...this.where(), n: 0, findings: [], note: 'nothing recorded yet' };
        await until(() => last.findings !== null, SETTLE_LIMIT_MS, 'the checks of the last transaction');
        const names = Array.isArray(request.names) ? request.names as string[] : [];
        return { ...this.where(), n: last.n, findings: last.findings!.filter(f => !names.length || names.includes(f.check)) };
    }

    // Waits until the editor has settled after an action: no transaction for QUIET_MS, and every one since `since`
    // checked. Answers those transactions.
    // `quiet` (ms) shortens the wait for a run of many steps (fuzz), where a key comes long after the last one's frame.
    private async settle(request: InspectRequest): Promise<Answer> {
        const recording = this.recording(), since = Number(request.since ?? 0);
        const quiet = Math.min(Math.max(Number(request.quiet ?? QUIET_MS) || QUIET_MS, MIN_QUIET_MS), QUIET_MS);
        const end = performance.now() + SETTLE_LIMIT_MS;
        let seen = recording.entries.at(-1)?.n ?? 0, quietSince = performance.now();
        while (performance.now() < end) {
            await sleep(25);
            const now = recording.entries.at(-1)?.n ?? 0;
            if (now !== seen) { seen = now; quietSince = performance.now(); continue; }
            const fresh = recording.entries.filter(e => e.n > since);
            if (performance.now() - quietSince >= quiet && fresh.every(e => e.findings !== null)) {
                return { ...this.where(), entries: fresh.map(entryJSON), doc: this.view().state.doc.toString() };
            }
        }
        throw new InspectError('timeout', `the editor did not settle within ${SETTLE_LIMIT_MS} ms`);
    }

    // The one action that dispatches by itself: marked, so it shows in the log for what it is.
    private select(request: InspectRequest): Answer {
        const view = this.view(), length = view.state.doc.length;
        const anchor = Number(request.from), head = request.to === undefined ? anchor : Number(request.to);
        if (![anchor, head].every(n => Number.isInteger(n) && n >= 0 && n <= length)) throw new InspectError('usage', `select ${anchor} ${head}: not inside the text (0–${length})`);
        view.dispatch({ selection: { anchor, head }, userEvent: 'select.inspect', scrollIntoView: true });
        view.focus();
        return { ...this.where(), selection: [[anchor, head]] };
    }

    // Where to click, in the window: at a position, or at the start or end of a piece of text the eye sees (the first
    // place it is written with no hidden range in it). The editor is scrolled to it first, without a transaction.
    private async coords(request: InspectRequest): Promise<Answer> {
        const view = this.view(), { state } = view;
        let pos: number;
        if (typeof request.visible === 'string') {
            const found = visiblePlace(state, request.visible);
            if (found === null) throw new InspectError('not-found', `no visible text ${JSON.stringify(request.visible)} in the editor`);
            pos = request.edge === 'start' ? found : found + request.visible.length;
        } else pos = this.at(state, request.pos);
        await this.reveal(view, pos);
        const box = view.coordsAtPos(pos, request.edge === 'start' ? 1 : -1) ?? view.coordsAtPos(pos);
        if (!box) throw new InspectError('not-found', `position ${pos} is not drawn`);
        // Just inside the letter on the side asked for, half way down the line: where a person would click.
        const x = request.edge === 'start' ? box.left + 1 : box.right - 1;
        return { ...this.where(), pos, x: Math.round(x), y: Math.round((box.top + box.bottom) / 2), zoom: window.devicePixelRatio };
    }

    private async reveal(view: EditorView, pos: number): Promise<void> {
        const scroller = view.scrollDOM, rect = scroller.getBoundingClientRect();
        const shown = () => { const box = view.coordsAtPos(pos); return box && box.top >= rect.top && box.bottom <= rect.bottom; };
        if (shown()) return;
        scroller.scrollTop = view.lineBlockAt(pos).top - scroller.clientHeight / 2;
        await frame();
        await frame();
    }

    // A change that came from no input (the core's, in a repro): dispatched as it was.
    private apply(request: InspectRequest): Answer {
        const view = this.view();
        let changes: ChangeSet;
        try { changes = ChangeSet.fromJSON(request.changes); } catch { throw new InspectError('usage', 'the change is not a change set'); }
        if (changes.length !== view.state.doc.length) throw new InspectError('mismatch', `the change is for a text of ${changes.length} characters; this one has ${view.state.doc.length}`);
        view.dispatch({ changes, userEvent: 'inspect.external' });
        return this.where();
    }

    private async open(request: InspectRequest): Promise<Answer> {
        const path = String(request.path ?? '');
        if (!path) throw new InspectError('usage', 'open needs a path');
        // A path of the work folder is opened by its name (once the folder is read), any other by the place it is.
        const absolute = request.absolute === true;
        if (absolute) this.client.openRecent(path);
        else {
            await until(() => this.client.getState().tree.root !== null, SETTLE_LIMIT_MS, 'reading the work folder');
            this.client.openFile(path);
        }
        const wanted = path.replace(/\\/g, '/');
        const opened = () => {
            const file = this.client.activeTab?.file?.replace(/\\/g, '/');
            return !!file && (absolute ? file === wanted : file.endsWith(`/${wanted}`));
        };
        await until(() => opened() && !!this.client.currentEditor && this.client.activeTab?.page === 'text', SETTLE_LIMIT_MS, `opening ${path}`);
        await frame();
        this.view().focus();
        return this.where();
    }

    // Visual, live, or source, through the commands a person would use, so the settings and the pane agree.
    private async mode(request: InspectRequest): Promise<Answer> {
        const mode = request.mode;
        if (mode !== 'visual' && mode !== 'live' && mode !== 'source') throw new InspectError('usage', `mode ${String(mode)}: visual, live, or source`);
        this.view();
        if (mode === 'source') this.client.run('source', true);
        else {
            if (this.client.getState().source) this.client.run('source', false);
            this.client.run('visual', mode === 'visual');
        }
        if (typeof request.focus === 'boolean' && focusOn(this.view().state) !== request.focus) this.client.run('focus', request.focus);
        await until(() => modeOf(this.view().state) === mode && (typeof request.focus !== 'boolean' || focusOn(this.view().state) === request.focus), SETTLE_LIMIT_MS, `mode ${mode}`);
        return { ...this.where(), mode };
    }

    // Until the focused editor has shown the active tab with the same state for STEADY_MS.
    private async steady(): Promise<void> {
        const end = performance.now() + SETTLE_LIMIT_MS;
        let state = this.client.currentEditor?.view.state, since = performance.now();
        while (performance.now() < end) {
            await sleep(25);
            const editor = this.client.currentEditor, now = editor?.view.state;
            if (now !== state || editor?.shown !== this.client.activeTab?.id) { state = now; since = performance.now(); continue; }
            if (performance.now() - since >= STEADY_MS) return;
        }
        throw new InspectError('timeout', `the editor did not keep one state within ${SETTLE_LIMIT_MS} ms`);
    }

    // The repro of the recording so far. The main process adds what only it knows (the Electron version).
    private repro(request: InspectRequest): Answer {
        const view = this.view(), recording = this.recording();
        const failed = [...new Set(recording.entries.flatMap(e => (e.findings ?? []).filter(f => f.severity === 'fail').map(f => f.check)))];
        const repro = reproOf(recording, {
            app: { version: __APP_VERSION__, os: navigator.platform },
            editor: { mode: modeOf(view.state), focus: focusOn(view.state), width: Math.round(view.contentDOM.getBoundingClientRect().width) },
            doc: view.state.doc.toString(), failed,
            note: typeof request.note === 'string' ? request.note : undefined,
        });
        return { ...this.where(), repro };
    }

    // A repro's start in a new tab with no file, in the repro's mode: the place a replay plays its steps.
    private async load(request: InspectRequest): Promise<Answer> {
        const error = reproError(request.repro);
        if (error) throw new InspectError('bad-repro', error);
        const repro = request.repro as Repro;
        const old = this.client.currentEditor ? recordingOf(this.client.currentEditor.view.state) : null;
        this.client.run('new');
        // New Document gives a new tab, or empties the one shown when nothing was done in it yet (documents.ts blank):
        // either way an empty text with no file, in a state of its own (a recording of its own).
        const fresh = () => {
            const view = this.client.currentEditor?.view;
            return !!view && this.client.activeTab?.file === null && recordingOf(view.state) !== old && view.state.doc.length === 0;
        };
        await until(fresh, SETTLE_LIMIT_MS, 'a new document');
        // The core may still give the new tab its text (editor.ts reset makes another state): the text goes in once
        // the editor has kept one state for a while, and again if it was replaced all the same.
        const [anchor, head] = repro.start.selection[0];
        for (let tries = 0; ; tries++) {
            await this.steady();
            const view = this.view();
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: repro.start.doc }, selection: { anchor, head }, userEvent: 'inspect.load' });
            await this.steady();
            if (this.view().state.doc.toString() === repro.start.doc) break;
            if (tries === 2) throw new InspectError('timeout', 'the new tab did not keep the text of the repro');
        }
        const view = this.view();
        if (repro.editor) await this.mode({ op: 'mode', mode: repro.editor.mode, focus: repro.editor.focus });
        // The recording starts at the repro's text, so a repro saved from here has that text as its start.
        await this.steady();
        this.recording().restart(this.view().state);
        view.focus();
        await frame();
        const width = Math.round(view.contentDOM.getBoundingClientRect().width);
        return { ...this.where(), n: this.recording().entries.at(-1)?.n ?? 0, width, widthDiffers: !!repro.editor && repro.editor.width !== width };
    }

    // The editor's place in the window, for a picture of it; `overlay` outlines its widgets while the picture is taken.
    private async area(request: InspectRequest): Promise<Answer> {
        const view = this.view(), host = view.dom.parentElement;
        // The outline the open panel draws stays; only the one put on for a picture is taken off again.
        if (request.overlay === true && host && !host.classList.contains('inspecting')) {
            host.classList.add('inspecting');
            this.overlaid = host;
            await frame();   // the outline is drawn before the picture is taken
        } else if (request.overlay === false && this.overlaid) {
            this.overlaid.classList.remove('inspecting');
            this.overlaid = null;
        }
        const r = view.dom.getBoundingClientRect();
        return { ...this.where(), x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), drawMs: drawnOf(view.state)?.ms ?? 0 };
    }
}

// The first place `text` is written where none of it is hidden: what a person reading the editor would point at.
export function visiblePlace(state: EditorState, text: string): number | null {
    if (!text) return null;
    const doc = state.doc.toString(), hidden = drawnOf(state)?.concealed.hidden;
    for (let at = doc.indexOf(text); at >= 0; at = doc.indexOf(text, at + 1)) {
        let covered = false;
        hidden?.between(at, at + text.length, (a, b) => { if (b > at && a < at + text.length) { covered = true; return false; } return undefined; });
        if (!covered) return at;
    }
    return null;
}

// Answers the main process's requests, one at a time, as the preload hands them over.
export function startBridge(client: Client): void {
    const bridge = new InspectBridge(client);
    window.markwork.onInspect?.(async request => {
        const { id, ...rest } = request as InspectRequest & { id: number };
        try {
            return { id, ok: true, ...await bridge.answer(rest as InspectRequest) };
        } catch (e) {
            const error = e instanceof InspectError ? { code: e.code, message: e.message } : { code: 'internal', message: String(e) };
            return { id, ok: false, error };
        }
    });
}
