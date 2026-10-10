// A small popover to change one field of an item in place: a list of options for a select (with a way to type
// an option that is not in the list yet), a calendar for a date, and an entry with validation for the rest.
// It only collects the new text; the caller writes it into the document (one undo step).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { nearestOption, parseValue, type FieldDef } from '../markdown/fields.js';
import { withDueDate } from '../markdown/kanban.js';
import { _ } from '../i18n.js';

export interface FieldPopoverOptions {
    def: FieldDef;
    current: string;                                  // the field's text now, empty if the item has no value
    apply(raw: string, newOption?: string): void;     // raw '' clears the field; newOption is added to the field's list first
}

const OPTION_TEXT = /^[^,()]+$/;

function content(): Gtk.Box {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
    box.set_size_request(220, -1);
    return box;
}

function flatButton(label: string, run: () => void, checked = false): Gtk.Button {
    const button = new Gtk.Button({ label: checked ? `✓ ${label}` : label, has_frame: false, halign: Gtk.Align.FILL });
    (button.get_child() as Gtk.Label | null)?.set_xalign(0);
    button.connect('clicked', run);
    return button;
}

// The options as buttons, then an entry for a different value: the closest listed option is offered first, and a
// value that is new is added to the list only after its own button is pressed.
function selectContent({ def, current, apply }: FieldPopoverOptions): Gtk.Box {
    const box = content();
    for (const option of def.options) box.append(flatButton(option, () => apply(option), option === current));
    box.append(flatButton(_('Clear'), () => apply('')));
    box.append(new Gtk.Separator());
    const entry = new Gtk.Entry({ placeholder_text: _('Another value…'), activates_default: false });
    const offer = new Gtk.Button({ visible: false, has_frame: false, halign: Gtk.Align.FILL });
    (offer.get_child() as Gtk.Label | null)?.set_xalign(0);
    let action: (() => void) | null = null;
    entry.connect('changed', () => {
        const text = entry.text.trim();
        const close = nearestOption(def, text);
        action = close ? () => apply(close) : OPTION_TEXT.test(text) ? () => apply(text, text) : null;
        offer.set_label(close ? `${_('Use')} “${close}”` : `${_('Add')} “${text}” ${_('to the list')}`);
        offer.set_visible(action !== null);
    });
    offer.connect('clicked', () => action?.());
    entry.connect('activate', () => action?.());
    box.append(entry);
    box.append(offer);
    return box;
}

// A calendar on the date now in the field (or today). Choosing a day keeps the time that was already there.
function dateContent({ current, apply }: FieldPopoverOptions): Gtk.Box {
    const box = content();
    const calendar = new Gtk.Calendar();
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(current);
    let syncing = true;
    calendar.select_day((match ? GLib.DateTime.new_local(+match[1], +match[2], +match[3], 0, 0, 0) : null) ?? GLib.DateTime.new_now_local());
    syncing = false;
    const pick = (date: GLib.DateTime) => apply(withDueDate(current, date.format('%Y-%m-%d')!));
    calendar.connect('day-selected', () => { if (!syncing) pick(calendar.get_date()); });
    const actions = new Gtk.Box({ spacing: 6 });
    const today = new Gtk.Button({ label: _('Today'), hexpand: true });
    const clear = new Gtk.Button({ label: _('Clear'), hexpand: true });
    today.connect('clicked', () => pick(GLib.DateTime.new_now_local()));
    clear.connect('clicked', () => apply(''));
    actions.append(today);
    actions.append(clear);
    box.append(calendar);
    box.append(actions);
    return box;
}

// An entry for any other type; a value that does not fit the field marks the entry and is not applied.
function entryContent({ def, current, apply }: FieldPopoverOptions): Gtk.Box {
    const box = content();
    const entry = new Gtk.Entry({ text: current, hexpand: true });
    entry.connect('changed', () => entry.remove_css_class('error'));
    entry.connect('activate', () => {
        const text = entry.text.trim();
        if (text && !parseValue(def, text).ok) entry.add_css_class('error');
        else apply(text);
    });
    box.append(entry);
    box.append(flatButton(_('Clear'), () => apply('')));
    return box;
}

// The popover for `options.def`, attached to `anchor` and shown. It detaches itself after it closes.
export function fieldPopover(anchor: Gtk.Widget, options: FieldPopoverOptions): Gtk.Popover {
    const { def } = options;
    const popover = new Gtk.Popover();
    const finish = (raw: string, newOption?: string) => {
        popover.popdown();
        options.apply(raw, newOption);
    };
    const wrapped = { ...options, apply: finish };
    popover.set_child(def.type === 'date' ? dateContent(wrapped)
        : def.type === 'select' && !def.multiple && def.options.length ? selectContent(wrapped) : entryContent(wrapped));
    popover.set_parent(anchor);
    popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (popover.get_parent()) popover.unparent();
        return GLib.SOURCE_REMOVE;
    }));
    popover.popup();
    return popover;
}

// A list of the fields that have no value yet; choosing one calls `choose` after the list has closed.
export function fieldMenu(anchor: Gtk.Widget, defs: FieldDef[], choose: (def: FieldDef) => void): Gtk.Popover {
    const popover = new Gtk.Popover();
    const box = content();
    for (const def of defs) {
        box.append(flatButton(def.key, () => {
            popover.popdown();
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { choose(def); return GLib.SOURCE_REMOVE; });
        }));
    }
    popover.set_child(box);
    popover.set_parent(anchor);
    popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (popover.get_parent()) popover.unparent();
        return GLib.SOURCE_REMOVE;
    }));
    popover.popup();
    return popover;
}
