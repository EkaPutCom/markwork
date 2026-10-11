// Image viewer with zoom: a separate window to see an image larger.
//
//   mouse wheel           zoom at the pointer
//   + / −                 zoom in / out
//   0                     actual size (100%)
//   F                     fit to window
//   double click          toggle between fit to window and 100%
//   drag                  pan the image
//   Esc                   close
//
// The image is drawn by GSK as a scaled texture (snapshot), rather than making an
// enlarged copy, so 800% zoom on a large photo does not use up memory.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import { onKeyPress, textureFromPixbuf } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

// Zoom so the whole image fits in the area (imageW × imageH) → (viewW × viewH).
export const fitZoom = (imageW: number, imageH: number, viewW: number, viewH: number): number =>
    Math.min(viewW / imageW, viewH / imageH);

// 'fit-cap': fit to window but not enlarged beyond 100% (the initial state);
// 'fit': fit to window, may be enlarged; 'manual': zoom set by the user.
type Mode = 'fit-cap' | 'fit' | 'manual';

// The image point (ix, iy) that must stay at position (vx, vy) in the view area during zoom.
interface Focus { ix: number; iy: number; vx: number; vy: number }

// Image area: the texture is drawn filling the widget size (size request = image size × zoom).
// Replacement for DrawingArea + Gdk.cairo_set_source_pixbuf(), deprecated since GTK 4.20.
class ZoomArea extends Gtk.Widget {
    static { GObject.registerClass({ GTypeName: 'MarkworkZoomArea' }, this); }
    texture: Gdk.Texture | null = null;
    zoom = 1;

    override vfunc_snapshot(snapshot: Gtk.Snapshot): void {
        if (!this.texture) return;
        const bounds = new Graphene.Rect().init(0, 0, this.get_width(), this.get_height());
        // Enlarged a lot: show the pixels as they are, not blurred.
        const filter = this.zoom >= 3 ? Gsk.ScalingFilter.NEAREST : this.zoom < 1 ? Gsk.ScalingFilter.TRILINEAR : Gsk.ScalingFilter.LINEAR;
        snapshot.append_scaled_texture(this.texture, filter, bounds);
    }
}

export class ImageViewer {
    readonly window: Adw.Window;
    readonly area: ZoomArea;
    zoom = 1;
    closed = false;

    private mode: Mode = 'fit-cap';
    private readonly scroller: Gtk.ScrolledWindow;
    private readonly percent: Gtk.Label;
    private drag: { h: number; v: number } | null = null;
    private pointer: [number, number] | null = null;   // pointer position over the image

    constructor(parent: Gtk.Window | null, private readonly pixbuf: GdkPixbuf.Pixbuf, title: string) {
        const width = pixbuf.get_width(), height = pixbuf.get_height();

        this.window = new Adw.Window({
            transient_for: parent, modal: true, title,
            ...this.initialSize(parent, width, height),
        });
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({ title, subtitle: fmt(_('{width} × {height} px'), { width, height }) }));

        // Cannot be focused: keys are handled at the window level, and focus only adds a dotted outline around the image.
        this.area = new ZoomArea({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, can_focus: false });
        this.area.texture = textureFromPixbuf(pixbuf);
        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_m, x, y) => { this.pointer = [x, y]; });
        motion.connect('leave', () => { this.pointer = null; });
        this.area.add_controller(motion);
        const click = new Gtk.GestureClick({ button: 1 });
        click.connect('pressed', (_g, count) => { if (count === 2) this.doubleClick(); });
        this.area.add_controller(click);

        this.scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true, can_focus: false });
        this.scroller.set_child(this.area);
        this.scroller.add_css_class('image-viewer');
        // Mouse wheel: zoom at the pointer if over the image, otherwise at the center. The
        // CAPTURE phase so the ScrolledWindow does not scroll it.
        const scroll = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL, propagation_phase: Gtk.PropagationPhase.CAPTURE });
        scroll.connect('scroll', (c, _dx, dy) => this.scrollZoom(dy, c.get_unit() === Gdk.ScrollUnit.WHEEL, this.pointer));
        this.scroller.add_controller(scroll);
        // Drag on the ScrolledWindow (which does not move along), not on the image: its movement
        // is not affected by the scrolling it is doing.
        const drag = new Gtk.GestureDrag({ button: 1 });
        drag.connect('drag-begin', () => this.beginDrag());
        drag.connect('drag-update', (_g, dx, dy) => this.dragBy(dx, dy));
        drag.connect('drag-end', () => this.endDrag());
        this.scroller.add_controller(drag);
        // The view area size changed (adjustment page_size) → adjust the fit-to-window zoom.
        this.scroller.get_hadjustment().connect('notify::page-size', () => this.refit());
        this.scroller.get_vadjustment().connect('notify::page-size', () => this.refit());

        this.percent = new Gtk.Label({ width_chars: 5 });
        const button = (label: string, tooltip: string, run: () => void) => {
            const b = new Gtk.Button({ label, tooltip_text: tooltip });
            b.connect('clicked', run);
            return b;
        };
        const bar = new Gtk.Box({ spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6, halign: Gtk.Align.CENTER });
        bar.append(button('−', _('Zoom out (−)'), () => this.zoomOut()));
        bar.append(this.percent);
        bar.append(button('+', _('Zoom in (+)'), () => this.zoomIn()));
        bar.append(button(_('Fit'), _('Fit to window (F)'), () => this.fit()));
        bar.append(button('100%', _('Actual size (0)'), () => this.actual()));

        const view = new Adw.ToolbarView({ content: this.scroller });
        view.add_top_bar(header);
        view.add_bottom_bar(bar);
        this.window.set_content(view);

        onKeyPress(this.window, keyval => this.handleKey(keyval));
        // The window is destroyed (GTK 4 does not emit "destroy" while its object is held by JavaScript).
        this.window.connect('unrealize', () => { this.closed = true; });
        this.applyZoom(1);
    }

    // Small image: the size of the image; large image: almost fills the parent window.
    private initialSize(parent: Gtk.Window | null, width: number, height: number): { default_width: number; default_height: number } {
        const [pw, ph] = parent ? [parent.get_width(), parent.get_height()] : [1000, 700];
        return {
            default_width: Math.max(480, Math.min(width + 40, Math.floor(pw * 0.9))),
            default_height: Math.max(360, Math.min(height + 140, Math.floor(ph * 0.9))),
        };
    }

    show(): void {
        this.window.present();
    }

    close(): void {
        this.window.destroy();
    }

    // ---------- Zoom ----------

    // The size of the area available for the image (without the toolbar).
    private viewport(): [number, number] {
        return [this.scroller.get_allocated_width(), this.scroller.get_allocated_height()];
    }

    // Adjusts the zoom to the window size while still in fit-to-window mode.
    private refit(): void {
        if (this.mode === 'manual') return;
        const [vw, vh] = this.viewport();
        if (vw <= 1 || vh <= 1) return;
        const fit = fitZoom(this.pixbuf.get_width(), this.pixbuf.get_height(), vw, vh);
        const zoom = clampZoom(this.mode === 'fit-cap' ? Math.min(1, fit) : fit);
        if (Math.abs(zoom - this.zoom) > 1e-6) this.applyZoom(zoom);
    }

    // The image's offset inside the view area: an image smaller than the area is centered.
    private offset(zoom: number): [number, number] {
        const [vw, vh] = this.viewport();
        return [
            Math.max(0, (vw - this.pixbuf.get_width() * zoom) / 2),
            Math.max(0, (vh - this.pixbuf.get_height() * zoom) / 2),
        ];
    }

    private focusAtCenter(): Focus {
        const [vw, vh] = this.viewport();
        const [ox, oy] = this.offset(this.zoom);
        return {
            ix: (this.scroller.get_hadjustment().get_value() + vw / 2 - ox) / this.zoom,
            iy: (this.scroller.get_vadjustment().get_value() + vh / 2 - oy) / this.zoom,
            vx: vw / 2, vy: vh / 2,
        };
    }

    // (x, y): the pointer position inside the image area.
    private focusAtPoint(x: number, y: number): Focus {
        const [ox, oy] = this.offset(this.zoom);
        return {
            ix: x / this.zoom, iy: y / this.zoom,
            vx: x + ox - this.scroller.get_hadjustment().get_value(),
            vy: y + oy - this.scroller.get_vadjustment().get_value(),
        };
    }

    private applyZoom(zoom: number, focus: Focus = this.focusAtCenter()): void {
        this.zoom = clampZoom(zoom);
        const w = Math.round(this.pixbuf.get_width() * this.zoom), h = Math.round(this.pixbuf.get_height() * this.zoom);
        this.area.set_size_request(w, h);
        this.percent.label = `${Math.round(this.zoom * 100)}%`;
        this.area.zoom = this.zoom;
        this.area.queue_draw();

        // The new size only applies after layout, so set the scroll position afterwards.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.closed) return GLib.SOURCE_REMOVE;
            const [ox, oy] = this.offset(this.zoom);
            this.scroller.get_hadjustment().set_value(focus.ix * this.zoom + ox - focus.vx);
            this.scroller.get_vadjustment().set_value(focus.iy * this.zoom + oy - focus.vy);
            return GLib.SOURCE_REMOVE;
        });
    }

    zoomIn(focus?: Focus): void {
        this.mode = 'manual';
        this.applyZoom(this.zoom * ZOOM_STEP, focus);
    }

    zoomOut(focus?: Focus): void {
        this.mode = 'manual';
        this.applyZoom(this.zoom / ZOOM_STEP, focus);
    }

    actual(): void {
        this.mode = 'manual';
        this.applyZoom(1);
    }

    fit(): void {
        this.mode = 'fit';
        this.refit();
    }

    // ---------- Input ----------

    // true = the key was handled.
    handleKey(keyval: number): boolean {
        switch (keyval) {
            case Gdk.KEY_Escape: this.close(); return true;
            case Gdk.KEY_plus: case Gdk.KEY_equal: case Gdk.KEY_KP_Add: this.zoomIn(); return true;
            case Gdk.KEY_minus: case Gdk.KEY_KP_Subtract: this.zoomOut(); return true;
            case Gdk.KEY_0: case Gdk.KEY_KP_0: this.actual(); return true;
            case Gdk.KEY_f: case Gdk.KEY_F: this.fit(); return true;
            default: return false;
        }
    }

    // Mouse wheel by dy (up is negative). wheel = a regular wheel step (zoom per ZOOM_STEP);
    // otherwise smooth touchpad scrolling. point = the pointer position over the image, or null (zoom at the center).
    scrollZoom(dy: number, wheel: boolean, point: [number, number] | null): boolean {
        if (dy === 0) return true;
        const focus = point ? this.focusAtPoint(point[0], point[1]) : undefined;
        this.mode = 'manual';
        this.applyZoom(this.zoom * (wheel ? Math.pow(ZOOM_STEP, -dy) : Math.pow(1.1, -dy)), focus);
        return true;
    }

    // Double click: toggle between fit to window and actual size.
    doubleClick(): void {
        if (this.mode !== 'manual' && Math.abs(this.zoom - 1) > 1e-6) this.actual();
        else this.fit();
        this.endDrag();
    }

    beginDrag(): void {
        this.drag = { h: this.scroller.get_hadjustment().get_value(), v: this.scroller.get_vadjustment().get_value() };
    }

    // (dx, dy): pointer displacement since beginDrag(). false = not dragging.
    dragBy(dx: number, dy: number): boolean {
        if (!this.drag) return false;
        this.scroller.get_hadjustment().set_value(this.drag.h - dx);
        this.scroller.get_vadjustment().set_value(this.drag.v - dy);
        return true;
    }

    endDrag(): boolean {
        this.drag = null;
        return true;
    }
}
