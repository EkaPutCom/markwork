// Displays images ![alt](url) directly in the editor.
//
// Images are NOT put into the text buffer (e.g. through a GtkTextChildAnchor),
// because that would add characters to the document and the undo history. Instead:
//
//   1. Below the line that contains the image, blank space is reserved with a tag
//      having `pixels_below_lines` as tall as the image.
//   2. The image widget is attached above that blank space with
//      add_overlay(). Its position is in buffer coordinates, so it scrolls
//      along with the text.
//   3. Every time the layout changes (text edited, window resized,
//      image finished loading), the widget position is recomputed from
//      the line's get_line_yrange().
//
// Images are loaded asynchronously and cached per URI, so typing does not
// reload the same image.

import Gtk from 'gi://Gtk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { ImageRef } from '../markdown/highlight.js';
import { setTagGroup, type Range } from './tagsync.js';
import { OverlaySlots } from './overlays.js';
import { iterAtLine, onClick, removeChildren, textureFromPixbuf } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';

const MAX_HEIGHT = 480;  // maximum image height, in pixels
const GAP = 12;          // distance above and below the image
const SPACING = 8;       // distance between images on one line

// ---------- Loading images ----------

// URL in Markdown → GIO URI. Relative paths are resolved from the document folder.
export function resolveImageUri(url: string, baseDir: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    const path = GLib.path_is_absolute(url) ? url : GLib.build_filenamev([baseDir, decodeURI(url)]);
    return Gio.File.new_for_path(path).get_uri();
}

interface CacheEntry {
    status: 'loading' | 'ok' | 'error';
    pixbuf: GdkPixbuf.Pixbuf | null;
    error: string | null;
    waiters: ((entry: CacheEntry) => void)[];
}

// One image inside a block.
interface BlockItem {
    uri: string;
    alt: string;
    entry: CacheEntry | null;
}

// The part of Gdk.Event used by click handling (makes it easier for tests to create fake events).

// Result of looking for an image to zoom (imageAt).
export type ImageLookup =
    | { ok: true; pixbuf: GdkPixbuf.Pixbuf; title: string }
    | { ok: false; reason: string };

// One block per line that contains images.
export interface Block {
    line: number;
    key: string;           // list of URI + alt, to match the same block
    items: BlockItem[];
    box: Gtk.Box;          // overlay slot (see overlays.ts)
    content: Gtk.Box;
    height: number;
    x: number;
    y: number;
    destroyed: boolean;
}

const cache = new Map<string, CacheEntry>();

// Load an image asynchronously; the callback is called with the cache entry when done.
function loadImage(uri: string, callback: (entry: CacheEntry) => void): void {
    let entry = cache.get(uri);
    if (entry) {
        if (entry.status === 'loading') entry.waiters.push(callback);
        else callback(entry);
        return;
    }
    const fresh: CacheEntry = { status: 'loading', pixbuf: null, error: null, waiters: [callback] };
    cache.set(uri, fresh);
    const file = Gio.File.new_for_uri(uri);
    file.load_contents_async(null, (_source, result) => {
        try {
            const [, bytes] = file.load_contents_finish(result);
            const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
            fresh.pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;  // rotated phone photos
            fresh.status = 'ok';
        } catch (e) {
            fresh.status = 'error';
            fresh.error = e instanceof Error ? e.message : String(e);
        }
        for (const waiter of fresh.waiters) waiter(fresh);
        fresh.waiters = [];
    });
}

// ---------- Image layer ----------

export class ImageLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    getBaseDir: () => string = () => GLib.get_home_dir();
    onActivate: (line: number) => void = () => {};  // image clicked once
    onZoom: (line: number, index: number) => void = () => {};  // image double-clicked

    private gapTags = new Map<number, Gtk.TextTag>();   // height → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;
    private readonly slots: OverlaySlots;

    constructor(view: Gtk.TextView) {
        this.view = view;
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);

        // The layout changed (document height or window size, seen from the vertical
        // adjustment) → widget positions need to be recomputed.
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    // Editor closed: stop the pending work (see MarkdownView.destroy()).
    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
        for (const block of this.blocks) block.destroyed = true;
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
    }

    // The image on line `line` was clicked. Single click: cursor to its line (its syntax appears);
    // double click: zoom that image.
    press(line: number, index: number, doubleClick: boolean): void {
        if (doubleClick) this.onZoom(line, index);
        else this.onActivate(line);
    }

    // The `index`-th image on line `line` at full size (not the scaled-down one used for display).
    imageAt(line: number, index = 0): ImageLookup {
        const item = this.blocks.find(b => b.line === line)?.items[index];
        if (!item) return { ok: false, reason: _('There is no image on this line') };
        if (item.entry?.status === 'ok' && item.entry.pixbuf) {
            const name = item.uri.split('/').pop() ?? item.uri;
            return { ok: true, pixbuf: item.entry.pixbuf, title: item.alt || GLib.uri_unescape_string(name, null) || name };
        }
        return { ok: false, reason: item.entry?.status === 'error' ? _('The image could not be loaded') : _('The image has not finished loading') };
    }

    // images from highlighter.ts
    update(images: ImageRef[]): void {
        const baseDir = this.getBaseDir();
        const byLine = new Map<number, { uri: string; alt: string }[]>();
        for (const img of images) {
            if (!byLine.has(img.line)) byLine.set(img.line, []);
            byLine.get(img.line)!.push({ uri: resolveImageUri(img.url, baseDir), alt: img.alt });
        }

        // Reuse blocks with the same contents, even if their lines shifted (for example
        // because a new line was added above). Match by the URI list.
        const unused = [...this.blocks];
        const next: Block[] = [];
        for (const [line, items] of byLine) {
            const key = items.map(i => `${i.uri}\n${i.alt}`).join('\n\n');
            const k = unused.findIndex(b => b.key === key);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                block.line = line;
                next.push(block);
            } else {
                next.push(this.createBlock(line, key, items));
            }
        }
        for (const block of unused) this.destroyBlock(block);
        this.blocks = next;
        this.applyGaps();
        this.queueRelayout();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        for (const block of this.blocks) block.box.set_visible(enabled);
        this.applyGaps();
        this.queueRelayout();
    }

    // The text column width changed → rescale all images.
    setMaxWidth(width: number): void {
        width = Math.max(100, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        for (const block of this.blocks) this.render(block);
        this.applyGaps();
        this.queueRelayout();
    }

    // ---------- Widget ----------

    private createBlock(line: number, key: string, items: { uri: string; alt: string }[]): Block {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: SPACING });
        content.add_css_class('image-block');
        const box = this.slots.acquire();
        box.append(content);
        const block: Block = { line, key, items: [], box, content, height: 0, x: -1, y: -1, destroyed: false };

        for (const { uri, alt } of items) {
            const item: BlockItem = { uri, alt, entry: null };
            block.items.push(item);
            loadImage(uri, entry => {
                if (block.destroyed) return;
                item.entry = entry;
                this.render(block);
                this.applyGaps();
                this.queueRelayout();
            });
        }
        this.render(block);
        box.set_visible(this.enabled);
        return block;
    }

    private destroyBlock(block: Block): void {
        block.destroyed = true;
        this.slots.release(block.box);
    }

    // Rebuild the block contents according to the current loading status and column width.
    private render(block: Block): void {
        removeChildren(block.content);
        let height = 0;
        for (const item of block.items) {
            let widget: Gtk.Widget;
            if (item.entry?.status === 'ok' && item.entry.pixbuf) {
                const pb = item.entry.pixbuf;
                const scale = Math.min(1, this.maxWidth / pb.get_width(), MAX_HEIGHT / pb.get_height());
                const w = Math.max(1, Math.round(pb.get_width() * scale));
                const h = Math.max(1, Math.round(pb.get_height() * scale));
                const scaled = (scale < 1 ? pb.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR) : null) ?? pb;
                // Gtk.Image in GTK 4 is icon-sized; Picture is shown at the size of its image.
                widget = Gtk.Picture.new_for_paintable(textureFromPixbuf(scaled));
                (widget as Gtk.Picture).set_can_shrink(false);
                widget.set_tooltip_text(fmt(_('{name}\nDouble-click to enlarge'), { name: item.alt || item.uri }));
                height += h;
            } else {
                const text = item.entry?.status === 'error'
                    ? fmt(_('⚠ The image could not be loaded: {name}'), { name: item.alt || GLib.uri_unescape_string(item.uri, null) || item.uri })
                    : fmt(_('Loading image {name}…'), { name: item.alt });
                // No wrap: a widget inside a TextView is only given the minimum width,
                // so a wrapped label would be cut off word by word.
                widget = new Gtk.Label({ label: text, xalign: 0 });
                widget.add_css_class('image-note');
                if (item.entry?.error) widget.set_tooltip_text(item.entry.error);
                height += 24;
            }
            // Each image has its own click receiver, so a double click knows which image
            // is meant when one line contains several images.
            widget.set_halign(Gtk.Align.START);
            const index = block.items.indexOf(item);
            onClick(widget, count => {
                this.press(block.line, index, count === 2);
                return true;
            });
            block.content.append(widget);
        }
        height += SPACING * Math.max(0, block.items.length - 1);
        block.height = height;
    }

    // ---------- Blank space below the line ----------

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `image-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    private applyGaps(): void {
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.enabled ? this.blocks : []) {
            if (block.line >= this.buffer.get_line_count()) continue;
            const s = iterAtLine(this.buffer, block.line);
            const e = s.copy();
            if (!e.ends_line()) e.forward_to_line_end();
            // The paragraph tag must stick to the first character of the line.
            if (s.equal(e)) continue;
            const gap = this.gapTag(block.height + 2 * GAP);
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([s.get_offset(), e.get_offset()]);
        }
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
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
            if (block.destroyed || block.line >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.line));
            const y = lineY + lineHeight - block.height - GAP;
            // Only move if changed, so as not to trigger repeated resizes.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.box, x, y);
        }
    }
}
