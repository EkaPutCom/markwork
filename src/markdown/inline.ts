// Inline format parser (within one line): code, links, bold, italic, etc.
//
// The "masking" technique: once a part is recognized, its characters are replaced with '\0' in a
// copy of the string, so later patterns cannot recognize it again. Recognition order:
// escapes (\*) and inline code → [[wikilink]] → links/images → URLs → emphasis.
// Example: in `**x**` the ** part is already masked as code, so it does not become bold.
//
// Result: tags [name, start, end], marks [start, end] (syntax that may be
// hidden), and images [{ alt, url, start, end }].
// Positions are in UTF-16 units and relative to the start of the string.

import { EMPHASIS, ESCAPE_OR_CODE, type InlineTag } from './syntax';
import { WIKILINK } from './wikilink';

export interface InlineImage {
    alt: string;
    url: string;
    start: number;
    end: number;
}

export interface InlineResult {
    tags: [InlineTag, number, number][];
    marks: [number, number][];
    images: InlineImage[];
}

// Parses the inline formatting of one line. Result: tags [name, start, end] and
// "marker" ranges (syntax hidden while the cursor is on another line).
export function parseInline(s: string): InlineResult {
    const p = new InlineParser(s);
    p.escapesAndCode();
    p.wikiLinks();
    p.links();
    p.autoLinks();
    p.urls();
    p.emphasis();
    return { tags: p.tags, marks: p.marks, images: p.images };
}

// The stages share the masked copy of the line: a part recognized by one stage is invisible to the next.
class InlineParser {
    readonly tags: InlineResult['tags'] = [];
    readonly marks: InlineResult['marks'] = [];
    readonly images: InlineImage[] = [];
    // A line without syntax needs no character copy. After masking, rebuild
    // the string only if a new part was closed by an earlier stage.
    private m: string[] | null = null;
    private current: string;
    private changed = false;

    constructor(private readonly s: string) {
        this.current = s;
    }

    private mask(a: number, b: number): void {
        const m = this.m ??= this.s.split('');
        for (let i = a; i < b; i++) m[i] = '\0';
        this.changed = true;
    }

    private cur(): string {
        if (this.changed) { this.current = this.m!.join(''); this.changed = false; }
        return this.current;
    }

    private mark(a: number, b: number): void {
        if (b > a) { this.marks.push([a, b]); this.tags.push(['marker', a, b]); }
    }

    // \* → hide the backslash; `code` → code with hidden backticks.
    escapesAndCode(): void {
        const re = ESCAPE_OR_CODE();
        let r: RegExpExecArray | null;
        while ((r = re.exec(this.s))) {
            const a = r.index, b = a + r[0].length;
            if (r[1] !== undefined) {
                this.mark(a, a + 1);
            } else {
                const n = r[2].length;
                this.tags.push(['code', a + n, b - n]); this.mark(a, a + n); this.mark(b - n, b);
            }
            this.mask(a, b);
        }
    }

    // [[Note]] and [[Note|text]]: only the note name is visible, or the text when there is an alias.
    wikiLinks(): void {
        const t = this.cur();
        if (!t.includes('[[')) return;
        const re = WIKILINK();
        let r: RegExpExecArray | null;
        while ((r = re.exec(t))) {
            const a = r.index, b = a + r[0].length;
            const ts = r[2] === undefined || !r[2].trim() ? a + 2 : a + 3 + r[1].length;
            if (!r[1].trim() || b - 2 <= ts) continue;
            this.tags.push(['link', ts, b - 2]);
            this.mark(a, ts); this.mark(b - 2, b); this.mask(a, b);
        }
    }

    // [text](url) and ![alt](url "title").
    links(): void {
        const t = this.cur();
        const re = /(!?)\[([^\]\0]*)\]\(([^)\0]*)\)/g;
        let r: RegExpExecArray | null;
        while ((r = re.exec(t))) {
            const a = r.index, b = a + r[0].length;
            const ts = a + r[1].length + 1, te = ts + r[2].length;
            this.tags.push([r[1] ? 'image' : 'link', ts, te]);
            this.mark(a, ts); this.mark(te, b); this.mask(a, ts); this.mask(te, b);
            // Image: url without the optional title, e.g. ![alt](photo.png "Title")
            if (r[1]) this.images.push({ alt: r[2], url: r[3].trim().split(/\s+/)[0] ?? '', start: a, end: b });
        }
    }

    // <https://…>
    autoLinks(): void {
        const t = this.cur();
        const re = /<((?:https?|mailto|ftp):[^\s>\0]+)>/g;
        let r: RegExpExecArray | null;
        while ((r = re.exec(t))) {
            const a = r.index, b = a + r[0].length;
            this.tags.push(['link', a + 1, b - 1]); this.mark(a, a + 1); this.mark(b - 1, b); this.mask(a, b);
        }
    }

    // A bare https://… URL, without trailing punctuation.
    urls(): void {
        const t = this.cur();
        const re = /\bhttps?:\/\/[^\s<>\0]*[^\s<>\0.,;:!?)\]'"]/g;
        let r: RegExpExecArray | null;
        while ((r = re.exec(t))) { this.tags.push(['link', r.index, r.index + r[0].length]); this.mask(r.index, r.index + r[0].length); }
    }

    // Bold, italic, strikethrough, highlight: each pattern sees what the previous ones left unmasked.
    emphasis(): void {
        for (const [name, re, n] of EMPHASIS) {
            const t = this.cur();
            re.lastIndex = 0;
            let r: RegExpExecArray | null;
            while ((r = re.exec(t))) {
                const a = r.index, b = a + r[0].length;
                this.tags.push([name, a + n, b - n]);
                this.mark(a, a + n); this.mark(b - n, b); this.mask(a, a + n); this.mask(b - n, b);
            }
        }
    }
}
