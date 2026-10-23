// What the editor shows and hides at one moment, as plain data: the top half of the Editor Inspector, and later the
// answer to `snapshot` for an agent (docs/design/debugger.md, section 5). Offsets are UTF-16, as CodeMirror's are.

import type { EditorState } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { drawnOf, sourceOn, visualOn } from '../editor.js';

export type DecoKind = 'replace' | 'widget' | 'mark' | 'line';

export interface DecoInfo {
    from: number;
    to: number;
    kind: DecoKind;
    what: string;        // the widget's class, or the mark's or line's class; '' for a plain hidden range
    block: boolean;
}

export interface Snapshot {
    mode: 'visual' | 'live' | 'source';
    length: number;
    lines: number;
    selection: [number, number][];
    cursor: { pos: number; line: number; col: number; inPrefix: boolean };
    visibleBefore: { char: string; from: number; to: number } | null;
    hidden: [number, number][];
    prefixes: [number, number][];   // [line start, where its text starts]
    decorations: DecoInfo[];        // on the lines asked for
    drawMs: number;
}

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
    return {
        mode: sourceOn(state) ? 'source' : visualOn(state) ? 'visual' : 'live',
        length: doc.length, lines: doc.lines,
        selection: selection.ranges.map(r => [r.anchor, r.head]),
        cursor: { pos: head, line: line.number, col: head - line.from + 1, inPrefix: end !== undefined && head >= line.from && head < end },
        visibleBefore: visibleBefore(state, hidden, head),
        hidden, prefixes, decorations, drawMs: drawn?.ms ?? 0,
    };
}

// The character the eye sees right before `pos`: the hidden ranges that end there are stepped over first.
function visibleBefore(state: EditorState, hidden: [number, number][], pos: number): Snapshot['visibleBefore'] {
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
