// The blocks of a document, for the visual editor's block handle: what can be added after and moved as one piece. A block
// is a paragraph, a heading, a rule, a quote, a list (its items and what is indented under them), a table, a fenced code
// block, or the frontmatter. Blocks are told apart by the lines between them; a heading or a list that follows a line
// without a blank one in between is a block of its own. Pure TypeScript: lines in, line ranges out.

import { RE } from './syntax.js';
import { findTables } from './table.js';

export type BlockKind = 'frontmatter' | 'heading' | 'rule' | 'quote' | 'list' | 'table' | 'code' | 'paragraph';

// Lines of a block (from 0, inclusive).
export interface Block {
    start: number;
    end: number;
    kind: BlockKind;
}

const blank = (line: string): boolean => !line.trim();

// The last line of a fenced block that opens at line `i` (the end of the document when it is never closed).
function fenceEnd(lines: readonly string[], i: number): number {
    const open = RE.fence.exec(lines[i])!;
    for (let k = i + 1; k < lines.length; k++) {
        const close = RE.fence.exec(lines[k]);
        if (close && close[2][0] === open[2][0] && close[2].length >= open[2].length && !close[3].trim()) return k;
    }
    return lines.length - 1;
}

// Does a line start something other than a plain paragraph line?
const startsBlock = (line: string): boolean => RE.heading.test(line) || RE.hr.test(line) || RE.fence.test(line) || RE.quote.test(line) || RE.list.test(line);

export function blocksOf(lines: readonly string[]): Block[] {
    const blocks: Block[] = [];
    const tables = new Map(findTables([...lines]).map(t => [t.start, t.end]));
    const take = (start: number, end: number, kind: BlockKind): number => { blocks.push({ start, end, kind }); return end + 1; };
    // The last line of the run that starts at `from` and goes on, over lines that are not blank, while `more` holds.
    const run = (from: number, more: (line: string, index: number) => boolean): number => {
        let end = from;
        while (end + 1 < lines.length && !blank(lines[end + 1]) && more(lines[end + 1], end + 1)) end++;
        return end;
    };
    let i = 0;
    if (lines[0]?.trim() === '---') {
        const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
        if (close > 0) i = take(0, close, 'frontmatter');
    }
    while (i < lines.length) {
        const line = lines[i];
        if (blank(line)) { i++; continue; }
        const tableEnd = tables.get(i);
        if (tableEnd !== undefined) i = take(i, tableEnd, 'table');
        else if (RE.fence.test(line)) i = take(i, fenceEnd(lines, i), 'code');
        else if (RE.heading.test(line)) i = take(i, i, 'heading');
        else if (RE.hr.test(line)) i = take(i, i, 'rule');
        else if (RE.quote.test(line)) i = take(i, run(i, l => RE.quote.test(l)), 'quote');
        else if (RE.list.test(line)) i = take(i, run(i, l => RE.list.test(l) ? !RE.hr.test(l) : /^[ \t]/.test(l)), 'list');
        else i = take(i, run(i, (l, k) => !startsBlock(l) && !tables.has(k)), 'paragraph');
    }
    return blocks;
}

// The index of the block that holds a line (from 0), or -1 for a blank line between blocks.
export const blockAt = (blocks: readonly Block[], line: number): number => blocks.findIndex(b => line >= b.start && line <= b.end);

// ---------- Moving a block ----------

// What moving a block changes: the lines `from`..`to` (from 0, inclusive) become `lines`, and the cursor goes to the line
// `cursor` of the whole document, where the moved block now starts.
export interface BlockMove {
    from: number;
    to: number;
    lines: string[];
    cursor: number;
}

// Move block `index` so that it comes before block `before` (blocks.length: after the last one). The blocks keep the lines
// between them in their places, except that a single line break between two of them becomes a blank line, so a block that
// lands against another cannot join it. Null when nothing would change.
export function moveBlock(lines: readonly string[], blocks: readonly Block[], index: number, before: number): BlockMove | null {
    if (index < 0 || index >= blocks.length || before === index || before === index + 1 || before < 0 || before > blocks.length) return null;
    const order = blocks.map((_, k) => k).filter(k => k !== index);
    order.splice(before > index ? before - 1 : before, 0, index);
    const first = Math.min(index, before > index ? before - 1 : before), last = Math.max(index, before > index ? before - 1 : before);
    const text = (k: number) => lines.slice(blocks[k].start, blocks[k].end + 1);
    const out: string[] = [];
    let cursor = blocks[first].start;
    for (let p = first; p <= last; p++) {
        if (p > first) {
            // The lines that were between the blocks at positions p - 1 and p stay; at least one blank line.
            const gap = lines.slice(blocks[p - 1].end + 1, blocks[p].start);
            out.push(...(gap.length ? gap : ['']));
        }
        if (order[p] === index) cursor = blocks[first].start + out.length;
        out.push(...text(order[p]));
    }
    return { from: blocks[first].start, to: blocks[last].end, lines: out, cursor };
}
