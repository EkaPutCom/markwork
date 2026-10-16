// Context menu (right click / ⋯ button) for GTK 4.
//
// The menu contents are expressed as data (MenuEntry[]) so they are easy to test without opening a popover:
// tests only need to find an entry by label and then call run(). popupMenu() turns it
// into a Gtk.PopoverMenu, which in GTK 4 only accepts a Gio.MenuModel containing action names.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The menu data (MenuEntry, separator, findEntry) is in app/menu.ts; re-exported for the GTK code.
export { findEntry, separator, type MenuEntry } from '../app/menu.js';
import type { MenuEntry } from '../app/menu.js';

// Build the Gio.Menu and its actions (in group `group`, prefix "menu.").
function buildModel(entries: MenuEntry[], group: Gio.SimpleActionGroup, counter: { n: number }): Gio.Menu {
    const model = new Gio.Menu();
    let section = new Gio.Menu();
    model.append_section(null, section);
    for (const entry of entries) {
        if (!entry.label) {
            section = new Gio.Menu();
            model.append_section(null, section);
            continue;
        }
        const name = `item${counter.n++}`;
        const enabled = entry.enabled !== false;
        if (entry.submenu) {
            const item = Gio.MenuItem.new_submenu(entry.label, buildModel(entry.submenu, group, counter));
            // An inactive submenu: given a disabled action so it shows dimmed.
            if (!enabled) {
                group.add_action(new Gio.SimpleAction({ name, enabled: false }));
                item.set_attribute_value('submenu-action', GLib.Variant.new_string(`menu.${name}`));
            }
            section.append_item(item);
            continue;
        }
        const action = new Gio.SimpleAction({ name, enabled });
        const run = entry.run;
        // Deferred to idle: a dialog opened from an action must not appear while the popover
        // is still closing, and the action often redraws the popover owner's widget.
        if (run) action.connect('activate', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { run(); return GLib.SOURCE_REMOVE; }));
        group.add_action(action);
        section.append(entry.label, `menu.${name}`);
    }
    return model;
}

// Show the menu near `parent`. (x, y) = a point in the parent's coordinates (e.g. the position of a
// right click); without it the menu points at the whole widget (the ⋯ button).
export function popupMenu(parent: Gtk.Widget, entries: MenuEntry[], x?: number, y?: number): Gtk.PopoverMenu {
    const group = new Gio.SimpleActionGroup();
    const model = buildModel(entries, group, { n: 0 });
    parent.insert_action_group('menu', group);
    const popover = Gtk.PopoverMenu.new_from_model(model);
    popover.set_has_arrow(x === undefined);
    if (x !== undefined && y !== undefined) {
        popover.set_halign(Gtk.Align.START);
        popover.set_pointing_to(new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }));
    }
    popover.set_parent(parent);
    // A popover is a child of its owner widget; detach it after it closes so they do not pile up.
    popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (popover.get_parent()) popover.unparent();
        return GLib.SOURCE_REMOVE;
    }));
    popover.popup();
    return popover;
}
