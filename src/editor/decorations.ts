// Decorations that depend on the cursor position. Called every time the cursor changes line.

import type Gtk from 'gi://Gtk?version=4.0';
import type { Marker } from '../markdown/highlight.js';
import { setTagRanges, type LineSpan, type LineTagger } from './tagsync.js';
import { iterAtLine } from '../gtkutil.js';

// Core of the hidden-syntax effect: hide all markers, except those active on
// lines l0..l1 (the cursor line or the selected lines).
//
// Called on every keystroke and every time the cursor changes line, so it must not do work proportional to
// the document length. The default state of a line is "all markers hidden"; only the
// active lines differ. That is why only the old and new active lines,
// the lines re-parsed by the highlighter, and lines whose tags are not yet known (LineTagger) are checked.
export class MarkerConcealer {
    private markers: Marker[] = [];
    private multiLine: Marker[] = [];   // markers active across several lines (code block fences)
    private active: number[] = [];      // lines installed in the active state, ascending
    private recheck: [number, number][] = [];
    private enabled: boolean | null = null;
    private state: { starts: number[]; l0: number; l1: number; enabled: boolean } | null = null;   // last apply()

    constructor(private readonly tagger: LineTagger, private readonly tag: Gtk.TextTag) {}

    // Text edited at lines first..last (current line numbers), the line count is now `count`.
    edited(first: number, last: number, count: number): void {
        const shift = count - this.tagger.lineCount;
        // Lines in the edit range become "unknown" to the tagger and are always checked.
        this.active = this.active.flatMap(l => l < first ? [l] : l > last - shift ? [l + shift] : []);
        this.recheck = this.recheck.map(([a, b]): [number, number] => b < first ? [a, b] : a > last - shift ? [a + shift, b + shift]
            : [Math.min(a, first), Math.max(b + shift, last)]);
        this.tagger.edited(first, last, count);
    }

    // The highlighter re-parses lines first..last: their markers may change even though the text
    // does not (e.g. a new ``` fence turns the lines below it into code block content).
    reparsed(markers: Marker[], first: number, last: number): void {
        this.markers = markers;
        this.multiLine = markers.filter(m => m[2] !== m[3]);
        if (last >= first) this.recheck.push([first, last]);
    }

    apply(starts: number[], l0: number, l1: number, enabled: boolean): void {
        this.state = { starts, l0, l1, enabled };
        const count = starts.length;
        const visit = new Set<number>(this.active);
        const active: number[] = [];
        if (enabled) {
            for (let l = Math.max(0, l0); l <= l1 && l < count; l++) active.push(l);
            for (const m of this.multiLine) if (!(m[3] < l0 || m[2] > l1) && m[4] < count) active.push(m[4]);
        }
        for (const l of active) visit.add(l);
        for (const [a, b] of this.recheck) for (let l = Math.max(0, a); l <= b && l < count; l++) visit.add(l);
        this.recheck = [];
        const spansOf = (line: number) => this.spansOf(line);
        if (enabled !== this.enabled) {
            // Source mode turned on/off: the default state of every line changes.
            this.enabled = enabled;
            this.tagger.apply(starts.map((_, i) => spansOf(i)), starts);
        } else {
            // Deferred lines (see defer()) are still installed if active: the cursor is there.
            const forced = new Set(active);
            this.tagger.applyLines([...visit].sort((a, b) => a - b), spansOf, starts, line => forced.has(line));
        }
        this.active = [...new Set(active)].sort((a, b) => a - b);
    }

    // Incremental highlighting: see LineTagger.defer()/fill().
    defer(line: number): void {
        this.tagger.defer(line);
    }

    // Install line `visible` (if deferred) and the next `lines` deferred lines.
    // true = nothing is deferred anymore.
    fill(lines: number, visible: number[]): boolean {
        if (!this.state) return true;
        const spansOf = (line: number) => this.spansOf(line);
        this.tagger.applyLines(visible, spansOf, this.state.starts);
        return this.tagger.fill(lines, spansOf, this.state.starts);
    }

    private spansOf(line: number): LineSpan[] {
        const { starts, l0, l1, enabled } = this.state!;
        if (!enabled) return [];
        const markers = this.markers;
        const spans: LineSpan[] = [];
        for (let k = lowerBound(markers, line); k < markers.length && markers[k][4] === line; k++) {
            const [a, b, r0, r1] = markers[k];
            if (r1 < l0 || r0 > l1) spans.push([this.tag, a - starts[line], b - starts[line]]);
        }
        return spans;
    }
}

// Index of the first marker on line `line` (markers are ordered by their lines).
function lowerBound(markers: Marker[], line: number): number {
    let a = 0, b = markers.length;
    while (a < b) { const mid = (a + b) >>> 1; if (markers[mid][4] < line) a = mid + 1; else b = mid; }
    return a;
}

// Focus mode: dim all text outside the paragraph containing lines l0..l1.
// A paragraph = consecutive lines delimited by blank lines.
export function dimOutsideParagraph(buffer: Gtk.TextBuffer, tag: Gtk.TextTag, lines: string[], l0: number, l1: number, enabled: boolean): void {
    if (!enabled || !lines.length) {
        setTagRanges(buffer, tag, []);
        return;
    }
    const blank = (n: number) => !lines[n] || !lines[n].trim();
    let b0 = l0, b1 = l1;
    while (b0 > 0 && !blank(b0 - 1)) b0--;
    while (b1 < lines.length - 1 && !blank(b1 + 1)) b1++;
    const s = iterAtLine(buffer, b0);
    const e = iterAtLine(buffer, b1);
    e.forward_to_line_end();
    setTagRanges(buffer, tag, [[0, s.get_offset()], [e.get_offset(), buffer.get_char_count()]]);
}
