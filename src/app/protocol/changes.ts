// Text changes in code points, the unit of the protocol (docs/design/protocol.md, 4.4). A frontend whose editor counts
// UTF-16 units (CodeMirror, a textarea) converts at its edge with these; the core's replica applies them the same way.

import { makeCpMap, makeU16Map } from '../../markdown/offsets.js';
import type { Change } from './messages.js';

// Apply changes in order, each against the text as the previous one left it.
export function applyChanges(text: string, changes: readonly Change[]): string {
    for (const { from, to, insert } of changes) {
        const u16 = makeU16Map(text);
        text = text.slice(0, u16(from)) + insert + text.slice(u16(to));
    }
    return text;
}

// The smallest single change from `before` to `after`; none when they are equal.
export function diffChanges(before: string, after: string): Change[] {
    if (before === after) return [];
    const limit = Math.min(before.length, after.length);
    let start = 0;
    while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    // Never cut between the two halves of a surrogate pair.
    if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
    let end = 0;
    while (end < limit - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
    if (end > 0 && isLow(before.charCodeAt(before.length - end))) end--;
    const cp = makeCpMap(before);
    return [{ from: cp(start), to: cp(before.length - end), insert: after.slice(start, after.length - end) }];
}

const isHigh = (c: number) => c >= 0xD800 && c <= 0xDBFF;
const isLow = (c: number) => c >= 0xDC00 && c <= 0xDFFF;
