// The rules of the visual editor (AGENT.md, Known pitfalls) written as checks of one transaction: the state before, the
// transaction, the state after. They run in dev mode only, after each recorded transaction when the editor is idle
// (docs/design/debugger.md, section 6). A check names what it saw with offsets and text, so a person or an agent can
// act on the message alone.

import { RangeSet, type EditorState, type Transaction } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { undo, undoDepth } from '@codemirror/commands';
import { makeU16Map } from '../../../../src/markdown/offsets.js';
import { splitRow } from '../../../../src/markdown/table.js';
import { drawnOf, freshDrawing, parseOf, visualOn } from '../editor.js';
import { observeRecordings, type Finding, type TxEntry } from './recorder.js';

interface Check {
    name: string;
    run(before: EditorState, tr: Transaction, after: EditorState): Omit<Finding, 'check'> | null;
}

const DRAW_LIMIT_MS = 8;

const quote = (text: string): string => JSON.stringify(text.length > 40 ? `${text.slice(0, 37)}…` : text);
const slice = (state: EditorState, from: number, to: number) => quote(state.sliceDoc(from, to));

// The lines (from 0) a table or a fenced block takes: what happens inside them is the grid's or the box's own editing.
function inBlock(state: EditorState, from: number, to: number): boolean {
    const parse = parseOf(state.doc);
    if (!parse) return false;
    const a = state.doc.lineAt(from).number - 1, b = state.doc.lineAt(to).number - 1;
    return parse.tables.some(t => a <= t.end && b >= t.start) || parse.codeBlocks.some(c => a <= c.endLine && b >= c.startLine);
}

export const CHECKS: readonly Check[] = [
    {
        // Backspace and Delete remove what the eye sees: never a part of a hidden range, never only hidden text (unless it
        // is the prefix of the line, which makes the line a paragraph).
        name: 'backspace-visible',
        run(before, tr) {
            if (!tr.isUserEvent('delete.backward') && !tr.isUserEvent('delete.forward')) return null;
            const sel = before.selection.main, drawn = drawnOf(before);
            if (before.selection.ranges.length > 1 || !sel.empty || !visualOn(before) || !drawn) return null;
            const { hidden, prefixes } = drawn.concealed;
            const line = before.doc.lineAt(sel.head), end = prefixes.get(line.from);
            let found: string | null = null;
            tr.changes.iterChangedRanges((from, to) => {
                if (found || to <= from || (end !== undefined && from === line.from && to === end)) return;
                let cut: [number, number] | null = null, covered = 0;
                hidden.between(from, to, (a, b) => {
                    if (a >= to || b <= from) return;
                    if (a < from || b > to) cut ??= [a, b];
                    covered += Math.min(b, to) - Math.max(a, from);
                });
                const what = `removed ${from}–${to} ${slice(before, from, to)} with the cursor at ${sel.head}`;
                if (cut) found = `${what}: a part of the hidden ${slice(before, cut[0], cut[1])} at ${cut[0]}–${cut[1]}`;
                else if (covered >= to - from) found = `${what}: all of it hidden, so nothing the eye sees went away`;
            });
            return found && { severity: 'fail', message: found };
        },
    },
    {
        // A cursor that only moved does not stand in a line's hidden prefix (visual.ts keepOutOfPrefixes).
        name: 'prefix-guard',
        run(before, tr, after) {
            if (tr.docChanged || !tr.selection || !visualOn(after)) return null;
            const sel = after.selection.main, drawn = drawnOf(before);
            if (after.selection.ranges.length > 1 || !sel.empty || !drawn) return null;
            const line = after.doc.lineAt(sel.head), end = drawn.concealed.prefixes.get(line.from);
            if (end === undefined || sel.head >= end || end === line.from) return null;
            return { severity: 'fail', message: `the cursor is at ${sel.head}, inside the hidden prefix ${line.from}–${end} ${slice(after, line.from, end)} of line ${line.number}` };
        },
    },
    {
        // Typing and deleting change the text at the cursor: its lines, and the line break before or after them.
        name: 'local-change',
        run(before, tr) {
            if (!tr.docChanged || !(tr.isUserEvent('input.type') || tr.isUserEvent('delete'))) return null;
            const { doc } = before, sel = before.selection;
            const lo = Math.max(0, doc.lineAt(Math.min(...sel.ranges.map(r => r.from))).from - 1);
            const hi = Math.min(doc.length, doc.lineAt(Math.max(...sel.ranges.map(r => r.to))).to + 1);
            let found: string | null = null;
            tr.changes.iterChangedRanges((from, to) => {
                if (found || (from >= lo && to <= hi) || inBlock(before, from, to)) return;
                found = `changed ${from}–${to} ${slice(before, from, to)}, outside ${lo}–${hi} around the selection`;
            });
            return found && { severity: 'warn', message: found };
        },
    },
    {
        // What the visual editor hides is syntax the parser named (a marker), or the space between two pictures: never
        // the text itself.
        name: 'hidden-on-syntax',
        run(before, _tr, after) {
            const drawn = drawnOf(after), parse = parseOf(after.doc);
            if (!drawn || !parse || drawn === drawnOf(before)) return null;
            const u16 = makeU16Map(after.doc.toString());
            const markers = new Set(parse.markers.map(([a, b]) => `${u16(a)}:${u16(b)}`));
            let found: string | null = null;
            drawn.concealed.hidden.between(0, after.doc.length, (from, to) => {
                if (markers.has(`${from}:${to}`) || !after.sliceDoc(from, to).trim()) return;
                found = `${from}–${to} ${slice(after, from, to)} is hidden but is not a marker of the parse`;
                return false;
            });
            return found && { severity: 'fail', message: found };
        },
    },
    {
        // An inline mark that is hidden has its other half on the line: as many * (and _, ~, =, `) hidden as it opens.
        name: 'marks-closed',
        run(before, tr, after) {
            const drawn = drawnOf(after);
            if (!tr.docChanged || !drawn || !visualOn(after)) return null;
            const lines = new Set<number>();
            tr.changes.iterChangedRanges((_a, _b, from, to) => { for (let n = after.doc.lineAt(from).number; n <= after.doc.lineAt(to).number; n++) lines.add(n); });
            for (const n of lines) {
                const line = after.doc.line(n), count = new Map<string, number>();
                drawn.concealed.hidden.between(line.from, line.to, (from, to) => {
                    const text = after.sliceDoc(from, to);
                    if (/^[*_~=`]+$/.test(text)) for (const c of text) count.set(c, (count.get(c) ?? 0) + 1);
                });
                const odd = [...count].find(([, k]) => k % 2 === 1);
                if (odd) return { severity: 'warn', message: `line ${n} hides ${odd[1]} ${quote(odd[0])}, an odd number: a mark has lost its other half` };
            }
            return null;
        },
    },
    {
        // Undo right after an edit gives back the text before it. Only an edit that started its own step of the history
        // is checked: one joined to the step before it (typing within half a second) is undone with that step.
        name: 'undo',
        run(before, tr, after) {
            if (!tr.docChanged || undoDepth(after) !== undoDepth(before) + 1) return null;
            let undone: EditorState | null = null;
            undo({ state: after, dispatch: t => { undone = t.state; } });
            if (!undone) return { severity: 'fail', message: 'the edit made a step in the history, but undo did nothing' };
            const text = (undone as EditorState).doc;
            if (text.eq(before.doc)) return null;
            const at = firstDifference(text.toString(), before.doc.toString());
            return { severity: 'fail', message: `undo gives a different text from ${at}: ${quote(text.sliceString(at, at + 20))} where it was ${quote(before.doc.sliceString(at, at + 20))}` };
        },
    },
    {
        // Two replacing decorations never cross: CodeMirror would draw one and drop the other.
        name: 'no-overlap',
        run(before, _tr, after) {
            const drawn = drawnOf(after);
            if (!drawn || drawn === drawnOf(before)) return null;
            let reach: [number, number] | null = null, found: string | null = null;
            drawn.decorations.between(0, after.doc.length, (from, to, deco) => {
                if (!(deco as unknown as { isReplace?: boolean }).isReplace || to <= from) return;
                if (reach && from < reach[1] && to > reach[1]) { found = `${reach[0]}–${reach[1]} and ${from}–${to} are both replaced and cross`; return false; }
                if (!reach || to > reach[1]) reach = [from, to];
                return undefined;
            });
            return found && { severity: 'fail', message: found };
        },
    },
    {
        // A table the visual editor changed keeps as many cells in each row as in its header.
        name: 'tables',
        run(_before, tr, after) {
            const parse = parseOf(after.doc);
            if (!tr.docChanged || !visualOn(after) || !parse?.tables.length) return null;
            const touched: [number, number][] = [];
            tr.changes.iterChangedRanges((_a, _b, from, to) => { touched.push([after.doc.lineAt(from).number - 1, after.doc.lineAt(to).number - 1]); });
            for (const t of parse.tables) {
                if (!touched.some(([a, b]) => a <= t.end && b >= t.start) || t.end >= after.doc.lines) continue;
                const cells = (i: number) => splitRow(after.doc.line(i + 1).text).length;
                const head = cells(t.start);
                for (let i = t.start + 1; i <= t.end; i++) {
                    if (cells(i) !== head) return { severity: 'warn', message: `the table at line ${t.start + 1}: line ${i + 1} has ${cells(i)} cells, its header ${head}` };
                }
            }
            return null;
        },
    },
    {
        // A drawing kept over a selection change (editor.ts selectionKey) is the one a new drawing would make: the key
        // holds all that the drawing takes from the selection.
        name: 'kept-drawing',
        run(before, tr, after) {
            const kept = drawnOf(after);
            if (tr.docChanged || !tr.selection || !kept || kept !== drawnOf(before)) return null;
            const fresh = freshDrawing(after);
            if (!fresh) return null;
            const prefixes = (m: ReadonlyMap<number, number>) => JSON.stringify([...m].sort((a, b) => a[0] - b[0]));
            const where = `with the selection at ${after.selection.main.anchor}–${after.selection.main.head}`;
            if (!RangeSet.eq([kept.decorations], [fresh.decorations])) return { severity: 'fail', message: `the drawing kept ${where} differs from a new one: ${firstDifferent(kept.decorations, fresh.decorations)}` };
            if (!RangeSet.eq([kept.concealed.hidden], [fresh.concealed.hidden])) return { severity: 'fail', message: `the hidden ranges kept ${where} differ from new ones: ${firstDifferent(kept.concealed.hidden, fresh.concealed.hidden)}` };
            if (prefixes(kept.concealed.prefixes) !== prefixes(fresh.concealed.prefixes)) return { severity: 'fail', message: `the prefixes kept ${where} differ from new ones` };
            return null;
        },
    },
    {
        // Drawing the text again stays well inside a frame.
        name: 'draw-time',
        run(before, _tr, after) {
            const drawn = drawnOf(after);
            if (!drawn || drawn === drawnOf(before) || drawn.ms <= DRAW_LIMIT_MS) return null;
            return { severity: 'warn', message: `drawing the text took ${drawn.ms.toFixed(1)} ms (the limit is ${DRAW_LIMIT_MS})` };
        },
    },
];

// The first range one set has and the other has not, for a message.
function firstDifferent(kept: DecorationSet, fresh: DecorationSet): string {
    const list = (set: DecorationSet) => {
        const out: string[] = [];
        set.between(0, 1e9, (from, to, deco) => { out.push(`${from}–${to} ${(deco.spec as { class?: string; widget?: object }).widget?.constructor.name ?? (deco.spec as { class?: string }).class ?? 'hidden'}`); });
        return out;
    };
    const a = list(kept), b = list(fresh);
    const onlyKept = a.find(x => !b.includes(x)), onlyFresh = b.find(x => !a.includes(x));
    return onlyKept ? `it has ${onlyKept}, a new one does not` : onlyFresh ? `a new one has ${onlyFresh}` : 'the same ranges, different widgets';
}

function firstDifference(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

export function runChecks(tr: Transaction): Finding[] {
    const findings: Finding[] = [];
    for (const check of CHECKS) {
        try {
            const found = check.run(tr.startState, tr, tr.state);
            if (found) findings.push({ check: check.name, ...found });
        } catch (e) {
            findings.push({ check: check.name, severity: 'warn', message: `the check itself failed: ${String(e)}` });
        }
    }
    return findings;
}

// The state each recorded transaction left, in dev mode, for Paused in the inspector. Kept by the entry, so it goes when
// the recording drops the entry.
const statesAfter = new WeakMap<TxEntry, EditorState>();
export const stateAfter = (entry: TxEntry): EditorState | null => statesAfter.get(entry) ?? null;

// Dev mode: every recorded transaction is checked when the editor is idle, off the path of typing.
export function watchChecks(): void {
    const queue: (() => void)[] = [];
    let scheduled = false;
    const drain = () => {
        scheduled = false;
        for (const job of queue.splice(0)) job();
    };
    observeRecordings((recording, entry, tr) => {
        statesAfter.set(entry, tr.state);
        queue.push(() => { entry.findings = runChecks(tr); recording.changed(); });
        if (!scheduled) { scheduled = true; requestIdleCallback(drain, { timeout: 500 }); }
    });
}
