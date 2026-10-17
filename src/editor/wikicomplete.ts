// Note name suggestions while typing [[ (Obsidian style). The file list is requested from the window through `listNotes`
// because the editor knows nothing about folders; the list is read once each time a suggestion opens, not on every keystroke.
//
// The popover does not take focus: the cursor stays in the TextView, and MarkdownView.onKey passes
// arrows/Enter/Tab/Esc to it while the suggestion is visible.
//
// The popover is a child of the TextView only while it is shown. GtkTextView's dispose removes its children
// with gtk_text_view_remove(), which does not know a child added with set_parent(): it only warns
// ("GtkPopover is not a child of GtkSourceView") and leaves it there, so the loop never ends. destroy() alone
// is not enough to prevent that: GJS drops signal callbacks while a garbage collection is sweeping, so the
// "unrealize" that leads to destroy() may never reach JavaScript, and the view is then disposed with the popover.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { onKeyPress, removeChildren } from '../gtkutil.js';
import { cpLength } from '../markdown/offsets.js';
import { lineText } from './editing.js';
import { suggestNotes, wikiQuery, wikiTargetFor } from '../markdown/wikilink.js';

export class WikiCompleter {
    readonly popover: Gtk.Popover;
    private list: Gtk.ListBox;
    private files: string[] | null = null;   // null = not read yet for the suggestion that is currently open
    items: string[] = [];
    selected = 0;
    private queued = 0;
    private destroyed = false;

    // Relative paths of all Markdown files in the project.
    listNotes: () => string[] = () => [];

    constructor(private view: Gtk.TextView) {
        this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE, can_focus: false });
        this.list.add_css_class('wiki-suggest');
        this.list.connect('row-activated', (_l, row) => this.accept(row.get_index()));
        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, propagate_natural_width: true,
            max_content_height: 280, child: this.list,
        });
        this.popover = new Gtk.Popover({
            child: scroller, autohide: false, has_arrow: false, can_focus: false,
            position: Gtk.PositionType.BOTTOM, halign: Gtk.Align.START,
        });
        // GTK can also close it by itself (e.g. the view is unmapped): detach it afterwards, unless it opened again.
        this.popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this.popover.get_visible()) this.detach();
            return GLib.SOURCE_REMOVE;
        }));
    }

    get visible(): boolean {
        return this.popover.get_visible();
    }

    // typed = text was just typed: the suggestion may open. A cursor move alone only updates
    // or closes a suggestion that is already open, so a cursor passing over an old [[ does not bring it up.
    queue(typed: boolean): void {
        if (!typed && !this.visible) return;
        if (this.queued) return;
        this.queued = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.queued = 0;
            if (!this.destroyed) this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh(): void {
        const buffer = this.view.get_buffer();
        const query = buffer.get_has_selection() ? null : this.query();
        if (query === null) { this.hide(); return; }
        this.files ??= this.listNotes();
        const items = suggestNotes(query, this.files);
        if (!items.length) { this.hide(); return; }
        if (items.join('\n') !== this.items.join('\n')) {
            this.items = items;
            this.selected = 0;
            this.fill();
        }
        if (!this.popover.get_parent()) this.popover.set_parent(this.view);
        const iter = buffer.get_iter_at_mark(buffer.get_insert());
        const rect = this.view.get_iter_location(iter);
        const [x, y] = this.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x, rect.y);
        this.popover.set_pointing_to(new Gdk.Rectangle({ x, y, width: 1, height: rect.height }));
        if (!this.visible) this.popover.popup();
    }

    hide(): void {
        this.files = null;
        this.items = [];
        if (this.visible) this.popover.popdown();
        this.detach();
    }

    // Keys while the suggestion is visible. true = handled.
    onKey(keyval: number): boolean {
        if (!this.visible) return false;
        switch (keyval) {
            case Gdk.KEY_Down: case Gdk.KEY_KP_Down:
                this.select((this.selected + 1) % this.items.length); return true;
            case Gdk.KEY_Up: case Gdk.KEY_KP_Up:
                this.select((this.selected - 1 + this.items.length) % this.items.length); return true;
            case Gdk.KEY_Return: case Gdk.KEY_KP_Enter: case Gdk.KEY_Tab:
                this.accept(this.selected); return true;
            case Gdk.KEY_Escape:
                this.hide(); return true;
        }
        return false;
    }

    // Replace the text after [[ with the chosen file name and close with ]] (if not there yet).
    accept(index: number): void {
        const file = this.items[index];
        const buffer = this.view.get_buffer();
        if (!file) return;
        const target = wikiTargetFor(file, this.files ?? [file]);
        const cursor = buffer.get_iter_at_mark(buffer.get_insert());
        const [line] = lineText(buffer, cursor);
        const before = Array.from(line).slice(0, cursor.get_line_offset()).join('');
        const typed = cpLength(before) - cpLength(before.slice(0, before.lastIndexOf('[[') + 2));
        const from = cursor.copy();
        from.backward_chars(typed);
        const closed = line.slice(before.length).startsWith(']]');
        this.hide();
        buffer.begin_user_action();
        buffer.delete(from, cursor);
        buffer.insert(from, closed ? target : `${target}]]`, -1);
        if (closed) from.forward_chars(2);
        buffer.place_cursor(from);
        buffer.end_user_action();
        this.view.grab_focus();
    }

    destroy(): void {
        this.destroyed = true;
        if (this.queued) GLib.source_remove(this.queued);
        this.queued = 0;
        this.detach();
    }

    private detach(): void {
        if (this.popover.get_parent()) this.popover.unparent();
    }

    private query(): string | null {
        const buffer = this.view.get_buffer();
        const cursor = buffer.get_iter_at_mark(buffer.get_insert());
        const start = cursor.copy();
        start.set_line_offset(0);
        return wikiQuery(buffer.get_text(start, cursor, true));
    }

    private select(index: number): void {
        this.selected = index;
        const row = this.list.get_row_at_index(index);
        if (row) this.list.select_row(row);
    }

    private fill(): void {
        removeChildren(this.list);
        for (const file of this.items) {
            const slash = file.lastIndexOf('/');
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_start: 6, margin_end: 6, margin_top: 3, margin_bottom: 3 });
            box.append(new Gtk.Label({ label: file.slice(slash + 1).replace(/\.(md|markdown|mdown|mkd)$/i, ''), xalign: 0, ellipsize: Pango.EllipsizeMode.END, width_chars: 24, max_width_chars: 40 }));
            if (slash > 0) {
                const dir = new Gtk.Label({ label: file.slice(0, slash), xalign: 0, ellipsize: Pango.EllipsizeMode.START, max_width_chars: 40 });
                dir.add_css_class('dim-label');
                dir.add_css_class('caption');
                box.append(dir);
            }
            this.list.append(new Gtk.ListBoxRow({ child: box, can_focus: false }));
        }
        this.select(0);
    }
}

// Install [[ suggestions on a plain TextView (e.g. the notes field in the card dialog). MarkdownView wires up its own signal.
// The caller must call destroy() when the TextView is no longer used so the popover is released.
export function attachWikiCompleter(view: Gtk.TextView, listNotes: () => string[]): WikiCompleter {
    const completer = new WikiCompleter(view);
    completer.listNotes = listNotes;
    const buffer = view.get_buffer();
    buffer.connect_after('insert-text', () => completer.queue(true));
    buffer.connect_after('delete-range', () => completer.queue(false));
    buffer.connect('mark-set', (_b, _i, mark) => { if (mark === buffer.get_insert()) completer.queue(false); });
    onKeyPress(view, (keyval, state) =>
        !(state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) && completer.onKey(keyval), Gtk.PropagationPhase.CAPTURE);
    return completer;
}
