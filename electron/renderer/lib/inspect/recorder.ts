// The recorder: every transaction of a tab's text, with the key, click, or paste that caused it, for the last 500 or the
// last two minutes. It runs in every build, since a report of a problem with the editor is made of it
// (docs/design/debugger.md); it keeps no copy of the text per transaction, only the changes, and the text before the
// oldest one it still has.

import { Prec, StateField, Transaction, type ChangeSet, type StateEffect, type EditorSelection, type EditorState, type Extension, type StateEffectType, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const LIMIT = 500;           // entries
const SPAN_MS = 120_000;     // and their age
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
}

const effectNames: [(effect: StateEffect<unknown>) => boolean, string][] = [];

// Gives an effect a name in the recording; an effect has none of its own.
export function nameEffect<T>(type: StateEffectType<T>, name: string): void { effectNames.push([effect => effect.is(type), name]); }

// Told of every transaction that is recorded, in any tab: the checks of dev mode.
type Observer = (recording: Recording, entry: TxEntry, tr: Transaction) => void;
let observer: Observer | null = null;
export function observeRecordings(watch: Observer | null): void { observer = watch; }

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
        this.entries.push(entry);
        while (this.entries.length > LIMIT || now - this.entries[0].t > SPAN_MS) {
            const old = this.entries.shift()!;
            this.base = { doc: old.changes.apply(this.base.doc), selection: old.after };
        }
        observer?.(this, entry, tr);
        this.changed();
        return entry;
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

export function recorder(): Extension {
    const note = (view: EditorView, input: Omit<InputEntry, 't'>): boolean => {
        const recording = recordingOf(view.state);
        if (recording) recording.pending = { ...input, t: performance.now() };
        return false;   // only noted: the editor's own handlers still take it
    };
    return [
        recordingField,
        // Before the keymap, which would take the key first.
        Prec.highest(EditorView.domEventHandlers({
            // A modifier alone does nothing; the key it is held with is the input.
            keydown: (e, view) => MODIFIERS.has(e.key) ? false : note(view, { kind: 'key', key: e.key, mods: mods(e) }),
            mousedown: (e, view) => note(view, { kind: 'click', x: e.clientX, y: e.clientY, mods: mods(e) }),
            paste: (_e, view) => note(view, { kind: 'paste' }),
            drop: (_e, view) => note(view, { kind: 'drop' }),
            compositionend: (_e, view) => note(view, { kind: 'compose' }),
        })),
        EditorView.updateListener.of(update => {
            const recording = recordingOf(update.state);
            if (!recording) return;
            for (const tr of update.transactions) if (tr.docChanged || tr.selection || tr.effects.length) recording.push(tr);
        }),
    ];
}
