// The Markdown syntax of a document as data: what each line is styled as and what may be hidden, for every editor
// (the Electron window's CodeMirror, electron/renderer/lib/editor.ts). Parses only the edited range, until the
// block boundary is stable again, and reuses the rest of the last parse. It collects:
//
//   markers   ranges of syntax that may be hidden, together with the lines where
//             that syntax is "active": [start, end, firstLine, lastLine, line]
//             (offsets in code points; line = where the marker is). For
//             code blocks, the line range is the whole block, so the ``` fences
//             show up while the cursor is inside the block.
//   headings  list of headings for the outline: { level, text, line }
//   lines     document contents per line
//   images    images to display: { line, url, alt }
//   codeBlocks contents of code blocks together with their language, to be colored
//   tables    line range of each table, to be rendered as a grid
//   starts    offset (code point) of the start of each line
//   reparsed  line ranges that were re-parsed (other lines gave the same result as before)
//   spans     styles per line
//
// A style is whatever the editor applies (a CodeMirror decoration): the editor hands one per name
// (Styles<T>), and the spans carry it as it is, so an editor can compare and apply them without a lookup.

import { RE, isTableSeparator, type InlineTag } from './syntax.js';
import { findTables, type TableRange } from './table.js';
import { parseInline } from './inline.js';
import { makeCpMap, cpLength, countWords } from './offsets.js';

// The names a line can be styled with.
export type SyntaxName = InlineTag | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'codeblock' | 'fence' | 'quote' | 'quote2' | 'quote3'
    | 'hr' | 'table' | 'tablehead' | 'tablesep' | 'bullet' | 'task' | 'taskdone' | 'done';

// The editor's style for each name.
export type Styles<T> = Record<SyntaxName, T>;

// Styles on one line: offsets relative to the start of the line; the end may include the newline.
export type LineSpan<T> = [style: T, start: number, end: number];

// The style that lines up the wrapped lines of a list item with its text, given the parts of its prefix: indent +
// marker ("-", "1.") + gap + task ("[ ]"/"[x]" or '') + tail. Its width depends on how the editor draws the prefix.
export interface HangingIndent<T> {
    tag(indent: string, marker: string, gap: string, task: string, tail: string): T;
}

// The editor's text, read by line. lines(first, last) is the text of lines first..last split at '\n'; when the editor
// breaks lines elsewhere too , it gives a different count and the whole text is parsed.
export interface TextLines {
    readonly lineCount: number;
    all(): string;
    lines(first: number, last: number): string[];
}

// Syntax that may be hidden: [start, end, firstLine, lastLine, line].
export type Marker = [start: number, end: number, firstLine: number, lastLine: number, line: number];

export interface Heading {
    level: number;
    text: string;
    line: number;
}

export interface ImageRef {
    line: number;
    url: string;
    alt: string;
}

export interface CodeBlock {
    lang: string;     // text after ``` (e.g. "js"); '' if none
    start: number;    // offset (code point) of the start of the block contents in the buffer
    text: string;     // block contents without the fence lines
    startLine: number;  // opening fence line
    endLine: number;    // closing fence line (the last line of the document if not closed)
    closed: boolean;
}

export interface HighlightResult<T> {
    text: string;
    lines: string[];
    markers: Marker[];
    headings: Heading[];
    images: ImageRef[];
    codeBlocks: CodeBlock[];
    tables: TableRange[];
    starts: number[];
    words: number;
    characters: number;
    reparsed: [first: number, last: number];
    spans: LineSpan<T>[][];   // styles per line (offsets relative to the start of the line)
}

interface Parsed<T> extends HighlightResult<T> {
    checkpoints: number[];
    lineWords: number[];
}

// First index with key(item) >= value in an array sorted by key.
const lowerBoundBy = <T>(items: T[], value: number, key: (item: T) => number): number => {
    let a = 0, b = items.length;
    while (a < b) { const mid = (a + b) >>> 1; if (key(items[mid]) < value) a = mid + 1; else b = mid; }
    return a;
};
const lowerBound = (items: number[], value: number): number => lowerBoundBy(items, value, n => n);

// Like splice() for a list sorted by `line`: items before line `from` stay,
// items from line `to` onward are shifted by `shift` lines in place (the old snapshot is no longer used).
function spliceByLine<T extends { line: number }>(old: T[], from: number, to: number, shift: number, mid: T[]): T[] {
    const tail = lowerBoundBy(old, to, item => item.line);
    if (shift) for (let i = tail; i < old.length; i++) old[i].line += shift;
    return splice(old, lowerBoundBy(old, from, item => item.line), tail, mid);
}

// old[0..from) + mid + old[to..) (optionally changed with tail), copied once into a new array.
// Called on every keystroke for document-sized arrays; spread/slice/map would create several
// intermediate copies that burden the GC.
function splice<T>(old: T[], from: number, to: number, mid: T[], tail?: (item: T) => T): T[] {
    const out = new Array<T>(from + mid.length + Math.max(0, old.length - to));
    let k = 0;
    for (let i = 0; i < from; i++) out[k++] = old[i];
    for (let i = 0; i < mid.length; i++) out[k++] = mid[i];
    if (tail) for (let i = to; i < old.length; i++) out[k++] = tail(old[i]);
    else for (let i = to; i < old.length; i++) out[k++] = old[i];
    return out;
}

// A line outside code/tables without a pipe is a neutral boundary. It cannot
// become a table header/continuation. A new fence may extend the parsing range.
function checkpoints(lines: string[], code: CodeBlock[], tables: TableRange[]): number[] {
    const points: number[] = [];
    let c = 0, t = 0;
    for (let i = 0; i < lines.length; i++) {
        if (code[c]?.startLine === i) { i = code[c++].endLine; continue; }
        if (tables[t]?.start === i) { i = tables[t++].end; continue; }
        if (!lines[i].includes('|')) points.push(i);
    }
    return points;
}

interface CachedLine<T> {
    spans: LineSpan<T>[];
    markers: [number, number][];
    headings: Omit<Heading, 'line'>[];
    images: Omit<ImageRef, 'line'>[];
}

// The old snapshot with old lines startLine..endLine replaced by `part`; everything after them shifts by `shift` lines.
function merge<T>(old: Parsed<T>, lines: string[], part: Parsed<T>, startLine: number, endLine: number, shift: number): Parsed<T> {
    const afterOld = endLine + 1;
    const base = old.starts[startLine];
    const oldLength = (old.starts[afterOld] ?? old.characters) - base;
    const delta = part.characters + (afterOld < old.lines.length ? 1 : 0) - oldLength;
    let oldWords = 0;
    for (let i = startLine; i < afterOld; i++) oldWords += old.lineWords[i];
    let text: string | null = null;
    return {
        get text() { return text ??= lines.join('\n'); },
        lines,
        starts: splice(old.starts, startLine, afterOld, part.starts.map(n => n + base), n => n + delta),
        lineWords: splice(old.lineWords, startLine, afterOld, part.lineWords),
        reparsed: [startLine, endLine + shift],
        words: old.words - oldWords + part.words,
        characters: old.characters + delta,
        spans: splice(old.spans, startLine, afterOld, part.spans),
        checkpoints: splice(old.checkpoints, lowerBound(old.checkpoints, startLine), lowerBound(old.checkpoints, afterOld),
            part.checkpoints.map(n => n + startLine), n => n + shift),
        markers: mergeMarkers(old.markers, part.markers, startLine, afterOld, base, delta, shift),
        headings: spliceByLine(old.headings, startLine, afterOld, shift, part.headings.map(h => ({ ...h, line: h.line + startLine }))),
        images: spliceByLine(old.images, startLine, afterOld, shift, part.images.map(img => ({ ...img, line: img.line + startLine }))),
        tables: [...old.tables.filter(t => t.end < startLine),
            ...part.tables.map(t => ({ start: t.start + startLine, end: t.end + startLine })),
            ...old.tables.filter(t => t.start >= afterOld).map(t => ({ start: t.start + shift, end: t.end + shift }))],
        codeBlocks: [...old.codeBlocks.filter(b => b.endLine < startLine),
            ...part.codeBlocks.map(b => ({ ...b, start: b.start + base, startLine: b.startLine + startLine, endLine: b.endLine + startLine })),
            ...old.codeBlocks.filter(b => b.startLine >= afterOld).map(b => ({ ...b, start: b.start + delta, startLine: b.startLine + shift, endLine: b.endLine + shift }))],
    };
}

// Markers are ordered by their line, so the old section boundary is found with a binary search.
// Markers after the parsed section are shifted in place: the old snapshot is no longer used
// and a long document can have tens of thousands of markers.
function mergeMarkers(old: Marker[], part: Marker[], startLine: number, afterOld: number, base: number, delta: number, shift: number): Marker[] {
    const markerAt = (line: number) => lowerBoundBy(old, line, m => m[4]);
    const tail = markerAt(afterOld);
    if (delta || shift) {
        for (let i = tail; i < old.length; i++) {
            const m = old[i];
            m[0] += delta; m[1] += delta; m[2] += shift; m[3] += shift; m[4] += shift;
        }
    }
    return splice(old, markerAt(startLine), tail,
        part.map(([a, b, first, last, line]): Marker => [a + base, b + base, first + startLine, last + startLine, line + startLine]));
}

// The last parse of the whole document, updated by re-parsing only the lines around an edit.
export class HighlightCache<T> {
    private snapshot: Parsed<T> | null = null;
    parsedLines = 0;
    private readonly lineCache = new LineCache<T>();

    // indent: hanging indentation for wrapped list items (the editor's; none without a view to measure in).
    constructor(private readonly styles: Styles<T>, private readonly indent?: HangingIndent<T>) {}

    // edited: the lines first..last (current numbers) changed since the last update; null = nothing changed,
    // undefined = parse the whole text again.
    update(source: TextLines, edited?: [number, number] | null): HighlightResult<T> {
        const old = this.snapshot;
        this.parsedLines = 0;
        if (!old || edited === undefined) return this.full(source);
        if (!edited) return old;
        const [first, last] = edited;
        const shift = source.lineCount - old.lines.length;
        const afterOldEdit = last + 1 - shift;
        const changed = source.lines(first, last);
        if (afterOldEdit < first || changed.length !== last - first + 1)
            return this.full(source);  // delimiter that does not match the JS line splitting
        const lines = splice(old.lines, first, afterOldEdit, changed);
        const before = lowerBound(old.checkpoints, first);
        const startLine = before > 0 ? old.checkpoints[before - 1] : 0;
        const { part, endLine } = this.parseRange(lines, old, startLine, old.checkpoints[lowerBound(old.checkpoints, afterOldEdit)] ?? old.lines.length - 1, shift);
        return this.snapshot = merge(old, lines, part, startLine, endLine, shift);
    }

    private full(source: TextLines): Parsed<T> {
        const result = this.parse(source.all().split('\n'));
        this.parsedLines = result.lines.length;
        return this.snapshot = result;
    }

    private parse(lines: string[]): Parsed<T> {
        return new LineParser(lines, this.styles, this.lineCache, this.indent).parse();
    }

    // Parse old lines startLine..endLine (now shifted by `shift`). A new fence can change the context far below:
    // while the part ends inside an open code block, expand geometrically so paragraphs are not re-parsed one by one.
    private parseRange(lines: string[], old: Parsed<T>, startLine: number, endLine: number, shift: number): { part: Parsed<T>; endLine: number } {
        for (;;) {
            const part = this.parse(lines.slice(startLine, endLine + shift + 1));
            this.parsedLines += part.lines.length;
            if (endLine === old.lines.length - 1 || !part.codeBlocks.some(b => !b.closed)) return { part, endLine };
            const next = lowerBound(old.checkpoints, endLine + Math.max(16, endLine - startLine + 1));
            endLine = old.checkpoints[next] ?? old.lines.length - 1;
        }
    }
}

// A text held as one string, as TextLines.
export function textLines(text: string): TextLines {
    let split: string[] | null = null;
    const lines = () => split ??= text.split('\n');
    return { get lineCount() { return lines().length; }, all: () => text, lines: (first, last) => lines().slice(first, last + 1) };
}

// The syntax of a whole text, without keeping it for the next edit.
export function highlightText<T>(text: string, styles: Styles<T>, indent?: HangingIndent<T>): HighlightResult<T> {
    return new HighlightCache(styles, indent).update(textLines(text));
}

// Parse results per line text and block context, so an unchanged line is not parsed again. Only the lines of the
// current document are kept, not the whole edit history: a parse puts the lines it sees into a new generation
// (begin … end) and the older one is dropped. The cache holds relative offsets; offsets and block context are
// recomputed after the text shifts.
class LineCache<T> {
    private previous = new Map<string, CachedLine<T>>();
    private current = new Map<string, CachedLine<T>>();
    private length = 0;

    begin(): void { this.current = new Map(); this.length = 0; }
    get(key: string): CachedLine<T> | undefined { return this.current.get(key) ?? this.previous.get(key); }
    put(key: string, value: CachedLine<T>): void {
        if (this.current.has(key) || key.length > 4096 || this.current.size >= 10000 || this.length + key.length > 4194304) return;
        this.current.set(key, value);
        this.length += key.length;
    }
    end(): void { this.previous = this.current; }
}

type Fence = { line: number; ch: string; len: number; a: number; b: number; lang: string };

// One parse of a range of lines. Positions are in UTF-16 (JS strings) and converted to code points when recorded.
class LineParser<T> {
    private readonly text: string;
    private readonly toCp: (offset: number) => number;
    private readonly spans: LineSpan<T>[][];
    private readonly starts: number[] = [];
    private readonly markers: Marker[] = [];
    private readonly headings: Heading[] = [];
    private readonly images: ImageRef[] = [];
    private readonly codeBlocks: CodeBlock[] = [];
    // Tables are recognized first from the parsing range, so the rules are the same as
    // those used by the edit commands and HTML export (markdown/table.ts).
    private readonly tables: TableRange[];
    private readonly tableOf = new Map<number, TableRange>();
    private fence: Fence | null = null;
    // Each tag is applied on the line being processed (`row`, starting at code point `rowStart`).
    private row = 0;
    private rowStart = 0;

    constructor(private readonly lines: string[], private readonly styles: Styles<T>, private readonly cache: LineCache<T>, private readonly indent?: HangingIndent<T>) {
        this.text = lines.join('\n');
        this.toCp = makeCpMap(this.text);
        this.spans = lines.map(() => []);
        this.tables = findTables(lines);
        for (const t of this.tables) for (let l = t.start; l <= t.end; l++) this.tableOf.set(l, t);
    }

    parse(): Parsed<T> {
        const { lines, cache } = this;
        cache?.begin();
        for (let i = 0, off = 0; i < lines.length; off += lines[i].length + 1, i++) {
            this.row = i;
            this.rowStart = this.toCp(off);
            this.starts.push(this.rowStart);
            this.line(i, off);
        }
        const fence = this.fence;
        if (fence) {
            this.hide(fence.a, fence.b, fence.line, lines.length - 1);
            this.closeBlock(fence, lines.length);  // an unclosed block continues to the end of the document
        }
        cache?.end();
        const { text, markers, headings, images, codeBlocks, tables, starts, spans } = this;
        const lineWords = lines.map(countWords);
        return { text, lines, markers, headings, images, codeBlocks, tables, starts, spans, lineWords, reparsed: [0, lines.length - 1],
            words: lineWords.reduce((a, b) => a + b, 0), characters: cpLength(text),
            checkpoints: checkpoints(lines, codeBlocks, tables) };
    }

    private apply(name: SyntaxName, a: number, b: number): void {
        if (b > a) this.spans[this.row].push([this.styles[name], this.toCp(a) - this.rowStart, this.toCp(b) - this.rowStart]);
    }

    private hide(a: number, b: number, l0: number, l1: number, line = l0): void {
        if (b > a) this.markers.push([this.toCp(a), this.toCp(b), l0, l1, line]);
    }

    // withImages = false for table rows: an image below a table row breaks its layout.
    private inline(base: number, s: string, line: number, withImages = true): void {
        const { tags: found, marks, images } = parseInline(s);
        for (const [n, a, b] of found) this.apply(n, base + a, base + b);
        for (const [a, b] of marks) this.hide(base + a, base + b, line, line);
        if (!withImages) return;
        for (const img of images) {
            this.images.push({ line, url: img.url, alt: img.alt });
            // On an inactive line, the whole ![alt](url) is hidden
            // and only the image is visible (see electron/renderer/lib/images.ts).
            this.hide(base + img.start, base + img.end, line, line);
        }
    }

    // The code block ends at line lastLine (exclusive): record its contents.
    private closeBlock(f: Fence, lastLine: number): void {
        const lines = this.lines;
        this.codeBlocks.push({
            lang: f.lang, start: this.toCp(f.b), text: lines.slice(f.line + 1, lastLine).join('\n'),
            startLine: f.line, endLine: Math.min(lastLine, lines.length - 1), closed: lastLine < lines.length,
        });
    }

    private line(i: number, off: number): void {
        const text = this.lines[i];
        const row: Row = { i, text, off, end: off + text.length, nl: i < this.lines.length - 1 ? 1 : 0 };
        if (this.codeFence(row)) return;
        const table = this.tableOf.get(i);
        const role = !table ? '' : i === table.start ? 'head' : i === table.start + 1 ? 'separator' : 'body';
        const key = `${row.nl}:${role}\0${text}`;
        if (this.fromCache(key, i)) return;
        const markerStart = this.markers.length, headingStart = this.headings.length, imageStart = this.images.length;
        this.content(row, table);
        const rowStart = this.rowStart;
        this.cache?.put(key, {
            spans: this.spans[i],
            markers: this.markers.slice(markerStart).map(([a, b]) => [a - rowStart, b - rowStart]),
            headings: this.headings.slice(headingStart).map(({ level, text }) => ({ level, text })),
            images: this.images.slice(imageStart).map(({ url, alt }) => ({ url, alt })),
        });
    }

    // Inside a code block: no other formatting, look for the closing fence. Also opens a block. true = handled.
    private codeFence({ i, text, off, end, nl }: Row): boolean {
        const m = RE.fence.exec(text);
        const fence = this.fence;
        if (fence) {
            this.apply('codeblock', off, end + nl);
            if (m && m[2][0] === fence.ch && m[2].length >= fence.len && !m[3].trim()) {
                this.apply('fence', off, end);
                this.hide(fence.a, fence.b, fence.line, i);
                this.hide(off, end + nl, fence.line, i, i);
                this.closeBlock(fence, i);
                this.fence = null;
            }
            return true;
        }
        if (!m || m[2][0] === '`' && m[3].includes('`')) return false;
        this.fence = { line: i, ch: m[2][0], len: m[2].length, a: off, b: end + nl, lang: m[3].trim().split(/\s+/)[0] ?? '' };
        this.apply('codeblock', off, end + nl);
        this.apply('fence', off, end);
        return true;
    }

    // A line already parsed with the same text and block context: reuse its result, shifted to this line.
    private fromCache(key: string, i: number): boolean {
        const cached = this.cache?.get(key);
        if (!cached) return false;
        this.spans[i] = cached.spans;
        for (const [a, b] of cached.markers) this.markers.push([this.rowStart + a, this.rowStart + b, i, i, i]);
        for (const h of cached.headings) this.headings.push({ ...h, line: i });
        for (const img of cached.images) this.images.push({ ...img, line: i });
        this.cache!.put(key, cached);
        return true;
    }

    // A line outside code blocks: a heading, a rule, a table row, or text (possibly quoted, possibly a list item).
    private content(row: Row, table: TableRange | undefined): void {
        const heading = RE.heading.exec(row.text);
        if (heading) this.heading(row, heading[0].length, heading[1].length);
        else if (RE.hr.test(row.text)) this.apply('hr', row.off, row.end);
        else if (table) this.tableRow(row, table);
        else this.body(row, this.quote(row));
    }

    // An ATX heading: the marker (length pl) of level lvl is hidden; the text is formatted and listed in the outline.
    private heading({ i, text, off, end }: Row, pl: number, lvl: number): void {
        this.apply(`h${lvl}` as SyntaxName, off, end);  // lvl is always 1–6
        this.apply('marker', off, off + pl);
        this.hide(off, off + pl, i, i);
        this.inline(off + pl, text.slice(pl), i);
        this.headings.push({ level: lvl, text: text.slice(pl).replace(/\s+#+\s*$/, '').trim(), line: i });
    }

    private tableRow({ i, text, off, end }: Row, table: TableRange): void {
        this.apply('table', off, end);
        if (i === table.start) this.apply('tablehead', off, end);
        else if (i === table.start + 1 && isTableSeparator(text)) this.apply('tablesep', off, end);
        for (let k = 0; k < text.length; k++) if (text[k] === '|') this.apply('marker', off + k, off + k + 1);
        this.inline(off, text, i, false);
    }

    // A quote prefix ("> ", "> > "): tagged by depth and hidden. Returns its length (0 = not a quote).
    private quote({ i, text, off, end }: Row): number {
        const m = RE.quote.exec(text);
        if (!m) return 0;
        const p = m[0].length;
        const depth = (m[0].match(/>/g) ?? []).length;
        this.apply('quote', off, end);
        if (depth >= 2) this.apply(depth >= 3 ? 'quote3' : 'quote2', off, end);
        this.apply('marker', off, off + p);
        this.hide(off, off + p, i, i);
        return p;
    }

    // Text after the quote prefix (length p), which may be a list item: "> - item".
    private body({ i, text, off, end }: Row, p: number): void {
        const rest = text.slice(p);
        const m = RE.list.exec(rest);
        if (!m) { this.inline(off + p, rest, i); return; }
        const bs = off + p + m[1].length;
        this.apply('bullet', bs, bs + m[2].length);
        const q = p + m[0].length;
        // Continuation lines (from wrapping) line up with the item text. In a quote
        // the left margin is already set by the quote tag, so it is skipped.
        const hanging = p === 0 ? this.indent : undefined;
        if (hanging && end > off) {
            const tag = hanging.tag(m[1], m[2], m[3], m[4]?.slice(0, 3) ?? '', m[4]?.slice(3) ?? '');
            this.spans[this.row].push([tag, 0, this.toCp(end) - this.rowStart]);
        }
        if (m[4]) {
            const ts = off + p + m[1].length + m[2].length + m[3].length;
            const checked = /x/i.test(m[4]);
            this.apply(checked ? 'taskdone' : 'task', ts, ts + 3);
            if (checked) this.apply('done', off + q, end);
        }
        this.inline(off + q, text.slice(q), i);
    }
}

// The line being parsed: its index, text, and UTF-16 offsets of its start and end in the parsed range;
// nl = 1 when a newline follows (not on the last line).
interface Row {
    i: number;
    text: string;
    off: number;
    end: number;
    nl: number;
}
