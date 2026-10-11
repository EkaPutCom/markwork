// Turns inline Markdown text (table cell contents) into Pango markup for Gtk.Label:
// **bold**, *italic*, ~~strikethrough~~, ==highlight==, `code`, and [links](url).
// The Markdown markers themselves are dropped. Pure TypeScript without GTK.

import { parseInline } from './inline.js';
import { ESCAPE_OR_CODE } from './syntax.js';
import { WIKILINK } from './wikilink.js';

// URI scheme of [[note]] links in markup; labels that use it handle the activate-link signal.
export const NOTE_URI = 'markwork-note:';

export interface MarkupColors {
    code: string;
    codeBg: string;
    link: string;
    mark: string;
}

const BOLD = 1, ITALIC = 2, STRIKE = 4, CODE = 8, LINK = 16, MARK = 32, HIDDEN = 64;

const FLAG_OF = {
    bold: BOLD, italic: ITALIC, bolditalic: BOLD | ITALIC, strike: STRIKE, mark: MARK,
    code: CODE, link: LINK, image: ITALIC | LINK, marker: HIDDEN,
} as const;

export const escapeMarkup = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function attributes(flags: number, colors: MarkupColors): string {
    const attrs: string[] = [];
    if (flags & BOLD) attrs.push('font_weight="bold"');
    if (flags & ITALIC) attrs.push('font_style="italic"');
    if (flags & STRIKE) attrs.push('strikethrough="true"');
    if (flags & CODE) attrs.push(`font_family="monospace" foreground="${colors.code}" background="${colors.codeBg}"`);
    if (flags & LINK) attrs.push(`foreground="${colors.link}" underline="single"`);
    if (flags & MARK) attrs.push(`background="${colors.mark}"`);
    return attrs.join(' ');
}

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

// links = true: [[note]] is wrapped in <a href="markwork-note:…"> so it can be clicked in a Gtk.Label.
export function cellMarkup(text: string, colors: MarkupColors, links = false): string {
    // One style marker per UTF-16 unit; overlapping styles (bold inside italic) are merged.
    const flags = new Uint8Array(text.length);
    for (const [name, a, b] of parseInline(text).tags)
        for (let i = a; i < b; i++) flags[i] |= FLAG_OF[name];

    const wiki = links ? wikiRanges(text) : null;
    let out = '';
    for (let i = 0; i < text.length;) {
        let j = i;
        const link = wiki?.get(i);
        if (link) j = link[0];
        else while (j < text.length && flags[j] === flags[i]) j++;
        if (!(flags[i] & HIDDEN)) {
            const attrs = attributes(flags[i], colors);
            const piece = escapeMarkup(text.slice(i, j));
            const styled = attrs ? `<span ${attrs}>${piece}</span>` : piece;
            out += link ? `<a href="${escapeMarkup(NOTE_URI + encodeURIComponent(link[1]))}">${styled}</a>` : styled;
        }
        i = j;
    }
    return out;
}
