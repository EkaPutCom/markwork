// Which steps of the agent log a viewer shows (pure, no widgets): the tree of tracetree.ts narrowed by a filter on the kind of
// step and by the turns and rounds the user folded. Both log viewers (the GTK window and the Electron dialog) use it.

import type { TraceKind } from './trace.js';
import type { TraceNode } from './tracetree.js';

// A turn or a round holds other steps and can be folded.
export const LOG_HEADERS: ReadonlySet<TraceKind> = new Set(['turn', 'round']);

// The turns and rounds that hold at least one step the filter lets through.
function holdingMatches(nodes: readonly TraceNode[], filter: readonly TraceKind[], parentOf: ReadonlyMap<number, number | null>): Set<number> {
    const matching = new Set<number>();
    for (const n of nodes) {
        if (LOG_HEADERS.has(n.event.kind) || (filter.length && !filter.includes(n.event.kind))) continue;
        for (let p = n.parent; p !== null; p = parentOf.get(p) ?? null) matching.add(p);
    }
    return matching;
}

// The seqs of the steps to show: none under a folded step; with a filter, a turn always, a round when something in it
// matches, and any other step when its kind is one of the filter's (an empty filter shows all).
export function visibleSteps(nodes: readonly TraceNode[], filter: readonly TraceKind[], collapsed: ReadonlySet<number>): Set<number> {
    const parentOf = new Map(nodes.map(n => [n.event.seq, n.parent]));
    const matching = holdingMatches(nodes, filter, parentOf);
    const folded = (n: TraceNode): boolean => {
        for (let p = n.parent; p !== null; p = parentOf.get(p) ?? null) if (collapsed.has(p)) return true;
        return false;
    };
    const passes = (n: TraceNode): boolean => !filter.length || n.event.kind === 'turn'
        || (LOG_HEADERS.has(n.event.kind) ? matching.has(n.event.seq) : filter.includes(n.event.kind));
    return new Set(nodes.filter(n => !folded(n) && passes(n)).map(n => n.event.seq));
}

// The step to follow while the agent works: the newest shown one. A finished turn ends with a note, and the summary of the
// turn is more useful there than the note itself.
export function settledNewest(nodes: readonly TraceNode[], shown: ReadonlySet<number>): number | null {
    let newest: TraceNode | null = null;
    for (let i = nodes.length - 1; i >= 0 && !newest; i--) if (shown.has(nodes[i].event.seq)) newest = nodes[i];
    if (!newest) return null;
    return (newest.event.kind === 'note' || newest.event.kind === 'usage') && newest.parent !== null ? newest.parent : newest.event.seq;
}
