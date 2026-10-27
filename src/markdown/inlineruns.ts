// The visible text of one line of inline Markdown, cut into runs that share a style: **bold**, *italic*, ~~strike~~,
// ==mark==, `code`, and links. The Markdown markers are dropped. Pure TypeScript, and the one place where the line's
// styles are merged, so Pango (pango.ts), HTML (inlinehtml.ts), and any terminal renderer show the same text the same way.

import { parseInline } from './inline';
import { ESCAPE_OR_CODE } from './syntax';
import { WIKILINK } from './wikilink';

// URI scheme of [[note]] links in rendered output; a renderer that makes them clickable hands the target back through it.
export const NOTE_URI = 'markwork-note:';

// In the order a renderer should apply them: outermost first.
export const INLINE_STYLES = ['bold', 'italic', 'strike', 'code', 'link', 'mark'] as const;
export type InlineStyle = typeof INLINE_STYLES[number];

export interface InlineRun {
    text: string;
    styles: InlineStyle[];
    // The content between the brackets of a [[note]] link (`Spec#Color|color`); only when links were asked for.
    note?: string;
}

const BOLD = 1, ITALIC = 2, STRIKE = 4, CODE = 8, LINK = 16, MARK = 32, HIDDEN = 64;
const BIT_OF: Record<InlineStyle, number> = { bold: BOLD, italic: ITALIC, strike: STRIKE, code: CODE, link: LINK, mark: MARK };

const FLAG_OF = {
    bold: BOLD, italic: ITALIC, bolditalic: BOLD | ITALIC, strike: STRIKE, mark: MARK,
    code: CODE, link: LINK, image: ITALIC | LINK, marker: HIDDEN,
} as const;

// The visible text range of each [[link]] (same as parseInline) together with the content between its brackets.
function wikiRanges(text: string): Map<number, [number, string]> {
    const ranges = new Map<number, [number, string]>();
    if (!text.includes('[[')) return ranges;
    const plain = text.replace(ESCAPE_OR_CODE(), m => '\0'.repeat(m.length));
    for (const r of plain.matchAll(WIKILINK())) {
        const a = r.index, b = a + r[0].length;
        const ts = r[2] === undefined || !r[2].trim() ? a + 2 : a + 3 + r[1].length;
        if (r[1].trim() && b - 2 > ts) ranges.set(ts, [b - 2, r[0].slice(2, -2)]);
    }
    return ranges;
}

const stylesOf = (flags: number): InlineStyle[] => INLINE_STYLES.filter(s => flags & BIT_OF[s]);

// links = true: a [[note]] is a run of its own with `note` set, so the renderer can make it clickable.
export function inlineRuns(text: string, links = false): InlineRun[] {
    // One style marker per UTF-16 unit; overlapping styles (bold inside italic) are merged.
    const flags = new Uint8Array(text.length);
    for (const [name, a, b] of parseInline(text).tags)
        for (let i = a; i < b; i++) flags[i] |= FLAG_OF[name];

    const wiki = links ? wikiRanges(text) : null;
    const runs: InlineRun[] = [];
    for (let i = 0; i < text.length;) {
        let j = i;
        const link = wiki?.get(i);
        if (link) j = link[0];
        else while (j < text.length && flags[j] === flags[i]) j++;
        if (!(flags[i] & HIDDEN)) {
            const run: InlineRun = { text: text.slice(i, j), styles: stylesOf(flags[i]) };
            if (link) run.note = link[1];
            runs.push(run);
        }
        i = j;
    }
    return runs;
}
