// The recorder: every transaction of a tab's text, with the key, click, or paste that caused it, for the last 500. It
// runs in every build, since a report of a problem with the editor is made of it (docs/design/debugger.md); it keeps no
// copy of the text per transaction, only the changes, and the text before the oldest one it still has.

import { Annotation, Prec, StateField, Transaction, type ChangeSet, type StateEffect, type EditorSelection, type EditorState, type Extension, type StateEffectType, type Text } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

const LIMIT = 500;           // entries
const INPUT_MS = 50;         // an input belongs to the transaction that follows it this soon

export interface InputEntry {
    kind: 'key' | 'click' | 'paste' | 'drop' | 'compose';
    key?: string;            // KeyboardEvent.key
    mods?: string;           // "Ctrl+Shift", in the notation of app/commands.ts
    x?: number;              // a click, in the window
    y?: number;
    t: number;
}

// What a check of the inspector found about a transaction (inspect/checks.ts).
export interface Finding {
    check: string;
    severity: 'fail' | 'warn';
    message: string;
}

export interface TxEntry {
    n: number;                       // from 1 in this recording
    t: number;                       // performance.now()
    userEvent: string | null;
    changes: ChangeSet;              // in UTF-16 offsets of the text before it
    before: EditorSelection;
    after: EditorSelection;
    effects: string[];               // the names of the effects nameEffect() knows; the others are 'effect'
    input: InputEntry | null;
    findings: Finding[] | null;      // null: not checked (the checks run in dev mode only)
    handler?: string;                // the traced command that made it (dev mode only)
    trace?: string[];                // what the decisions on the way said (dev mode only)
}

// A transaction the recording leaves out: one that only puts the view back where it was (inspect/report.ts).
export const unrecorded = Annotation.define<boolean>();

const effectNames: [(effect: StateEffect<unknown>) => boolean, string][] = [];

// Gives an effect a name in the recording; an effect has none of its own.
export function nameEffect<T>(type: StateEffectType<T>, name: string): void { effectNames.push([effect => effect.is(type), name]); }

// Told of every transaction that is recorded, in any tab: the checks of dev mode, and the window's offer of a report
// after an Undo (ReportProblem.tsx). Returns how to stop.
type Observer = (recording: Recording, entry: TxEntry, tr: Transaction) => void;
const observers = new Set<Observer>();
export function observeRecordings(watch: Observer): () => void {
    observers.add(watch);
    return () => { observers.delete(watch); };
}

// ---------- Tracing (dev mode) ----------
//
// CodeMirror does not say which command took a key, and a minified bundle has no function names, so the commands of the
// visual editor that have been behind its bugs are wrapped in traced() with a name of their own, and a few decisions
// say what they decided with trace(). Outside dev mode they only test a boolean (a line given to trace() is still built,
// once per key), so they are kept to the places that have been behind a bug.

let tracing = false;
const handlers: string[] = [];
let notes: string[] = [];
export function traceCommands(on: boolean): void { tracing = on; }

// Runs `fn` as the handler `name`: a transaction it dispatches carries the name, and what trace() said on the way.
export function handling<R>(name: string, fn: () => R): R {
    if (!tracing) return fn();
    handlers.push(name);
    try { return fn(); } finally {
        handlers.pop();
        if (!handlers.length) notes = [];
    }
}
// A command named for the recording.
export const traced = <A extends unknown[]>(name: string, run: (...args: A) => boolean) =>
    (...args: A): boolean => handling(name, () => run(...args));
// A line about a decision, kept with the transaction the handler around it makes.
export function trace(message: string): void { if (tracing && handlers.length) notes.push(message); }

export class Recording {
    // The text and selection before the oldest entry: the start of a replay.
    base: { doc: Text; selection: EditorSelection };
    readonly entries: TxEntry[] = [];
    // The last input that no transaction has taken yet.
    pending: InputEntry | null = null;
    private next = 1;
    private readonly listeners = new Set<() => void>();

    constructor(state: EditorState) { this.base = { doc: state.doc, selection: state.selection }; }

    push(tr: Transaction): TxEntry {
        const now = performance.now();
        const input = this.pending && now - this.pending.t < INPUT_MS ? this.pending : null;
        this.pending = null;
        const entry: TxEntry = {
            n: this.next++, t: now, userEvent: tr.annotation(Transaction.userEvent) ?? null, changes: tr.changes,
            before: tr.startState.selection, after: tr.state.selection,
            effects: tr.effects.map(e => effectNames.find(([is]) => is(e))?.[1] ?? 'effect'),
            input, findings: null,
        };
        if (handlers.length) {
            entry.handler = handlers[handlers.length - 1];
            if (notes.length) { entry.trace = notes; notes = []; }
        }
        this.entries.push(entry);
        while (this.entries.length > LIMIT) {
            const old = this.entries.shift()!;
            this.base = { doc: old.changes.apply(this.base.doc), selection: old.after };
        }
        for (const watch of observers) watch(this, entry, tr);
        this.changed();
        return entry;
    }

    // Starts again from `state`: a repro's text just put in a tab (inspect/bridge.ts load) is where its steps begin, not
    // a change of them.
    restart(state: EditorState): void {
        this.base = { doc: state.doc, selection: state.selection };
        this.entries.length = 0;
        this.pending = null;
        this.changed();
    }

    // Someone who shows the recording (the inspector) hears of each change; returns how to stop.
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    changed(): void { for (const listener of this.listeners) listener(); }
}

const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock']);
const mods = (e: MouseEvent | KeyboardEvent): string | undefined =>
    [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean).join('+') || undefined;

// The recording of a state, from the state it was made for on (a tab keeps its own).
const recordingField = StateField.define<Recording>({ create: state => new Recording(state), update: recording => recording });
export const recordingOf = (state: EditorState): Recording | null => state.field(recordingField, false) ?? null;
// A key the window took for itself that changes nothing in the text (the inspector's own Ctrl+Alt+I): the next
// transaction is not its doing, and a replay must not press it.
export function forgetInput(state: EditorState): void {
    const recording = recordingOf(state);
    if (recording) recording.pending = null;
}

export function recorder(): Extension {
    const note = (view: EditorView, input: Omit<InputEntry, 't'>): boolean => {
        const recording = recordingOf(view.state);
        if (recording) recording.pending = { ...input, t: performance.now() };
        return false;   // only noted: the editor's own handlers still take it
    };
    return [
        recordingField,
        // Keys and clicks are heard on the window, before anyone: the command table (App.tsx) takes its keys on the
        // document and stops them, and CodeMirror does not pass on what happens in a widget that edits itself (a table
        // cell). Only what is aimed at this editor counts.
        ViewPlugin.define(view => {
            const aimed = (e: Event) => e.target instanceof Node && view.dom.contains(e.target);
            const key = (e: KeyboardEvent) => {
                // A modifier alone does nothing; the key it is held with is the input.
                if (aimed(e) && !MODIFIERS.has(e.key)) note(view, { kind: 'key', key: e.key, mods: mods(e) });
            };
            const click = (e: MouseEvent) => { if (aimed(e)) note(view, { kind: 'click', x: e.clientX, y: e.clientY, mods: mods(e) }); };
            window.addEventListener('keydown', key, true);
            window.addEventListener('mousedown', click, true);
            return { destroy: () => { window.removeEventListener('keydown', key, true); window.removeEventListener('mousedown', click, true); } };
        }),
        Prec.highest(EditorView.domEventHandlers({
            paste: (_e, view) => note(view, { kind: 'paste' }),
            drop: (_e, view) => note(view, { kind: 'drop' }),
            compositionend: (_e, view) => note(view, { kind: 'compose' }),
        })),
        EditorView.updateListener.of(update => {
            const recording = recordingOf(update.state);
            if (!recording) return;
            for (const tr of update.transactions) {
                if ((tr.docChanged || tr.selection || tr.effects.length) && !tr.annotation(unrecorded)) recording.push(tr);
            }
        }),
    ];
}
