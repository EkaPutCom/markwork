// A repro (docs/design/debugger.md, section 9): the text a recording started from and the inputs that followed, as a
// file that can be played again. The steps are inputs, not transactions, so a replay runs the editor's code again: a
// replay of the changes would give the recorded text whatever the code does now.

import type { ChangeSet, EditorSelection } from '@codemirror/state';
import { blurText } from '../../../../src/markdown/blur';
import type { Recording, TxEntry } from './recorder';

export type ReproStep =
    | { key: string }                                              // "Backspace", "Ctrl+b"
    | { type: string }
    | { click: { visible: string; edge?: 'start' | 'end' } | { line: number; edge: 'start' | 'end' } | { pos: number; mods?: string } }
    | { select: [number, number] }
    | { external: unknown };                                       // ChangeSet JSON: a change no input made (the core's)

export interface Repro {
    format: 'markwork-repro';
    version: 1;
    app: { version: string; os: string; electron?: string; commit?: string };
    editor: { mode: 'visual' | 'live' | 'source'; focus: boolean; width: number };
    start: { doc: string; selection: [number, number][] };
    steps: ReproStep[];
    expect?: { doc?: string; checks?: 'pass' };
    actual?: { doc: string; failed: string[] };
    note?: string;
    blurred: boolean;
    picture?: string;      // a report's picture of the editor: a PNG next to it, by its name (electron/main.ts)
}

// A transaction with no input of its own this soon after one with an input was made by that input too (a key whose
// command dispatches twice): it is not a step of its own.
const FOLLOW_MS = 100;

const selectionOf = (selection: EditorSelection): [number, number][] => selection.ranges.map(r => [r.anchor, r.head]);
// A key that only types its character: Shift is already in the character.
const types = (entry: TxEntry): boolean => {
    const input = entry.input!;
    return [...(input.key ?? '')].length === 1 && (!input.mods || input.mods === 'Shift') && entry.userEvent === 'input.type';
};

// The steps of a recording's entries, in order.
export function stepsOf(entries: readonly TxEntry[]): ReproStep[] {
    const steps: ReproStep[] = [];
    let lastInput = -Infinity;
    for (const entry of entries) {
        const { input } = entry;
        if (input) lastInput = entry.t;
        if (input?.kind === 'key') {
            const last = steps.at(-1);
            if (types(entry) && last && 'type' in last) last.type += input.key;
            else if (types(entry)) steps.push({ type: input.key! });
            else steps.push({ key: input.mods ? `${input.mods}+${input.key}` : input.key! });
        } else if (input?.kind === 'click') {
            const head = entry.after.main.head;
            steps.push({ click: input.mods ? { pos: head, mods: input.mods } : { pos: head } });
        } else if (input?.kind === 'compose' && !entry.changes.empty) {
            steps.push({ type: insertedBy(entry.changes) });
        } else if (input) {
            // A paste or a drop: what it brought is in the change, not in an input a replay could give again.
            steps.push({ external: entry.changes.toJSON() });
        } else if (entry.userEvent === 'select.inspect' || (entry.changes.empty && entry.t - lastInput > FOLLOW_MS)) {
            const main = entry.after.main;
            steps.push({ select: [main.anchor, main.head] });
        } else if (entry.t - lastInput > FOLLOW_MS && !entry.changes.empty) {
            steps.push({ external: entry.changes.toJSON() });
        }
    }
    return steps;
}

function insertedBy(changes: ChangeSet): string {
    let text = '';
    changes.iterChanges((_a, _b, _c, _d, inserted) => { text += inserted.toString(); });
    return text;
}

export interface ReproContext {
    app: Repro['app'];
    editor: Repro['editor'];
    doc: string;
    failed: string[];
    note?: string;
}

// The repro of a recording: from its base to the text as it is now. A text no check failed on is what was expected, so
// a replay of it is a test that the text comes out the same; a failing one has no `expect`, only what happened.
export function reproOf(recording: Recording, context: ReproContext): Repro {
    return {
        format: 'markwork-repro', version: 1, app: context.app, editor: context.editor,
        start: { doc: recording.base.doc.toString(), selection: selectionOf(recording.base.selection) },
        steps: stepsOf(recording.entries),
        ...(context.failed.length ? {} : { expect: { doc: context.doc, checks: 'pass' as const } }),
        actual: { doc: context.doc, failed: context.failed },
        ...(context.note ? { note: context.note } : {}),
        blurred: false,
    };
}

// A ChangeSet's JSON: a length kept, or a length replaced by the lines inserted.
const blurChange = (part: unknown): unknown => Array.isArray(part) ? part.map(p => typeof p === 'string' ? blurText(p) : p) : part;

function blurStep(step: ReproStep): ReproStep {
    if ('type' in step) return { type: blurText(step.type) };
    if ('click' in step && 'visible' in step.click) return { click: { ...step.click, visible: blurText(step.click.visible) } };
    if ('external' in step && Array.isArray(step.external)) return { external: step.external.map(blurChange) };
    return step;
}

// The same repro with its text blurred (markdown/blur.ts): every text, what was typed, and what a change brought. A
// blurred text is as long as the real one, so the selections, clicks, and changes stay as they are. The note is the
// person's own words to the developer, and stays.
export function blurRepro(repro: Repro): Repro {
    return {
        ...repro,
        start: { ...repro.start, doc: blurText(repro.start.doc) },
        steps: repro.steps.map(blurStep),
        ...(repro.expect ? { expect: { ...repro.expect, ...(repro.expect.doc !== undefined ? { doc: blurText(repro.expect.doc) } : {}) } } : {}),
        ...(repro.actual ? { actual: { ...repro.actual, doc: blurText(repro.actual.doc) } } : {}),
        blurred: true,
    };
}

const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(n => Number.isInteger(n) && n >= 0);

// The bridge's request that plays one step: the same input a person gave (scripts/editor-fuzz.mjs stepRequest, which the
// command line uses, says the same).
export function stepRequest(step: ReproStep): Record<string, unknown> {
    if ('key' in step) return { op: 'press', keys: [step.key] };
    if ('type' in step) return { op: 'type', text: step.type };
    if ('select' in step) return { op: 'select', from: step.select[0], to: step.select[1] };
    if ('external' in step) return { op: 'apply', changes: step.external };
    const click = step.click;
    if ('visible' in click) return { op: 'click', visible: click.visible, edge: click.edge ?? 'end' };
    if ('line' in click) return { op: 'click', line: click.line, edge: click.edge };
    return { op: 'click', pos: click.pos, mods: click.mods };
}

// A repro kept as a test (tests/electron/repros.mjs plays each): it must pass every check, and come out as the text it
// expects when it has one; what happened when it was made is left out (scripts/editor.mjs test-from does the same).
export function keptAsTest(repro: Repro): Repro {
    const { actual: _actual, ...kept } = repro;
    return { ...kept, expect: { ...repro.expect, checks: 'pass' } };
}

export function stepError(step: unknown): string | null {
    if (!step || typeof step !== 'object') return 'is not an object';
    const s = step as Record<string, unknown>;
    if ('key' in s) return typeof s.key === 'string' && s.key ? null : 'has a key that is not a name';
    if ('type' in s) return typeof s.type === 'string' ? null : 'types something that is not text';
    if ('select' in s) return isPair(s.select) ? null : 'selects something that is not [from, to]';
    if ('external' in s) return Array.isArray(s.external) ? null : 'has an external change that is not a change set';
    if ('click' in s) {
        const c = s.click as Record<string, unknown> | null;
        if (c && typeof c.visible === 'string' && (c.edge === undefined || c.edge === 'start' || c.edge === 'end')) return null;
        if (c && Number.isInteger(c.line) && (c.line as number) >= 1 && (c.edge === 'start' || c.edge === 'end')) return null;
        if (c && Number.isInteger(c.pos) && (c.pos as number) >= 0) return null;
        return 'clicks neither on visible text, at the edge of a line, nor at a position';
    }
    return 'is no step a repro knows';
}

// Why a value read from a file is not a repro this version can play, or null when it is one.
export function reproError(value: unknown): string | null {
    if (!value || typeof value !== 'object') return 'not a JSON object';
    const r = value as Record<string, unknown>;
    if (r.format !== 'markwork-repro') return 'not a markwork repro (its "format")';
    if (r.version !== 1) return `version ${String(r.version)} of the format; this app reads version 1`;
    const start = r.start as Record<string, unknown> | undefined;
    if (!start || typeof start.doc !== 'string') return '"start.doc" is not text';
    const length = start.doc.length;
    if (!Array.isArray(start.selection) || !start.selection.length || !start.selection.every(p => isPair(p) && p.every(n => n <= length))) {
        return '"start.selection" is not a list of [anchor, head] inside the text';
    }
    if (!Array.isArray(r.steps)) return '"steps" is not a list';
    for (const [i, step] of r.steps.entries()) {
        const error = stepError(step);
        if (error) return `step ${i + 1} ${error}`;
    }
    const editor = r.editor as Record<string, unknown> | undefined;
    if (editor && !['visual', 'live', 'source'].includes(editor.mode as string)) return '"editor.mode" is not visual, live, or source';
    return null;
}
