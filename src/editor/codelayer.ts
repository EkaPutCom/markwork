// Displays code blocks (``` ... ```) as boxes that can be scrolled sideways.
//
// A GtkTextView can only wrap or not wrap all of its text: if code lines
// are left long, the width of the whole document widens. That is why, like tables
// (tablelayer.ts), code blocks are displayed as widgets attached above empty space
// inside the text, so the document contents do not change.
//
//   Cursor OUTSIDE the block → all lines of the block (including fences) are shrunk to ~1 px
//                         (tag codehide), space the height of the box is reserved below the last
//                         line, and the box is attached in that space.
//   Cursor INSIDE the block → the box is hidden and its raw (wrapped) text is shown for
//                         editing.
//
// Clicking the box puts the cursor on the first line of its contents, which opens the block for editing.
// Diagram blocks (mermaid, dbml) are handled by mermaid.ts; unclosed or empty
// blocks stay as text.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import type { CodeBlock } from '../markdown/highlight.js';
import type { CodeHighlighter } from './codehighlight.js';
import { diagramKind } from '../markdown/diagram.js';
import { setTagGroup, setTagRanges, type Range } from './tagsync.js';
import { OverlaySlots } from './overlays.js';
import { iterAtLine, lineSpanOffsets, onClick } from '../gtkutil.js';

const GAP = 12;         // distance above and below the box
const HIDDEN_LINE = 2;  // height of one hidden line (see tablelayer.ts)
const PAD_X = 12;
const PAD_Y = 8;

interface Block {
    start: number;           // opening fence line
    end: number;             // closing fence line
    lang: string;
    code: string;
    key: string;             // language + contents; matches the same block after lines shift
    lines: number;           // number of content lines
    widget: Gtk.Box | null;  // overlay slot containing the box; created the first time it is visible
    height: number;
    collapsed: boolean;      // true = shown as a box
    x: number;
    y: number;
}

export class CodeLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    onActivate: (line: number) => void = () => {};  // box clicked

    private cursor: [number, number] = [-1, -1];
    private gapTags = new Map<number, Gtk.TextTag>();   // height → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;
    private lineHeight = 0;
    private probe: Gtk.Label | null = null;
    private holder: Gtk.ScrolledWindow | null = null;   // gives the same CSS probe as the box
    private readonly slots: OverlaySlots;

    constructor(view: Gtk.TextView, private readonly hideTag: Gtk.TextTag, private readonly highlighter: CodeHighlighter) {
        this.view = view;
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
        this.probe = null;
        this.holder = null;
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
        adj.connect('value-changed', () => this.queueRelayout());
    }

    // The color scheme changed → the colored markup is rebuilt; the line height may change too (CSS).
    setPalette(): void {
        this.lineHeight = 0;
        for (const block of this.blocks) this.destroyWidget(block);
        this.sync();
    }

    setMaxWidth(width: number): void {
        width = Math.max(200, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        for (const block of this.blocks) block.widget?.get_first_child()?.set_size_request(width, -1);
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.sync();
    }

    // codeBlocks from highlighter.ts. force = the block text may have been replaced (its tag is gone),
    // so tags are reapplied even if the block list is the same.
    update(codeBlocks: CodeBlock[], force = false): void {
        const unused = [...this.blocks];
        const next: Block[] = [];
        let changed = force, moved = false;
        for (const found of codeBlocks) {
            if (!found.closed || found.text.trim() === '' || diagramKind(found)) continue;
            const key = `${found.lang}\0${found.text}`;
            const k = unused.findIndex(b => b.key === key);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                moved ||= block.start !== found.startLine || block.end !== found.endLine;
                block.start = found.startLine;
                block.end = found.endLine;
                next.push(block);
            } else {
                changed = true;
                next.push({
                    start: found.startLine, end: found.endLine, lang: found.lang, code: found.text, key,
                    lines: found.text.replace(/\n$/, '').split('\n').length,
                    widget: null, height: 0, collapsed: false, x: -1, y: -1,
                });
            }
        }
        changed ||= unused.length > 0;
        for (const block of unused) this.destroyWidget(block);
        this.blocks = next;
        if (!changed && this.blocks.every(b => b.collapsed === this.isCollapsed(b))) {
            // Tag ranges shift along in GTK (see TableLayer.update()); just move the widget.
            if (moved) this.queueRelayout();
            return;
        }
        this.sync();
    }

    // The cursor (or selection) is on lines first..last. Only blocks that switch between box
    // and raw text are touched: the cursor does not change text, so other blocks' tags stay correct.
    // Walking the tags of the whole buffer every time the cursor enters/leaves a block is too expensive (±4 ms
    // per move at 100 blocks, plus GTK relayout).
    setCursor(first: number, last: number): void {
        this.cursor = [first, last];
        let changed = false;
        for (const block of this.blocks) {
            const collapsed = this.isCollapsed(block);
            if (collapsed === block.collapsed) continue;
            changed = true;
            block.collapsed = collapsed;
            if (collapsed) block.height = block.lines * this.measureLine() + 2 * PAD_Y;
            else block.widget?.set_visible(false);
            const start = iterAtLine(this.buffer, block.start);
            const lastLine = iterAtLine(this.buffer, block.end);
            const end = lastLine.copy();
            end.forward_to_line_end();
            const gap = this.gapTag(this.reserved(block));
            if (collapsed) {
                this.buffer.apply_tag(this.hideTag, start, end);
                this.buffer.apply_tag(gap, lastLine, end);
            } else {
                this.buffer.remove_tag(this.hideTag, start, end);
                this.buffer.remove_tag(gap, lastLine, end);
            }
        }
        if (changed) this.queueRelayout();
    }

    private isCollapsed(block: Block): boolean {
        const [first, last] = this.cursor;
        return this.enabled && !(block.end >= first && block.start <= last);
    }

    private destroyWidget(block: Block): void {
        if (block.widget) this.slots.release(block.widget);
        block.widget = null;
    }

    // Height of one code line, measured from a label with the same CSS as the box.
    private measureLine(): number {
        if (!this.lineHeight) {
            if (!this.probe) {
                this.probe = new Gtk.Label({ label: 'Ag', xalign: 0 });
                this.holder = new Gtk.ScrolledWindow({ child: this.probe });
                this.holder.add_css_class('md-codeblock');
            }
            this.lineHeight = Math.max(1, this.probe.measure(Gtk.Orientation.VERTICAL, -1)[1]);
        }
        return this.lineHeight;
    }

    // Sync the text, blank space, and widgets with the current state.
    private sync(): void {
        const iter = this.buffer.get_start_iter();
        const hide: Range[] = [];
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.blocks) {
            block.collapsed = this.isCollapsed(block);
            if (!block.collapsed) { block.widget?.set_visible(false); continue; }
            block.height = block.lines * this.measureLine() + 2 * PAD_Y;

            const [first, lastLine, end] = lineSpanOffsets(iter, block.start, block.end);
            hide.push([first, end]);

            const gap = this.gapTag(this.reserved(block));
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([lastLine, end]);
        }
        setTagRanges(this.buffer, this.hideTag, hide);
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
        this.queueRelayout();
    }

    // Space below the last line (see TableLayer.reserved()).
    private reserved(block: Block): number {
        return Math.max(0, block.height + 2 * GAP - (block.end - block.start + 1) * HIDDEN_LINE);
    }

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `code-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    // ---------- Widget ----------

    private build(block: Block): void {
        const label = new Gtk.Label({
            use_markup: true, wrap: false, xalign: 0, yalign: 0,
            margin_start: PAD_X, margin_end: PAD_X, margin_top: PAD_Y, margin_bottom: PAD_Y,
        });
        label.set_markup(this.highlighter.markup(block.lang, block.code.replace(/\n$/, '')));
        const box = new Gtk.ScrolledWindow({
            child: label, hexpand: false,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: block.height, max_content_height: block.height,
        });
        box.set_size_request(this.maxWidth, block.height);
        box.add_css_class('md-codeblock');
        onClick(box, () => {
            this.onActivate(block.start + 1);
            return true;
        });
        block.widget = this.slots.acquire();
        block.widget.append(box);
        block.x = block.y = -1;
    }

    // ---------- Widget position ----------

    queueRelayout(): void {
        if (this.destroyed || this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            if (!this.destroyed) this.relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout(): void {
        if (!this.blocks.length) return;
        const x = this.view.get_left_margin();
        const rect = this.view.get_visible_rect();
        const [top] = this.view.get_line_at_y(rect.y);
        const [bottom] = this.view.get_line_at_y(rect.y + rect.height);
        const first = top.get_line(), last = bottom.get_line();
        for (const block of this.blocks) {
            // Only visible blocks are created and positioned (see TableLayer.relayout()).
            const visible = block.collapsed && block.end >= first && block.start <= last;
            if (visible && !block.widget) this.build(block);
            block.widget?.set_visible(visible);
            if (!visible || block.end >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.end));
            const y = lineY + lineHeight - block.height - GAP;
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.widget!, x, y);
        }
    }
}
