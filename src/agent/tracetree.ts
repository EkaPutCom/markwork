// The agent log as a tree (pure): a turn holds its model rounds, a round holds the reasoning, the tool
// calls, and the answer of that round. The events are already in this order, so the tree is the same list with a depth.

import type { TraceEvent } from './trace.js';

export interface TraceNode {
    event: TraceEvent;
    depth: number;
    parent: number | null;   // seq of the turn or round that holds the event
}

export function traceTree(events: readonly TraceEvent[]): TraceNode[] {
    const nodes: TraceNode[] = [];
    let turn: TraceNode | null = null;
    let round: TraceNode | null = null;
    for (const event of events) {
        let node: TraceNode;
        if (event.kind === 'turn') {
            node = { event, depth: 0, parent: null };
            turn = node;
            round = null;
        } else if (event.kind === 'round') {
            node = { event, depth: turn ? 1 : 0, parent: turn?.event.seq ?? null };
            round = node;
        } else if (event.round !== undefined && round) {
            node = { event, depth: round.depth + 1, parent: round.event.seq };
        } else {
            node = { event, depth: turn ? 1 : 0, parent: turn?.event.seq ?? null };
        }
        nodes.push(node);
    }
    return nodes;
}

// The events under a turn or round, without the header itself.
export function descendants(nodes: readonly TraceNode[], seq: number): TraceEvent[] {
    const start = nodes.findIndex(n => n.event.seq === seq);
    if (start < 0) return [];
    const out: TraceEvent[] = [];
    for (let i = start + 1; i < nodes.length && nodes[i].depth > nodes[start].depth; i++) out.push(nodes[i].event);
    return out;
}

export interface TraceStats {
    rounds: number;
    tools: number;
    failed: number;
    prompt: number;
    completion: number;
    ms: number;   // time spent in the model and in tools
}

export function traceStats(events: readonly TraceEvent[]): TraceStats {
    const stats: TraceStats = { rounds: 0, tools: 0, failed: 0, prompt: 0, completion: 0, ms: 0 };
    for (const e of events) {
        if (e.kind === 'round') stats.rounds++;
        if (e.kind === 'tool') stats.tools++;
        if (e.status === 'failed') stats.failed++;
        stats.prompt += e.usage?.prompt ?? 0;
        stats.completion += e.usage?.completion ?? 0;
        if (e.kind === 'round' || e.kind === 'tool') stats.ms += e.ms ?? 0;
    }
    return stats;
}

export const formatMs = (ms: number): string => ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round(ms % 60000 / 1000)} s`;
export const formatSize = (chars: number): string => chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(1)} KB`;
export const formatCount = (n: number): string => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;

// The whole turn (header included) that an event belongs to.
export function turnEvents(nodes: readonly TraceNode[], seq: number): TraceEvent[] {
    let i = nodes.findIndex(n => n.event.seq === seq);
    while (i > 0 && nodes[i].event.kind !== 'turn') i--;
    if (i < 0) return [];
    return [nodes[i].event, ...descendants(nodes, nodes[i].event.seq)];
}
