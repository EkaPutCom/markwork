// What the editor shows and hides at one moment, as plain data: the top half of the Editor Inspector, and later the
// answer to `snapshot` for an agent (docs/design/debugger.md, section 5). Offsets are UTF-16, as CodeMirror's are.

import type { EditorState } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { makeCpMap, makeU16Map } from '../../../../src/markdown/offsets.js';
import { drawnOf, parseMsOf, parseOf, sourceOn, visualOn } from '../editor.js';

export type DecoKind = 'replace' | 'widget' | 'mark' | 'line';

export interface DecoInfo {
    from: number;
    to: number;
    kind: DecoKind;
    what: string;        // the widget's class, or the mark's or line's class; '' for a plain hidden range
    block: boolean;
}

export interface Visible { char: string; from: number; to: number }

export interface Snapshot {
    units: 'utf16' | 'cp';          // what every offset below counts (cpSnapshot)
    mode: 'visual' | 'live' | 'source';
    length: number;
    lines: number;
    selection: [number, number][];
    cursor: { pos: number; line: number; col: number; inPrefix: boolean; cp?: number };   // cp: the cursor in code points, when that differs
    around: { before: string; after: string };   // the cursor line's text on each side of the cursor, up to AROUND_CHARS
    visibleBefore: Visible | null;  // the letter the eye sees on each side of the cursor, past every hidden range
    visibleAfter: Visible | null;
    hidden: [number, number][];
    prefixes: [number, number][];   // [line start, where its text starts]
    decorations: DecoInfo[];        // on the lines asked for
    widgets: DecoInfo[];            // the decorations of those that draw something in place of the text
    parse: { line: number; spans: [style: string, from: number, to: number][] };   // the cursor line's styles, from its start
    drawMs: number;
    parseMs: number;                // the parse of this text (0 when an earlier parse was kept)
}

const AROUND_CHARS = 24;

const LINE_SIDE = -2e8;   // CodeMirror's side of a line decoration

function describe(from: number, to: number, deco: Decoration): DecoInfo {
    const spec = deco.spec as { class?: string; widget?: object; block?: boolean; attributes?: Record<string, string> };
    const replace = (deco as unknown as { isReplace?: boolean }).isReplace === true;
    const kind: DecoKind = deco.startSide === LINE_SIDE ? 'line' : replace ? 'replace' : spec.widget ? 'widget' : 'mark';
    const what = spec.widget ? spec.widget.constructor.name : spec.class ?? (spec.attributes ? Object.keys(spec.attributes).join(' ') : '');
    return { from, to, kind, what, block: !!spec.block };
}

// The state's snapshot, with the decorations of lines `first` to `last` (from 1; all lines when not given).
export function snapshot(state: EditorState, first = 1, last = state.doc.lines): Snapshot {
    const { doc, selection } = state;
    const drawn = drawnOf(state);
    const head = selection.main.head, line = doc.lineAt(head);
    const prefixes = drawn ? [...drawn.concealed.prefixes].sort((a, b) => a[0] - b[0]) : [];
    const end = drawn?.concealed.prefixes.get(line.from);
    const hidden: [number, number][] = [];
    drawn?.concealed.hidden.between(0, doc.length, (a, b) => { hidden.push([a, b]); });
    const decorations: DecoInfo[] = [];
    const from = doc.line(Math.max(1, first)).from, to = doc.line(Math.min(doc.lines, last)).to;
    drawn?.decorations.between(from, to, (a, b, deco) => { decorations.push(describe(a, b, deco)); });
    const cp = makeCpMap(doc.sliceString(0, head))(head);
    return {
        units: 'utf16',
        mode: sourceOn(state) ? 'source' : visualOn(state) ? 'visual' : 'live',
        length: doc.length, lines: doc.lines,
        selection: selection.ranges.map(r => [r.anchor, r.head]),
        cursor: { pos: head, line: line.number, col: head - line.from + 1, inPrefix: end !== undefined && head >= line.from && head < end, ...(cp !== head ? { cp } : {}) },
        around: { before: line.text.slice(Math.max(0, head - line.from - AROUND_CHARS), head - line.from), after: line.text.slice(head - line.from, head - line.from + AROUND_CHARS) },
        visibleBefore: visibleBefore(state, hidden, head),
        visibleAfter: visibleAfter(state, hidden, head),
        hidden, prefixes, decorations,
        widgets: decorations.filter(d => d.kind === 'widget' || (d.kind === 'replace' && d.what)),
        parse: { line: line.number, spans: lineSpans(state, line.number) },
        drawMs: drawn?.ms ?? 0, parseMs: parseMsOf(doc),
    };
}

// The parse's styles of a line, in UTF-16 offsets from its start (the parse counts code points).
function lineSpans(state: EditorState, number: number): [string, number, number][] {
    const spans = parseOf(state.doc)?.spans[number - 1] ?? [];
    const u16 = makeU16Map(state.doc.line(number).text);
    return spans.map(([style, a, b]) => [style, u16(a), u16(b)]);
}

// The character the eye sees right after `pos`: the hidden ranges that start there are stepped over first.
function visibleAfter(state: EditorState, hidden: [number, number][], pos: number): Visible | null {
    for (let moved = true; moved;) {
        moved = false;
        for (const [a, b] of hidden) if (a === pos && b > pos) { pos = b; moved = true; }
    }
    if (pos === state.doc.length) return null;
    const line = state.doc.lineAt(pos);
    if (pos === line.to) return { char: '\n', from: pos, to: pos + 1 };
    const char = Array.from(line.text.slice(pos - line.from))[0];
    return { char, from: pos, to: pos + char.length };
}

// The same snapshot with every offset in code points, as the app protocol counts (an emoji is one): `--cp`.
export function cpSnapshot(state: EditorState, snap: Snapshot): Snapshot {
    const doc = state.doc.toString(), cp = makeCpMap(doc);
    const pair = ([a, b]: [number, number]): [number, number] => [cp(a), cp(b)];
    const visible = (v: Visible | null) => v && { ...v, from: cp(v.from), to: cp(v.to) };
    const deco = (d: DecoInfo): DecoInfo => ({ ...d, from: cp(d.from), to: cp(d.to) });
    const line = state.doc.line(snap.parse.line), lineCp = makeCpMap(line.text);
    const { cp: _cp, ...cursor } = snap.cursor;
    return {
        ...snap, units: 'cp', length: cp(doc.length),
        selection: snap.selection.map(pair),
        cursor: { ...cursor, pos: cp(snap.cursor.pos), col: lineCp(snap.cursor.pos - line.from) + 1 },
        visibleBefore: visible(snap.visibleBefore), visibleAfter: visible(snap.visibleAfter),
        hidden: snap.hidden.map(pair), prefixes: snap.prefixes.map(pair),
        decorations: snap.decorations.map(deco), widgets: snap.widgets.map(deco),
        parse: { line: snap.parse.line, spans: snap.parse.spans.map(([style, a, b]) => [style, lineCp(a), lineCp(b)]) },
    };
}

// The character the eye sees right before `pos`: the hidden ranges that end there are stepped over first.
function visibleBefore(state: EditorState, hidden: [number, number][], pos: number): Visible | null {
    for (let moved = true; moved;) {
        moved = false;
        for (const [a, b] of hidden) if (b === pos && a < pos) { pos = a; moved = true; }
    }
    if (pos === 0) return null;
    const line = state.doc.lineAt(pos);
    if (pos === line.from) return { char: '\n', from: pos - 1, to: pos };
    const text = line.text.slice(0, pos - line.from), char = Array.from(text).pop()!;
    return { char, from: pos - char.length, to: pos };
}
