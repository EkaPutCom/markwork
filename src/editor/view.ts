// MarkdownView: the Markdown editor widget with live formatting.
//
// Brings GtkSourceView together with the modules in this folder:
//   tags.ts         text styles
//   highlighter.ts  runs every time the text changes
//   decorations.ts  runs every time the cursor changes line
//   lists.ts        Enter and Tab
//   clicks.ts       clicking task boxes and Ctrl+click on links
//   wikicomplete.ts note name suggestions while typing [[
//   images.ts       images displayed below their line
//   codehighlight.ts  code block contents colored according to their language
//   tablelayer.ts   tables rendered as a grid, tableedit.ts edits them
//   mermaid.ts      ```mermaid blocks rendered as a diagram (mermaidrender.ts)
//
// This widget knows nothing about files, menus, or the sidebar. It reports
// through callbacks installed by the window (window.ts):
//   onHighlighted({ text, headings })   after highlighting
//   onCursorMoved(line, column)         after the cursor moves
//   onMessage(text)                     a short message for the user
//   onViewImage(pixbuf, title)          an image is asked to be enlarged (double click / menu command)
//   getBaseDir()                        folder for relative links
//   onOpenNote(link)                    Ctrl+click [[note]]
//   onOpenDocument(path)                Ctrl+click a link to a Markdown file; false = open with another app
//   listNotes()                         Markdown files in the project, for [[ suggestions

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type GdkPixbuf from 'gi://GdkPixbuf';
import { onClick, onKeyPress } from '../gtkutil.js';

import { ListIndent } from './listindent.js';
import { createTags, paintTags, setTagMargins, SYNTAX_TAGS } from './tags.js';
import { LineTagger } from './tagsync.js';
import { highlight, HighlightCache } from './highlighter.js';
import { MarkerConcealer, dimOutsideParagraph } from './decorations.js';
import { continueBlock, indentListItem, isInCodeBlock } from './lists.js';
import { toggleTaskAt, linkAt, wikiLinkAt } from './clicks.js';
import { WikiCompleter } from './wikicomplete.js';
import type { WikiLink } from '../markdown/wikilink.js';
import { ImageLayer } from './images.js';
import { CodeHighlighter } from './codehighlight.js';
import { TableLayer } from './tablelayer.js';
import { CodeLayer } from './codelayer.js';
import { MermaidLayer } from './mermaid.js';
import { cellStart, type TableRange } from '../markdown/table.js';
import { enterInTable, tabInTable, runTableCommand, type TableCommand } from './tableedit.js';
import { cpLength } from './offsets.js';
import type { Tags } from './tags.js';
import type { LineSpan } from './tagsync.js';
import type { HighlightResult, Heading, Marker } from './highlighter.js';
import type { Palette } from '../colors.js';
import { iterAtLine } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';

const TEXT_WIDTH = 780;  // maximum text column width, in pixels

// Incremental highlighting when opening a document (see setText()): this many lines from the start
// are tagged immediately, the rest is fed in per FILL_BUDGET_MS in idle. Its priority is above
// GtkTextView's background layout (GTK_TEXT_VIEW_PRIORITY_VALIDATE = 125) so lines are laid out
// once with their final tags, and below drawing (GDK_PRIORITY_REDRAW = 120) so the
// screen keeps being updated while the feeding runs.
const FILL_FIRST_LINES = 200;
const FILL_CHUNK_LINES = 100;
const FILL_BUDGET_MS = 8;
const FILL_PRIORITY = GLib.PRIORITY_HIGH_IDLE + 22;

export type Mode = 'source' | 'focus' | 'typewriter';

// Replace the whole TextView contents (through `replace`), then show from the start.
//
// GTK gives height 0 to lines that have not been laid out. If the first image covers the area
// below the lines already laid out, GTK may lay out all lines to the end of the document at once
// on the main thread (in GTK 3 opening a 650 KB manuscript froze for ±0.6 seconds). That is why the old
// scroll position is zeroed first, and the scroll to the cursor is queued: GTK then lays out the screen around
// the cursor before drawing and the rest little by little in the background.
//
// Scroll to the cursor only if the TextView already has a size. Before that (the window is not shown yet,
// or a new tab in the Stack) GTK 4 stores the scroll and then runs it with geometry that
// does not exist yet, so the document opens in the middle or at the end, not at the start.
export function replaceAllText(view: Gtk.TextView, replace: () => void): void {
    view.get_vadjustment()?.set_value(0);
    replace();
    const buf = view.buffer;
    buf.place_cursor(buf.get_start_iter());
    if (view.get_height() > 0) view.scroll_to_mark(buf.get_insert(), 0, false, 0, 0);
}

export class MarkdownView {
    readonly buffer: GtkSource.Buffer;
    readonly view: GtkSource.View;
    readonly widget: Gtk.ScrolledWindow;
    readonly tags: Tags;
    readonly images: ImageLayer;
    readonly code: CodeHighlighter;
    readonly tableLayer: TableLayer;
    readonly codeLayer: CodeLayer;
    readonly mermaid: MermaidLayer;

    markers: Marker[] = [];
    headings: Heading[] = [];
    lines: string[] = [];
    tables: TableRange[] = [];
    starts: number[] = [];
    spans: LineSpan[][] = [];
    modes: Record<Mode, boolean> = { source: false, focus: false, typewriter: false };

    onHighlighted: (result: HighlightResult) => void = () => {};
    onCursorMoved: (line: number, column: number) => void = () => {};
    onMessage: (text: string) => void = () => {};
    onViewImage: (pixbuf: GdkPixbuf.Pixbuf, title: string) => void = () => {};  // an image is asked to be enlarged
    getBaseDir: () => string = () => GLib.get_home_dir();
    onOpenNote: (link: WikiLink) => void = () => {};
    onOpenDocument: (path: string) => boolean = () => false;
    listNotes: () => string[] = () => [];
    readonly completer: WikiCompleter;

    private readonly listIndent: ListIndent;
    private margin = -1;
    private width = -1;
    private cursorKey = '';
    private highlightQueued = 0;
    private resetHighlight = false;
    private highlightCache: HighlightCache;
    private cursorQueued = 0;
    private fillQueued = 0;
    private destroyed = false;
    private cursorForce = false;
    private syntaxTagger: LineTagger;
    private concealer: MarkerConcealer;
    // The text range edited since the last highlighting. Uses a mark so it shifts
    // along if there is another edit before the highlighting runs.
    private dirty = false;
    private dirtyStart: Gtk.TextMark;
    private dirtyEnd: Gtk.TextMark;

    constructor() {
        this.buffer = new GtkSource.Buffer();
        this.buffer.set_highlight_syntax(false);
        this.buffer.set_highlight_matching_brackets(false);
        this.view = new GtkSource.View({
            buffer: this.buffer, wrap_mode: Gtk.WrapMode.WORD_CHAR, auto_indent: true,
            pixels_above_lines: 3, pixels_below_lines: 3, pixels_inside_wrap: 4,
            top_margin: 48, bottom_margin: 240, tab_width: 4,
        });
        this.view.add_css_class('editor');
        this.tags = createTags(this.buffer);
        const syntaxTags = SYNTAX_TAGS.map(n => this.tags[n]);
        // List indent tags are created on demand; LineTagger needs to know in order to clear them.
        this.listIndent = new ListIndent(this.view, this.buffer, tag => syntaxTags.push(tag));
        this.highlightCache = new HighlightCache(this.listIndent);
        this.syntaxTagger = new LineTagger(this.buffer, syntaxTags);
        this.concealer = new MarkerConcealer(new LineTagger(this.buffer, [this.tags.hidden]), this.tags.hidden);
        this.dirtyStart = this.buffer.create_mark(null, this.buffer.get_start_iter(), true);
        this.dirtyEnd = this.buffer.create_mark(null, this.buffer.get_start_iter(), false);

        // Code color tags are created later, so their priority is automatically above 'codeblock'.
        // 'dim' (focus mode) and 'hidden' must stay on top.
        this.code = new CodeHighlighter(this.buffer);
        this.code.onTagAdded = () => {
            const top = this.buffer.get_tag_table().get_size() - 1;
            this.tags.dim.set_priority(top);
            this.tags.hidden.set_priority(top);
        };

        this.tableLayer = new TableLayer(this.view, this.tags.tablehide);
        // Click on a cell in the grid → cursor to that cell in the raw text (which opens the table).
        this.tableLayer.onActivate = (line, col) => {
            const text = this.lines[line] ?? '';
            const it = iterAtLine(this.buffer, line);
            it.forward_chars(cpLength(text.slice(0, cellStart(text, col))));
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        this.codeLayer = new CodeLayer(this.view, this.tags.codehide, this.code);
        // Click on a code box → cursor to the first line of its contents, so the block opens for editing.
        this.codeLayer.onActivate = line => {
            this.buffer.place_cursor(iterAtLine(this.buffer, line));
            this.view.grab_focus();
        };

        this.mermaid = new MermaidLayer(this.view, this.tags.mermaidhide);
        this.mermaid.onZoom = (pixbuf, title) => this.onViewImage(pixbuf, title);
        // Click on a diagram → cursor to the last code line, so its code opens.
        this.mermaid.onActivate = line => {
            const it = iterAtLine(this.buffer, line);
            it.forward_to_line_end();
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        this.images = new ImageLayer(this.view);
        this.images.onZoom = (line, index) => this.zoomImage(line, index);
        this.images.getBaseDir = () => this.getBaseDir();
        // Click on an image → cursor to its line, so the ![alt](url) syntax appears.
        this.images.onActivate = line => {
            const it = iterAtLine(this.buffer, line);
            it.forward_to_line_end();
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        // EXTERNAL, not NEVER: with NEVER, the TextView's minimum width (= its current width
        // + margin) is passed up to the window, so the window cannot shrink and
        // keeps growing every time the margin is recomputed.
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, hexpand: true, vexpand: true });
        this.widget.set_child(this.view);

        this.completer = new WikiCompleter(this.view);
        this.completer.listNotes = () => this.listNotes();

        this.buffer.connect_after('insert-text', (_b, end, text) => {
            this.completer.queue(true);
            const start = end.copy();
            start.backward_chars(cpLength(text));
            this.markDirty(start, end);
        });
        this.buffer.connect_after('delete-range', (_b, start) => {
            this.completer.queue(false);
            this.markDirty(start, start);
        });
        this.buffer.connect('changed', () => this.queueHighlight());
        this.buffer.connect('mark-set', (_b, _i, mark) => {
            if (mark === this.buffer.get_insert() || mark === this.buffer.get_selection_bound()) {
                this.queueCursorUpdate();
                this.completer.queue(false);
            }
        });
        // The margin is computed from the width of the visible area (page_size of the horizontal adjustment,
        // filled in by the TextView when allocated), not from the TextView's width, which is itself determined
        // by that margin. GTK 4 has no size-allocate signal.
        // Transparent until the first margin is applied: without this the first frame of a new editor
        // is drawn with margin 0 (text stuck to the left) before the idle in updateMargins().
        const hadj = this.widget.get_hadjustment();
        this.widget.set_opacity(0);
        hadj.connect('changed', () => this.updateMargins(hadj.get_page_size()));
        // CAPTURE phase: runs before GtkSourceView's built-in key/click handling
        // (auto-indent, Tab, placing the cursor), just like the GTK 3 handler that preceded it.
        onKeyPress(this.view, (keyval, state) => this.onKey(keyval, state), Gtk.PropagationPhase.CAPTURE);
        onClick(this.view, (count, x, y, state) => this.onClick(count, x, y, state))
            .set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    }

    // Stop all pending work. GTK 4 no longer emits "destroy" for widgets
    // still held by JavaScript, so the editor's owner (the window) must call this when a
    // tab or the window is closed. Detaching the widget from its parent is up to its owner.
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.highlightQueued) GLib.source_remove(this.highlightQueued);
        this.highlightQueued = 0;
        if (this.cursorQueued) GLib.source_remove(this.cursorQueued);
        this.cursorQueued = 0;
        if (this.fillQueued) GLib.source_remove(this.fillQueued);
        this.fillQueued = 0;
        this.images.destroy();
        this.tableLayer.destroy();
        this.codeLayer.destroy();
        this.mermaid.destroy();
        this.completer.destroy();
    }

    get isDestroyed(): boolean {
        return this.destroyed;
    }

    // ---------- Contents and display ----------

    getText(): string {
        const [s, e] = this.buffer.get_bounds();
        return this.buffer.get_text(s, e, true);
    }

    // Replace the whole contents without entering the undo history (used when opening a file).
    setText(text: string): void {
        const buf = this.buffer;
        this.resetHighlight = true;
        // Long document: syntax tags and hidden markers are applied incrementally (queueFill()).
        // Parsing is still complete because the document structure (lines, headings) is needed right away.
        this.syntaxTagger.defer(FILL_FIRST_LINES);
        this.concealer.defer(FILL_FIRST_LINES);
        replaceAllText(this.view, () => {
            buf.begin_irreversible_action();
            buf.set_text(text, -1);
            buf.end_irreversible_action();
            buf.set_modified(false);
        });
        this.highlight();
    }

    // Replace the document contents with the smallest possible edit (only the differing middle part),
    // in a single undo step. Used by the kanban board to write its changes to the text.
    replaceText(text: string): void {
        const old = this.getText();
        let head = 0;
        const max = Math.min(old.length, text.length);
        while (head < max && old[head] === text[head]) head++;
        let tail = 0;
        while (tail < max - head && old[old.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
        if (head === old.length && head === text.length) return;   // no change

        // The cut boundary must not split a surrogate pair (emoji): move the start back, the end forward.
        const isLow = (c: number) => c >= 0xDC00 && c <= 0xDFFF;
        if (head < old.length && isLow(old.charCodeAt(head))) head--;
        if (tail > 0 && isLow(old.charCodeAt(old.length - tail))) tail--;

        const buf = this.buffer;
        const cp = (n: number) => Array.from(old.slice(0, n)).length;
        const from = buf.get_iter_at_offset(cp(head));
        const to = buf.get_iter_at_offset(cp(old.length - tail));
        buf.begin_user_action();
        buf.delete(from, to);
        buf.insert(from, text.slice(head, text.length - tail), -1);
        buf.end_user_action();
    }

    setPalette(palette: Palette): void {
        paintTags(this.tags, palette);
        this.code.setScheme(palette.codeScheme);
        this.tableLayer.setPalette(palette);
        this.codeLayer.setPalette();
        this.mermaid.setTheme({ dark: palette.dark, bg: palette.bg, fg: palette.fg, accent: palette.accent, node: palette.codeBg });
        this.highlight();  // recolor code blocks with the new scheme
    }

    // name: 'source' | 'focus' | 'typewriter'
    setMode(name: Mode, enabled: boolean): void {
        this.modes[name] = enabled;
        if (name === 'source') {
            this.images.setEnabled(!enabled);
            this.tableLayer.setEnabled(!enabled);
            this.codeLayer.setEnabled(!enabled);
            this.mermaid.setEnabled(!enabled);
        }
        this.queueCursorUpdate(true);
    }

    jumpToLine(n: number): void {
        const it = iterAtLine(this.buffer, n);
        it.forward_to_line_end();
        this.buffer.place_cursor(it);
        this.view.grab_focus();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.destroyed) return GLib.SOURCE_REMOVE;
            this.view.scroll_to_mark(this.buffer.get_insert(), 0, true, 0, 0.15);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Cursor position in code points, to be remembered and then restored with restoreCursor().
    get cursorOffset(): number {
        return this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_offset();
    }

    // Put the cursor at offset (clamped to the end of the document if the file got shorter) and scroll there.
    // Without grab_focus(): a background tab's editor must not steal focus. The scroll is deferred to idle
    // so it applies after the editor gets a size, including tabs that have never been shown.
    restoreCursor(offset: number): void {
        this.buffer.place_cursor(this.buffer.get_iter_at_offset(Math.max(0, offset)));
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.destroyed) return GLib.SOURCE_REMOVE;
            this.view.scroll_to_mark(this.buffer.get_insert(), 0, true, 0, 0.3);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Centered text column: the left/right margins follow the window width.
    private updateMargins(width: number): void {
        if (width <= 0) return;   // not allocated yet; wait for the real width
        const m = Math.max(36, Math.floor((width - TEXT_WIDTH) / 2));
        if (m === this.margin && width === this.width) return;
        this.margin = m;
        this.width = width;
        // Do not resize while GTK is allocating; defer to idle.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.destroyed) return GLib.SOURCE_REMOVE;
            this.view.set_left_margin(m);
            this.view.set_right_margin(m);
            setTagMargins(this.tags, m);
            this.listIndent.setMargin(m);
            this.images.setMaxWidth(width - 2 * m);
            this.tableLayer.setMaxWidth(width - 2 * m);
            this.codeLayer.setMaxWidth(width - 2 * m);
            this.mermaid.setMaxWidth(width - 2 * m);
            this.widget.set_opacity(1);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Highlighting cycle ----------
    //
    // Text changed    → queueHighlight()    → highlight()  → updateCursor(true)
    // Cursor moved    → queueCursorUpdate() → updateCursor()
    //
    // Both are deferred to PRIORITY_HIGH_IDLE: several consecutive changes are merged
    // into one pass, and the pass finishes before GTK redraws the screen
    // so it does not flicker.

    queueHighlight(): void {
        if (this.destroyed || this.highlightQueued) return;
        this.highlightQueued = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.highlightQueued = 0;
            this.highlight();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Record the edited range; used by highlight() to determine which lines'
    // tags can no longer be trusted.
    private markDirty(start: Gtk.TextIter, end: Gtk.TextIter): void {
        const buf = this.buffer;
        if (!this.dirty || start.compare(buf.get_iter_at_mark(this.dirtyStart)) < 0) buf.move_mark(this.dirtyStart, start);
        if (!this.dirty || end.compare(buf.get_iter_at_mark(this.dirtyEnd)) > 0) buf.move_mark(this.dirtyEnd, end);
        this.dirty = true;
    }

    highlight(): void {
        if (this.destroyed) return;
        // setText() highlights right away: cancel the callback created by the changed signal.
        if (this.highlightQueued) GLib.source_remove(this.highlightQueued);
        this.highlightQueued = 0;
        const reset = this.resetHighlight;
        this.resetHighlight = false;
        let edited: [number, number] | null = null;
        if (this.dirty) {
            const buf = this.buffer;
            const first = buf.get_iter_at_mark(this.dirtyStart).get_line();
            const last = buf.get_iter_at_mark(this.dirtyEnd).get_line();
            edited = [first, last];
            this.dirty = false;
            const count = buf.get_line_count();
            this.syntaxTagger.edited(first, last, count);
            this.concealer.edited(first, last, count);
        }
        const result = highlight(this.buffer, this.tags, this.syntaxTagger, this.highlightCache, reset ? undefined : edited);
        // Without edits, the cache returns the same result: no lines are re-parsed.
        if (result.markers !== this.markers) this.concealer.reparsed(result.markers, ...result.reparsed);
        this.markers = result.markers;
        this.lines = result.lines;
        this.headings = result.headings;
        this.tables = result.tables;
        this.starts = result.starts;
        this.spans = result.spans;
        const touches = (first: number, last: number) => edited !== null && last >= edited[0] && first <= edited[1];
        this.tableLayer.update(result.tables, result.lines, reset || result.tables.some(t => touches(t.start, t.end)));
        this.code.apply(result.codeBlocks, reset || result.codeBlocks.some(b => touches(b.startLine, b.endLine)));
        this.codeLayer.update(result.codeBlocks, reset || result.codeBlocks.some(b => touches(b.startLine, b.endLine)));
        this.mermaid.update(result.codeBlocks);
        this.images.update(result.images);
        this.onHighlighted(result);
        this.updateCursor(true);
        if (this.syntaxTagger.pending) this.queueFill();
        else if (!this.fillQueued) {
            // Short document: nothing is deferred, do not defer lines added later.
            this.syntaxTagger.defer(Infinity);
            this.concealer.defer(Infinity);
        }
    }

    // true = all lines have been tagged (no highlighting installments remain).
    get highlightComplete(): boolean {
        return !this.fillQueued && !this.syntaxTagger.pending;
    }

    // Feed in the tags of lines deferred by setText(). Lines around the cursor and the currently visible ones
    // come first, so jumping to the end of the document before the feeding finishes still shows
    // formatted text. (Before GTK finishes laying out, the visible area cannot be trusted: lines
    // not yet laid out are 0 high. That is why the cursor position is used too.)
    private queueFill(): void {
        if (this.destroyed || this.fillQueued) return;
        this.fillQueued = GLib.idle_add(FILL_PRIORITY, () => {
            // The text changed but has not been highlighted: line offsets are stale. highlight() (HIGH_IDLE) first.
            if (this.dirty) return GLib.SOURCE_CONTINUE;
            const start = GLib.get_monotonic_time();
            let done = false;
            while (!done && GLib.get_monotonic_time() - start < FILL_BUDGET_MS * 1000) {
                const visible = this.priorityLines();
                const spans = this.spans;
                this.syntaxTagger.applyLines(visible, i => spans[i], this.starts);
                const syntaxDone = this.syntaxTagger.fill(FILL_CHUNK_LINES, i => spans[i], this.starts);
                done = this.concealer.fill(FILL_CHUNK_LINES, visible) && syntaxDone;
            }
            if (!done) return GLib.SOURCE_CONTINUE;
            this.fillQueued = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // The currently visible lines and FILL_CHUNK_LINES lines around the cursor, ascending.
    private priorityLines(): number[] {
        const rect = this.view.get_visible_rect();
        const [top] = this.view.get_line_at_y(rect.y);
        const [bottom] = this.view.get_line_at_y(rect.y + rect.height);
        const cursor = this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_line();
        const lines = new Set<number>();
        // Before GTK validation, thousands of 0-high lines can be considered visible.
        // Do not apply them all at once and defeat the installment time limit.
        if (bottom.get_line() - top.get_line() <= FILL_FIRST_LINES)
            for (let l = top.get_line(); l <= bottom.get_line(); l++) lines.add(l);
        for (let l = cursor - FILL_CHUNK_LINES; l <= cursor + FILL_CHUNK_LINES; l++) lines.add(l);
        return [...lines].filter(l => l >= 0 && l < this.starts.length).sort((a, b) => a - b);
    }

    queueCursorUpdate(force = false): void {
        this.cursorForce ||= force;
        if (this.destroyed || this.cursorQueued) return;
        this.cursorQueued = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.cursorQueued = 0;
            this.updateCursor(this.cursorForce);
            this.cursorForce = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    updateCursor(force = false): void {
        const buf = this.buffer;
        const ins = buf.get_iter_at_mark(buf.get_insert());
        // The text has changed but has not been highlighted: markers and line numbers still belong to the
        // old text. The highlight() already queued will call updateCursor(true).
        if (this.dirty) {
            this.onCursorMoved(ins.get_line(), ins.get_line_offset());
            return;
        }
        const sel = buf.get_iter_at_mark(buf.get_selection_bound());
        const l0 = Math.min(ins.get_line(), sel.get_line());
        const l1 = Math.max(ins.get_line(), sel.get_line());

        // Decorations only need to be recomputed if the active line changes.
        const key = `${l0}:${l1}`;
        if (force || key !== this.cursorKey) {
            this.cursorKey = key;
            this.concealer.apply(this.starts, l0, l1, !this.modes.source);
            dimOutsideParagraph(buf, this.tags.dim, this.lines, l0, l1, this.modes.focus);
            this.tableLayer.setCursor(l0, l1);
            this.codeLayer.setCursor(l0, l1);
            this.mermaid.setCursor(l0, l1);
            if (this.modes.typewriter)
                this.view.scroll_to_mark(buf.get_insert(), 0, true, 0, 0.5);
        }
        this.onCursorMoved(ins.get_line(), ins.get_line_offset());
    }

    // ---------- Input ----------

    // Called for every key. true = handled, GTK does not process it any further.
    onKey(keyval: number, state: number): boolean {
        if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) return false;
        if (this.completer.onKey(keyval)) return true;
        if (this.buffer.get_has_selection()) return false;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const tab = keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab;
        const enter = keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter;
        // Shift+Tab arrives as ISO_Left_Tab.
        const back = shift || keyval === Gdk.KEY_ISO_Left_Tab;
        const line = this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_line();
        const inTable = this.tables.some(t => line >= t.start && line <= t.end);
        // Inside a table: Tab/Shift+Tab move between cells, Enter moves between rows.
        if (inTable && tab) return tabInTable(this.buffer, back);
        if (inTable && enter && !shift) return enterInTable(this.buffer);
        if (enter) return !shift && this.enter(line);
        return tab && indentListItem(this.buffer, back);
    }

    // Enter outside a table: continue a list, quote, or task on the next line (not inside a code block).
    private enter(line: number): boolean {
        if (isInCodeBlock(this.lines, line) || !continueBlock(this.buffer)) return false;
        this.view.scroll_mark_onscreen(this.buffer.get_insert());
        return true;
    }

    // Left button pressed at (x, y), TextView widget coordinates. count = which click it is
    // (2 = double click, which is left for GTK to select a word).
    onClick(count: number, x: number, y: number, state: number): boolean {
        if (count !== 1) return false;
        const [bx, by] = this.view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, Math.round(x), Math.round(y));
        const [ok, iter] = this.view.get_iter_at_location(bx, by);
        if (!ok) return false;

        if (toggleTaskAt(this.buffer, iter, this.tags)) return true;

        if (state & Gdk.ModifierType.CONTROL_MASK) {
            const wiki = wikiLinkAt(this.buffer, iter, this.tags);
            if (wiki) {
                this.onOpenNote(wiki);
                return true;
            }
            const url = linkAt(this.buffer, iter, this.tags);
            if (url) {
                this.openUrl(url);
                return true;
            }
        }
        return false;
    }

    // Zoom the image on line `line` (default: the cursor line).
    zoomImage(line?: number, index = 0): void {
        const target = line ?? this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_line();
        const found = this.images.imageAt(target, index);
        if (found.ok) this.onViewImage(found.pixbuf, found.title);
        else this.onMessage(found.reason);
    }

    // Table commands from the menu/shortcut. Failure messages are shown through onMessage.
    tableCommand(command: TableCommand): void {
        const result = runTableCommand(this.buffer, command);
        if (!result.ok) this.onMessage(result.reason);
        this.view.grab_focus();
    }

    openUrl(url: string): void {
        let uri = url;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            const bare = url.replace(/[#?].*$/, '');
            const path = GLib.path_is_absolute(bare) ? bare : GLib.build_filenamev([this.getBaseDir(), decodeURI(bare)]);
            // Links to other Markdown notes are opened in Markwork itself, like [[wikilink]].
            if (/\.(md|markdown|mdown|mkd)$/i.test(path) && this.onOpenDocument(path)) return;
            uri = Gio.File.new_for_path(path).get_uri();
        }
        const root = this.view.get_root();
        new Gtk.UriLauncher({ uri }).launch(root instanceof Gtk.Window ? root : null, null, (launcher, result) => {
            try {
                launcher!.launch_finish(result);
            } catch {
                if (!this.destroyed) this.onMessage(fmt(_('Cannot open {url}'), { url }));
            }
        });
    }
}
