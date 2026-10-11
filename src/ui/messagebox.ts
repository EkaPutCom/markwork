// The commit message box: a text area that wraps, so a whole subject (up to about 72 characters) stays readable in
// the narrow sidebar instead of scrolling sideways like an entry. It holds one line: Enter commits (onActivate)
// instead of starting a new line, and a pasted line break becomes a space.

import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { onKeyPress } from '../gtkutil.js';

const LINE_HEIGHT = 22;   // px per wrapped line, with the view's margins added below

export class MessageBox {
    readonly widget: Gtk.Widget;
    readonly view: Gtk.TextView;
    onActivate: () => void = () => {};
    private readonly placeholder: Gtk.Label;
    private flattening = false;

    // Two lines high when empty; it grows with the text up to four, then scrolls.
    constructor(placeholder: string) {
        this.view = new Gtk.TextView({
            wrap_mode: Gtk.WrapMode.WORD_CHAR, accepts_tab: false,
            left_margin: 8, right_margin: 8, top_margin: 6, bottom_margin: 6,
        });
        this.view.update_property([Gtk.AccessibleProperty.LABEL], [placeholder]);
        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER, has_frame: true, propagate_natural_height: true,
            min_content_height: 2 * LINE_HEIGHT + 12, max_content_height: 4 * LINE_HEIGHT + 12,
            child: this.view,
        });
        this.placeholder = new Gtk.Label({
            label: placeholder, xalign: 0, yalign: 0, can_target: false, ellipsize: Pango.EllipsizeMode.END,
            margin_start: 9, margin_end: 9, margin_top: 7, halign: Gtk.Align.FILL, valign: Gtk.Align.START,
        });
        this.placeholder.add_css_class('dim-label');
        const overlay = new Gtk.Overlay({ child: scroll, hexpand: true });
        overlay.add_overlay(this.placeholder);
        this.widget = overlay;

        // CAPTURE: before the TextView inserts a new line for Enter.
        onKeyPress(this.view, keyval => {
            if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter && keyval !== Gdk.KEY_ISO_Enter) return false;
            this.onActivate();
            return true;
        }, Gtk.PropagationPhase.CAPTURE);
        this.onChanged(() => this.placeholder.set_visible(this.text === ''));
        // Flatten before the text enters the buffer: changing it from 'changed' would invalidate the iterators of the
        // insertion in progress.
        this.view.buffer.connect('insert-text', (buffer, location, text) => {
            if (this.flattening || !/[\r\n]/.test(text)) return;
            this.flattening = true;
            buffer.insert(location, text.replace(/\s*[\r\n]+\s*/g, ' '), -1);
            this.flattening = false;
            buffer.stop_emission_by_name('insert-text');
        });
    }

    get text(): string {
        const [start, end] = this.view.buffer.get_bounds();
        return this.view.buffer.get_text(start, end, true);
    }

    set text(text: string) {
        this.view.buffer.set_text(text, -1);
    }

    get sensitive(): boolean { return this.widget.sensitive; }
    set sensitive(sensitive: boolean) { this.widget.set_sensitive(sensitive); }

    onChanged(handler: () => void): void {
        this.view.buffer.connect('changed', handler);
    }

    grabFocus(): void {
        this.view.grab_focus();
    }

    selectAll(): void {
        const [start, end] = this.view.buffer.get_bounds();
        this.view.buffer.select_range(start, end);
    }

    cursorToEnd(): void {
        this.view.buffer.place_cursor(this.view.buffer.get_end_iter());
    }

    // The selected range as character offsets; equal when nothing is selected.
    selection(): [number, number] {
        const [, start, end] = this.view.buffer.get_selection_bounds();
        return [start.get_offset(), end.get_offset()];
    }
}
