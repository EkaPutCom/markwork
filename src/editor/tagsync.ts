// Applies tags by difference: only the ranges that changed are touched.
//
// Removing tags across the whole buffer and then applying them again is simple, but for tags
// that affect size (font, line spacing) GTK then lays out the whole document again, and
// that is the most expensive thing when typing or moving the cursor in a long document.

import type Gtk from 'gi://Gtk?version=4.0';
import type { LineSpan as SyntaxSpan } from '../markdown/highlight.js';

// Range [start, end) in code point offsets.
export type Range = [start: number, end: number];

// Ranges where `tag` is currently applied, in order.
export function tagRanges(buffer: Gtk.TextBuffer, tag: Gtk.TextTag): Range[] {
    const out: Range[] = [];
    const it = buffer.get_start_iter();
    if (!it.has_tag(tag) && !it.forward_to_tag_toggle(tag)) return out;
    for (;;) {
        const a = it.get_offset();
        it.forward_to_tag_toggle(tag);
        out.push([a, it.get_offset()]);
        if (!it.forward_to_tag_toggle(tag)) return out;
    }
}

// Sort and merge overlapping or adjacent ranges; empty ranges are dropped.
export function normalize(ranges: Range[]): Range[] {
    const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const out: Range[] = [];
    for (const [a, b] of sorted) {
        const last = out[out.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
    }
    return out;
}

// The part of `a` not covered by `b` (both already normalized).
export function subtract(a: Range[], b: Range[]): Range[] {
    const out: Range[] = [];
    let j = 0;
    for (const [s0, e] of a) {
        let s = s0;
        while (j < b.length && b[j][1] <= s) j++;
        for (let k = j; k < b.length && b[k][0] < e; k++) {
            if (b[k][0] > s) out.push([s, b[k][0]]);
            s = Math.max(s, b[k][1]);
        }
        if (s < e) out.push([s, e]);
    }
    return out;
}

// Make the buffer's tags match `wanted`.
export function setTagRanges(buffer: Gtk.TextBuffer, tag: Gtk.TextTag, wanted: Range[]): void {
    const want = normalize(wanted);
    const have = tagRanges(buffer, tag);
    const span = new IterPair(buffer);
    for (const [a, b] of subtract(have, want)) buffer.remove_tag(tag, ...span.at(a, b));
    for (const [a, b] of subtract(want, have)) buffer.apply_tag(tag, ...span.at(a, b));
}

// Two iters reused for range [a, b). Creating a new iter (get_iter_at_offset)
// in GJS is 3× more expensive than set_offset() on an existing iter, and when opening a
// document there are thousands of tag ranges. Applying/removing tags does not invalidate iters; only
// text changes do, so IterPair must not be used across edits.
export class IterPair {
    private readonly start: Gtk.TextIter;
    private readonly end: Gtk.TextIter;

    constructor(buffer: Gtk.TextBuffer) {
        this.start = buffer.get_start_iter();
        this.end = this.start.copy();
    }

    at(a: number, b: number): [Gtk.TextIter, Gtk.TextIter] {
        this.start.set_offset(a);
        this.end.set_offset(b);
        return [this.start, this.end];
    }
}

// Like setTagRanges for a group of tags at once; tags not mentioned in `wanted`
// are removed entirely.
export function setTagGroup(buffer: Gtk.TextBuffer, tags: Iterable<Gtk.TextTag>, wanted: Map<Gtk.TextTag, Range[]>): void {
    for (const tag of new Set([...tags, ...wanted.keys()])) setTagRanges(buffer, tag, wanted.get(tag) ?? []);
}

// ---------- Tags per line ----------
//
// For tags whose range is always within one line (syntax highlighting, hidden
// markers). LineTagger remembers the tags last applied on each line, so the
// next application only touches lines whose tags differ or whose text was edited.
// Tags shift along with the text in a GtkTextBuffer, so unedited lines keep
// the same tags even though their position moved.

// Tags on one line: offsets relative to the start of the line; the end may include the newline.
export type LineSpan = SyntaxSpan<Gtk.TextTag>;

const sameSpans = (a: LineSpan[], b: LineSpan[]): boolean =>
    a.length === b.length && a.every((s, k) => s[0] === b[k][0] && s[1] === b[k][1] && s[2] === b[k][2]);

// Unknown line ranges this small are cleared with tagsIn(), not all tags.
const FEW_LINES = 8;

export class LineTagger {
    private applied: (LineSpan[] | null)[] = [];   // null = not known yet, reapply
    // Unknown lines from this number on are deferred: apply()/applyLines() skip them and fill()
    // fills them in little by little (incremental highlighting when opening a long document).
    private deferFrom = Infinity;

    // allTags: all managed tags, removed from lines whose contents are unknown.
    constructor(private readonly buffer: Gtk.TextBuffer, private readonly allTags: Gtk.TextTag[]) {}

    // Number of lines known to the tagger (the document line count at the last apply/edited).
    get lineCount(): number {
        return this.applied.length;
    }

    // true = there are still deferred lines.
    get pending(): boolean {
        return this.deferFrom < this.applied.length;
    }

    // Defer applying tags to unknown lines from line `line`; Infinity = nothing is deferred.
    defer(line: number): void {
        this.deferFrom = line;
    }

    // Text edited at lines first..last (current line numbers), the line count is now `count`.
    // Lines before and after are unchanged, only shifted.
    edited(first: number, last: number, count: number): void {
        const old = this.applied;
        const shift = count - old.length;
        this.applied = Array.from({ length: count }, (_, i) =>
            i < first ? old[i] ?? null : i > last ? old[i - shift] ?? null : null);
    }

    // spans[i] = tags for line i; starts[i] = start offset of line i.
    apply(spans: LineSpan[][], starts: number[]): void {
        if (this.applied.length !== spans.length) this.applied = spans.map(() => null);
        this.run(spans.length, k => k, i => spans[i], starts, true);
    }

    // Like apply(), but only checks the lines in `lines` (ascending, no duplicates)
    // plus lines whose tags are not yet known. Other lines are assumed correct, so the
    // caller does not need to compose tags for the whole document. Lines in `lines` that
    // are deferred are only applied if forced(line) (default: all, e.g. the visible lines).
    applyLines(lines: number[], spansOf: (line: number) => LineSpan[], starts: number[], forced: (line: number) => boolean = () => true): void {
        const count = starts.length;
        if (this.applied.length !== count) this.applied = starts.map(() => null);
        const visit: number[] = [];
        let k = 0;
        for (let i = 0; i < count; i++) {
            while (k < lines.length && lines[k] < i) k++;
            const deferred = !this.applied[i] && i >= this.deferFrom;
            if (lines[k] === i ? !deferred || forced(i) : !this.applied[i] && !deferred) visit.push(i);
        }
        this.run(visit.length, n => visit[n], spansOf, starts, false);
    }

    // Apply the next `lines` deferred lines. true = nothing is deferred anymore.
    fill(lines: number, spansOf: (line: number) => LineSpan[], starts: number[]): boolean {
        const end = this.deferFrom + lines;
        this.deferFrom = end >= starts.length ? Infinity : end;
        this.applyLines([], spansOf, starts);
        return !this.pending;
    }

    // Tags managed by this tagger that are applied in [s, e). A freshly edited line usually
    // has only a few tags: walking the toggles is cheaper than remove_tag for
    // all tags (±30 calls per keystroke).
    private tagsIn(s: Gtk.TextIter, e: Gtk.TextIter): Set<Gtk.TextTag> {
        const found = new Set<Gtk.TextTag>();
        const add = (tags: Gtk.TextTag[]) => { for (const tag of tags) if (this.allTags.includes(tag)) found.add(tag); };
        add(s.get_tags());
        const it = s.copy();
        while (it.forward_to_tag_toggle(null) && it.compare(e) < 0) add(it.get_toggled_tags(true));
        return found;
    }

    // Visit lines lineAt(0..count-1) (ascending) and make their tags match spansOf.
    // skipDeferred: skip unknown deferred lines (see defer()).
    private run(count: number, lineAt: (k: number) => number, spansOf: (line: number) => LineSpan[], starts: number[], skipDeferred: boolean): void {
        const total = this.buffer.get_char_count();
        const span = new IterPair(this.buffer);
        const pass: Pass = {
            count, lineAt, spansOf, starts, span,
            lines: (first, last) => span.at(starts[first] ?? total, starts[last + 1] ?? total),
            deferred: line => skipDeferred && line >= this.deferFrom && !this.applied[line],
        };
        for (let k = 0; k < count; k++) {
            const i = lineAt(k);
            if (pass.deferred(i)) continue;
            const want = spansOf(i);
            const prev = this.applied[i];
            if (!prev) k = this.fillUnknown(pass, k, want);
            else if (prev !== want && !sameSpans(prev, want)) this.retag(pass, i, prev, want);
        }
    }

    // Lines from lineAt(k) whose tags are unknown: cleared and tagged at once (e.g. after setText). Returns the
    // index of the last line handled.
    private fillUnknown(pass: Pass, k: number, want: LineSpan[]): number {
        const { lineAt, spansOf, starts, span } = pass;
        let n = k;
        while (n + 1 < pass.count && lineAt(n + 1) === lineAt(n) + 1 && !this.applied[lineAt(n + 1)] && !pass.deferred(lineAt(n + 1))) n++;
        const i = lineAt(k), j = lineAt(n);
        const [s, e] = pass.lines(i, j);
        for (const tag of j - i < FEW_LINES ? this.tagsIn(s, e) : this.allTags) this.buffer.remove_tag(tag, s, e);
        // When opening/pasting a document, merge tag ranges that meet
        // so GTK does not receive thousands of operations for a long code block.
        const ranges = new Map<Gtk.TextTag, Range[]>();
        for (let line = i; line <= j; line++) {
            const spans = line === i ? want : spansOf(line);
            for (const [tag, a, b] of spans) {
                if (!ranges.has(tag)) ranges.set(tag, []);
                ranges.get(tag)!.push([starts[line] + a, starts[line] + b]);
            }
            this.applied[line] = spans;
        }
        for (const [tag, wanted] of ranges)
            for (const [a, b] of normalize(wanted))
                this.buffer.apply_tag(tag, ...span.at(a, b));
        return n;
    }

    // A known line whose tags changed: remove its old tags and apply the new ones.
    private retag(pass: Pass, i: number, prev: LineSpan[], want: LineSpan[]): void {
        const [s, e] = pass.lines(i, i);
        for (const tag of new Set(prev.map(p => p[0]))) this.buffer.remove_tag(tag, s, e);
        for (const [tag, a, b] of want)
            this.buffer.apply_tag(tag, ...pass.span.at(pass.starts[i] + a, pass.starts[i] + b));
        this.applied[i] = want;
    }
}

// One run() over a set of lines.
interface Pass {
    count: number;
    lineAt: (k: number) => number;
    spansOf: (line: number) => LineSpan[];
    starts: number[];
    span: IterPair;
    lines: (first: number, last: number) => [Gtk.TextIter, Gtk.TextIter];   // the range of lines first..last
    deferred: (line: number) => boolean;
}
