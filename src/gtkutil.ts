// Small helpers for the GTK 4 API used in all layers (editor, ui, window).
// Does not import other project modules, so it can be used from anywhere.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

// Iter at the start of line `line`. GTK 4 returns [ok, iter]; if the line is outside the document,
// the iter is still set to the end of the buffer (same behavior as GTK 3).
export function iterAtLine(buffer: Gtk.TextBuffer, line: number): Gtk.TextIter {
    return buffer.get_iter_at_line(line)[1];
}

// Offset of the start of line `first` and the end of line `last` (before its newline), with one iter
// that is reused: in GJS creating a new iter per line is 4× more expensive than set_line().
// The lines must exist in the document.
export function lineSpanOffsets(iter: Gtk.TextIter, first: number, last: number): [start: number, lastLineStart: number, end: number] {
    iter.set_line(first);
    const start = iter.get_offset();
    iter.set_line(last);
    const lastLineStart = iter.get_offset();
    if (!iter.ends_line()) iter.forward_to_line_end();
    return [start, lastLineStart, iter.get_offset()];
}

// Direct children of a widget, in order from the first. GTK 4 has no get_children().
export function childrenOf(widget: Gtk.Widget): Gtk.Widget[] {
    const result: Gtk.Widget[] = [];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) result.push(child);
    return result;
}

interface Container {
    remove(child: Gtk.Widget): void;
}

// Detach a widget from its parent (replacement for GTK 3's destroy() on child widgets). A parent
// that has remove() (Box, Grid, ListBox, TextView, Stack, ...) is used so its internal data
// is updated too; otherwise the widget is detached directly.
export function removeWidget(widget: Gtk.Widget): void {
    const parent = widget.get_parent();
    if (!parent) return;
    if (parent instanceof Gtk.ListBoxRow || parent instanceof Gtk.FlowBoxChild) {
        // A ListBox/FlowBox row is removed together with its row, not only its contents.
        removeWidget(parent);
        return;
    }
    if (typeof (parent as unknown as Partial<Container>).remove === 'function') (parent as unknown as Container).remove(widget);
    else widget.unparent();
}

// Empty a container of all its children. A ListBox placeholder is also a child in GTK 4, and
// GTK 4.14's remove_all() removes it too; that is why a ListBox is emptied row by row.
export function removeChildren(widget: Gtk.Widget): void {
    if (widget instanceof Gtk.ListBox) {
        for (let row = widget.get_row_at_index(0); row; row = widget.get_row_at_index(0)) widget.remove(row);
        return;
    }
    for (const child of childrenOf(widget)) removeWidget(child);
}

// Awaitable and after() live in awaitable.ts (the application layer uses them too); re-exported for the GTK code.
export { after, type Awaitable } from './awaitable.js';

// Modal dialog without a nested main loop (GTK 4 deliberately removed gtk_dialog_run(): a main loop inside a
// handler makes other code run in the middle of that handler). `start` shows the dialog and calls
// finish(value) once when answered; later calls are ignored.
export function modal<T>(start: (finish: (value: T) => void) => void): Promise<T> {
    return new Promise(resolve => {
        let done = false;
        start(value => {
            if (done) return;
            done = true;
            resolve(value);
        });
    });
}

// Mouse button click on a widget (replacement for the button-press-event signal). `handler` receives
// the number of consecutive clicks (2 = double click), position, and modifiers; true = click handled and
// not passed on to the widget below.
export function onClick(widget: Gtk.Widget, handler: (count: number, x: number, y: number, state: number) => boolean | void, button = 1): Gtk.GestureClick {
    const gesture = new Gtk.GestureClick({ button });
    gesture.connect('pressed', (g, count, x, y) => {
        if (handler(count, x, y, g.get_current_event_state()) === true) g.set_state(Gtk.EventSequenceState.CLAIMED);
    });
    widget.add_controller(gesture);
    return gesture;
}

// Runs `run` when `widget` is clicked (on release). It claims the press, so a card or row around the widget
// does not also start a drag or open its own editor.
export function onChipClick(widget: Gtk.Widget, run: () => void): void {
    widget.set_cursor_from_name('pointer');
    const click = new Gtk.GestureClick({ button: 1 });
    click.connect('pressed', () => click.set_state(Gtk.EventSequenceState.CLAIMED));
    click.connect('released', () => run());
    widget.add_controller(click);
}

// Keyboard key pressed while the widget (or its child) has focus. true = handled.
export function onKeyPress(widget: Gtk.Widget, handler: (keyval: number, state: number) => boolean, phase = Gtk.PropagationPhase.BUBBLE): Gtk.EventControllerKey {
    const controller = new Gtk.EventControllerKey({ propagation_phase: phase });
    controller.connect('key-pressed', (_c, keyval, _code, state) => handler(keyval, state));
    widget.add_controller(controller);
    return controller;
}

// Replacement for GTK 3's gtk_box_pack_start(): append a child at the end of the box. expand = the child takes
// the remaining space along the box's orientation (GTK 4 uses the child's own hexpand/vexpand).
export function pack(box: Gtk.Box, child: Gtk.Widget, expand = false): void {
    if (expand) {
        if (box.get_orientation() === Gtk.Orientation.HORIZONTAL) child.set_hexpand(true);
        else child.set_vexpand(true);
    }
    box.append(child);
}

// Contents of a Gtk.Template from a .ui file bundled as text (`import xml from './x.ui?raw'`).
export const uiTemplate = (xml: string): Uint8Array => new TextEncoder().encode(xml);

// Pixbuf → Gdk.Texture. Gtk.Picture.new_for_pixbuf() and Gdk.Texture.new_for_pixbuf() are deprecated
// (GTK 4.12/4.20); the pixbuf's pixel data (RGB/RGBA 8 bit, not premultiplied) is copied as is.
export function textureFromPixbuf(pixbuf: GdkPixbuf.Pixbuf): Gdk.Texture {
    const format = pixbuf.get_has_alpha() ? Gdk.MemoryFormat.R8G8B8A8 : Gdk.MemoryFormat.R8G8B8;
    return Gdk.MemoryTexture.new(pixbuf.get_width(), pixbuf.get_height(), format, pixbuf.read_pixel_bytes(), pixbuf.get_rowstride());
}

// Gdk.Texture → RGBA pixbuf, replacement for Gdk.pixbuf_get_from_texture() deprecated since GTK 4.12.
export function pixbufFromTexture(texture: Gdk.Texture): GdkPixbuf.Pixbuf {
    const downloader = Gdk.TextureDownloader.new(texture);
    downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);
    const [bytes, stride] = downloader.download_bytes();
    return GdkPixbuf.Pixbuf.new_from_bytes(bytes, GdkPixbuf.Colorspace.RGB, true, 8, texture.get_width(), texture.get_height(), stride);
}

// When run from dist/ (not installed), the app icon is in dist/icons (copied by vite.config.ts),
// not in the system hicolor theme. Safe to call repeatedly: a path that is already there is not added again.
export function addBundledIcons(display: Gdk.Display): void {
    let dir = Gio.File.new_for_uri(import.meta.url).get_parent();
    if (dir && !dir.get_child('icons').query_exists(null)) dir = dir.get_parent();   // from dist/chunks/
    const icons = dir?.get_child('icons');
    if (!icons?.query_exists(null)) return;
    const theme = Gtk.IconTheme.get_for_display(display);
    if (!theme.get_search_path()?.includes(icons.get_path()!)) theme.add_search_path(icons.get_path()!);
}
