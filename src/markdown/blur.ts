// Blurring a text for a report of a problem with the editor (docs/design/debugger.md, section 9): every Latin letter
// becomes x or X and every digit 0, while the Markdown around them stays, which is what a bug of the editor needs.
// Each letter is replaced by one of the same UTF-16 width, so every offset, selection, and step of a repro still holds.
// Emoji and the letters of other scripts stay as they are: they are a common cause of width and offset bugs, and
// replacing them could make such a bug go away.

import { highlightText, type Styles } from './highlight.js';
import { RE } from './syntax.js';
import { findSegments } from './fields.js';
import { makeU16Map } from './offsets.js';

// The styles are not needed, only where the syntax is.
const NO_STYLES = new Proxy({}, { get: () => 0 }) as Styles<number>;

const LATIN = /\p{Script=Latin}/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:(\/\/)?/i;
const FENCE = /^\s*(`{3,}|~{3,})/;

function blurred(c: string): string {
    if (c >= '0' && c <= '9') return '0';
    if (!LATIN.test(c)) return c;
    return c === c.toLowerCase() ? 'x' : 'X';
}

// What keeps its letters and digits, per UTF-16 unit: a fence's language and a link's scheme, which decide how the text
// is drawn, the line prefixes (a list's number, a task's box), and the keys of fields. Punctuation always stays, so
// the rest of the syntax needs no marking; the words inside hidden syntax (a note link's target, a picture's alt text,
// a link's address) are blurred like any other.
function syntaxOf(text: string): Uint8Array {
    const keep = new Uint8Array(text.length);
    const mark = (from: number, to: number) => keep.fill(1, from, to);
    const parse = highlightText(text, NO_STYLES);
    const u16 = makeU16Map(text);
    for (const [a, b] of parse.markers) {
        const from = u16(a), piece = text.slice(from, u16(b));
        if (FENCE.test(piece)) mark(from, from + piece.length);
        else if (piece.startsWith('](')) mark(from + 2, from + 2 + (SCHEME.exec(piece.slice(2))?.[0].length ?? 0));
    }
    const inCode = new Set<number>();
    for (const block of parse.codeBlocks) for (let line = block.startLine; line <= block.endLine; line++) inCode.add(line);
    let start = 0;
    for (const [i, line] of text.split('\n').entries()) {
        if (!inCode.has(i)) {
            const quote = RE.quote.exec(line)?.[0].length ?? 0;
            const list = RE.list.exec(line.slice(quote))?.[0].length ?? 0;
            mark(start, start + quote + list);
        }
        start += line.length + 1;
    }
    for (const segment of findSegments(text)) mark(segment.start, text.indexOf('::', segment.start) + 2);
    return keep;
}

export function blurText(text: string): string {
    const keep = syntaxOf(text);
    let out = '';
    for (let i = 0; i < text.length; i++) out += keep[i] ? text[i] : blurred(text[i]);
    return out;
}
