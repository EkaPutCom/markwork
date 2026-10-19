// Displays ```mermaid and ```dbml blocks as diagrams.
// DBML blocks (dbdiagram.io schema language) are first translated into a Mermaid ER diagram
// by markdown/dbml.ts, then rendered through the same path.
//
// It works the same as tables (tablelayer.ts) and images (images.ts): a widget is attached
// above empty space provided inside the text, so the document contents do not change.
// The diagram image is produced by mermaidrender.ts.
//
//   Cursor OUTSIDE the block → all lines of the block (including fences) are shrunk to ~1 px
//                         (tag mermaidhide) and only the diagram is visible.
//   Cursor INSIDE the block → the code is shown for editing, the diagram stays visible
//                         below it as a preview that updates while typing.
//
// Invalid code is never hidden: its error message appears below the block,
// so the code can be fixed right away.
//
// Rendering is delayed briefly after the code changes, so typing does not render every letter.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import type { CodeBlock } from '../markdown/highlight.js';
import { diagramKind, type Kind } from '../markdown/diagram.js';
import { mermaidRenderer, type DiagramTheme } from './mermaidrender.js';
import { dbmlToMermaid } from '../markdown/dbml.js';
import { setTagGroup, setTagRanges, type Range } from './tagsync.js';
import { OverlaySlots } from './overlays.js';
import { iterAtLine, lineSpanOffsets, onClick, removeChildren, textureFromPixbuf } from '../gtkutil.js';
import { _ } from '../i18n.js';

const GAP = 12;             // distance above and below the diagram
const NOTE_HEIGHT = 24;     // height of the "Rendering…" / error message
const MAX_HEIGHT = 640;     // maximum height of the displayed diagram
const DEBOUNCE_MS = 400;    // pause after the code changes before rendering

type Status = 'loading' | 'ok' | 'error';

export interface Block {
    start: number;           // opening fence line
    end: number;             // closing fence line
    kind: Kind;
    code: string;
    status: Status;
    busy: boolean;           // a render request is still pending
    pixbuf: GdkPixbuf.Pixbuf | null;   // the last successful diagram (stays visible while re-rendering)
    error: string | null;
    widget: Gtk.Box;         // overlay slot (see overlays.ts)
    content: Gtk.Box;
    height: number;
    collapsed: boolean;
    timer: number;
    x: number;
    y: number;
}

export class MermaidLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    onActivate: (line: number) => void = () => {};                        // diagram clicked once
    onZoom: (pixbuf: GdkPixbuf.Pixbuf, title: string) => void = () => {};  // diagram double-clicked

    private theme: DiagramTheme = { dark: false, bg: '#ffffff', fg: '#333333', accent: '#1c71d8', node: '#f3f4f4' };
    private cursor: [number, number] = [-1, -1];
    private signature = '';
    private gapTags = new Map<number, Gtk.TextTag>();   // height → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;
    private readonly slots: OverlaySlots;

    constructor(view: Gtk.TextView, private readonly hideTag: Gtk.TextTag) {
        this.view = view;
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    // Editor closed: stop the pending work (see MarkdownView.destroy()).
    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
        for (const b of this.blocks) this.cancelTimer(b);
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
    }

    // Theme changed → all diagrams are re-rendered with the new colors.
    setTheme(theme: DiagramTheme): void {
        if (JSON.stringify(theme) === JSON.stringify(this.theme)) return;
        this.theme = theme;
        for (const block of this.blocks) this.request(block, false);
    }

    // The text column width changed → rescale the diagrams.
    setMaxWidth(width: number): void {
        width = Math.max(100, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        for (const block of this.blocks) this.render(block);
        this.sync();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.sync();
    }

    // codeBlocks from highlighter.ts.
    update(codeBlocks: CodeBlock[]): void {
        const unused = [...this.blocks];
        const next: Block[] = [];
        const toRender: [Block, boolean][] = [];
        for (const found of codeBlocks) {
            const kind = diagramKind(found);
            if (!kind) continue;
            // Blocks with the same code are reused even if their lines shifted; a block whose
            // code was just changed (being typed) is recognized by its starting line.
            let k = unused.findIndex(b => b.kind === kind && b.code === found.text);
            const edited = k < 0;
            if (edited) k = unused.findIndex(b => b.kind === kind && b.start === found.startLine);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                block.start = found.startLine;
                block.end = found.endLine;
                if (edited) {
                    block.code = found.text;
                    toRender.push([block, true]);
                }
                next.push(block);
            } else {
                const block = this.createBlock(found);
                next.push(block);
                toRender.push([block, false]);
            }
        }
        for (const block of unused) this.destroyBlock(block);
        this.blocks = next;
        // After this.blocks is filled: results from the cache arrive immediately and are only accepted by registered blocks.
        for (const [block, delay] of toRender) this.request(block, delay);
        this.signature = '';
        this.sync();
    }

    // The cursor (or selection) is on lines first..last.
    setCursor(first: number, last: number): void {
        this.cursor = [first, last];
        if (this.stateSignature() !== this.signature) this.sync();
    }

    // ---------- Render ----------

    // Request an image for this block's code. delay = true while the code is being typed.
    private request(block: Block, delay: boolean): void {
        this.cancelTimer(block);
        block.busy = true;
        const code = block.code;
        const theme = this.theme;
        const renderer = mermaidRenderer();
        let source = code;
        if (block.kind === 'dbml') {
            try {
                source = dbmlToMermaid(code);
            } catch (e) {
                // DBML errors are reported immediately, without waiting for the typing pause.
                block.busy = false;
                block.status = 'error';
                block.error = e instanceof Error ? e.message : String(e);
                this.render(block);
                this.sync();
                return;
            }
        }
        const run = () => {
            block.timer = 0;
            renderer.render(source, theme, result => {
                // Old results (the code or theme has changed, or the block was discarded) are ignored.
                if (block.code !== code || this.theme !== theme || !this.blocks.includes(block)) return;
                block.busy = false;
                if (result.ok) {
                    block.status = 'ok';
                    block.pixbuf = result.pixbuf;
                    block.error = null;
                } else {
                    block.status = 'error';
                    block.error = result.error;
                }
                this.render(block);
                this.sync();
            });
        };
        const hit = renderer.cached(source, theme);
        if (hit || !delay) {
            run();
        } else {
            block.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => { run(); return GLib.SOURCE_REMOVE; });
        }
    }

    private cancelTimer(block: Block): void {
        if (block.timer) GLib.source_remove(block.timer);
        block.timer = 0;
    }

    // ---------- State ----------

    // A successfully rendered diagram replaces its code when the cursor is outside the block.
    private isCollapsed(block: Block): boolean {
        const [first, last] = this.cursor;
        return this.enabled && block.status === 'ok' && !(block.end >= first && block.start <= last);
    }

    private stateSignature(): string {
        return this.blocks.map(b => `${b.start}-${b.end}:${this.isCollapsed(b) ? 1 : 0}`).join(',');
    }

    // Sync the text, blank space, and widgets with the current state.
    private sync(): void {
        const iter = this.buffer.get_start_iter();
        const hide: Range[] = [];
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.blocks) {
            block.collapsed = this.isCollapsed(block);
            block.widget.set_visible(this.enabled);
            if (!this.enabled || block.end >= this.buffer.get_line_count()) continue;

            const [first, lastLine, end] = lineSpanOffsets(iter, block.start, block.end);
            if (block.collapsed) hide.push([first, end]);
            const gap = this.gapTag(block.height + 2 * GAP);
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([lastLine, end]);
        }
        setTagRanges(this.buffer, this.hideTag, hide);
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
        this.signature = this.stateSignature();
        this.queueRelayout();
    }

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `mermaid-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    // ---------- Widget ----------

    private createBlock(found: CodeBlock): Block {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        content.add_css_class('image-block');
        const widget = this.slots.acquire();
        widget.append(content);
        const block: Block = {
            start: found.startLine, end: found.endLine, kind: diagramKind(found)!, code: found.text, status: 'loading', busy: false, pixbuf: null, error: null,
            widget, content, height: NOTE_HEIGHT, collapsed: false, timer: 0, x: -1, y: -1,
        };
        onClick(content, count => {
            this.press(block, count === 2);
            return true;
        });
        this.render(block);
        return block;
    }

    private destroyBlock(block: Block): void {
        this.cancelTimer(block);
        this.slots.release(block.widget);
    }

    // Single click: the cursor enters the code (the code opens). Double click: zoom.
    press(block: Block, doubleClick: boolean): void {
        if (doubleClick) this.zoom(block);
        else this.onActivate(block.end - 1);
    }

    zoom(block: Block): void {
        if (block.pixbuf) this.onZoom(block.pixbuf, block.kind === 'dbml' ? _('DBML Diagram') : _('Mermaid Diagram'));
    }

    // Rebuild the widget contents according to the current status and column width.
    private render(block: Block): void {
        removeChildren(block.content);
        const note = (text: string, tooltip?: string) => {
            // No wrap: a widget inside a TextView is only given the minimum width.
            const label = new Gtk.Label({ label: text, xalign: 0 });
            label.add_css_class('image-note');
            if (tooltip) label.set_tooltip_text(tooltip);
            block.content.append(label);
            block.height = NOTE_HEIGHT;
        };

        if (block.status === 'error') {
            // The old diagram (if any) is hidden: what is shown must match the current code.
            note(`⚠ The diagram could not be rendered: ${block.error}`, block.error ?? undefined);
        } else if (block.pixbuf) {
            const pb = block.pixbuf;
            const scale = Math.min(1, this.maxWidth / pb.get_width(), MAX_HEIGHT / pb.get_height());
            const w = Math.max(1, Math.round(pb.get_width() * scale));
            const h = Math.max(1, Math.round(pb.get_height() * scale));
            const scaled = (scale < 1 ? pb.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR) : null) ?? pb;
            // Gtk.Image in GTK 4 is icon-sized; Picture is shown at the size of its image.
            const image = Gtk.Picture.new_for_paintable(textureFromPixbuf(scaled));
            image.set_can_shrink(false);
            image.set_halign(Gtk.Align.START);
            image.set_tooltip_text(_('Double-click to enlarge'));
            block.content.append(image);
            block.height = h;
        } else {
            note('Rendering diagram…');
        }
    }

    // ---------- Widget position ----------

    queueRelayout(): void {
        if (this.destroyed || this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            if (!this.destroyed) this.relayout();   // the tab may be closed before idle runs
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout(): void {
        if (!this.enabled) return;
        const x = this.view.get_left_margin();
        for (const block of this.blocks) {
            if (block.end >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.end));
            const y = lineY + lineHeight - block.height - GAP;
            // Only move if changed, so as not to trigger repeated resizes.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.widget, x, y);
        }
    }
}
