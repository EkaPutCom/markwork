// The Outline tab in the sidebar: the list of document headings. Click a heading to jump to it.
//
// Headings are kept in a Gio.ListStore and displayed by a Gtk.ListView, which only creates widgets for
// visible rows. A document with thousands of headings does not need to be fed in piece by piece.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import type { OutlineHeading, OutlineView } from '../app/outline.js';
import { _ } from '../i18n.js';

// One outline row: only what affects its display. The target line number of a click is read from the latest list of headings.
export class HeadingItem extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkHeadingItem',
            Properties: {
                level: GObject.ParamSpec.int('level', null, null, GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, 1, 6, 1),
                text: GObject.ParamSpec.string('text', null, null, GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, ''),
            },
        }, this);
    }
    declare level: number;
    declare text: string;
}

const SMALL = 8;    // a change this size (e.g. editing one heading) is applied right away
const CHUNK = 25;   // new outline items per turn when fed in piece by piece

interface Shown { level: number; text: string }

export class Outline implements OutlineView {
    readonly store = new Gio.ListStore({ item_type: HeadingItem.$gtype });
    readonly list: Gtk.ListView;
    readonly widget: Gtk.Box;
    onJump: (index: number) => void = () => {};  // heading clicked: its place in the list the panel was sent

    private headings: readonly OutlineHeading[] = [];
    private shown: Shown[] = [];   // the store's current contents (can lag behind headings while being fed in)
    private filling = 0;

    constructor() {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            (item as Gtk.ListItem).child = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, margin_end: 12 });
        });
        factory.connect('bind', (_f, item) => {
            const listItem = item as Gtk.ListItem;
            const heading = listItem.item as HeadingItem;
            const label = listItem.child as Gtk.Label;
            const text = heading.text || '(empty)';
            label.margin_start = 16 + (heading.level - 1) * 14;
            if (heading.level === 1) label.set_markup(`<b>${GLib.markup_escape_text(text, -1)}</b>`);
            else label.set_label(text);
        });
        this.list = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.store }), factory, single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        this.list.connect('activate', (_list, position) => this.onJump(position));

        const placeholder = new Gtk.Label({ label: _('No headings yet'), margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16, valign: Gtk.Align.START });
        placeholder.add_css_class('dim-label');
        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: this.list });
        const pages = new Gtk.Stack();
        pages.add_named(scroll, 'list');
        pages.add_named(placeholder, 'empty');
        pages.visible_child_name = 'empty';
        this.store.connect('items-changed', () => { pages.visible_child_name = this.store.n_items ? 'list' : 'empty'; });

        const title = new Gtk.Label({ label: _('OUTLINE'), xalign: 0, margin_start: 16, margin_top: 4, margin_bottom: 8 });
        title.add_css_class('side-title');
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.append(title);
        this.widget.append(pages);
    }

    get count(): number {
        return this.store.n_items;
    }

    // The headings of the active document (app/outline.ts).
    showHeadings(headings: readonly OutlineHeading[]): void {
        // Line shifts change the click target, which the controller keeps, not the label's appearance.
        this.headings = headings;
        if (this.filling || this.step(SMALL)) return;
        // Opening another document: creating all items at once holds up the main loop (±0.1 ms per item,
        // ±20 ms for 440 headings). A large change is fed in at idle after the frame is drawn
        // (GDK_PRIORITY_REDRAW = HIGH_IDLE + 20), but before the editor tag installments (+22).
        this.filling = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE + 21, () => {
            if (!this.step(CHUNK)) return GLib.SOURCE_CONTINUE;
            this.filling = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Make the store match the latest headings, at most `limit` new items (without touching the store
    // if the change is larger than that and limit = SMALL). true = already the same.
    // The common prefix and suffix are kept: editing one heading replaces only one item,
    // so the other rows are not redrawn.
    private step(limit: number): boolean {
        const shown = this.shown, headings = this.headings;
        const same = (a: Shown, b: OutlineHeading) => a.level === b.level && a.text === b.text;
        let first = 0, oldEnd = shown.length, newEnd = headings.length;
        while (first < oldEnd && first < newEnd && same(shown[first], headings[first])) first++;
        while (oldEnd > first && newEnd > first && same(shown[oldEnd - 1], headings[newEnd - 1])) { oldEnd--; newEnd--; }
        if (first === oldEnd && first === newEnd) return true;
        if (limit === SMALL && newEnd - first > SMALL) return false;
        const added = headings.slice(first, Math.min(newEnd, first + limit)).map(({ level, text }) => ({ level, text }));
        this.shown.splice(first, oldEnd - first, ...added);
        this.store.splice(first, oldEnd - first, added.map(({ level, text }) => new HeadingItem({ level, text })));
        return first + added.length === newEnd;
    }
}
