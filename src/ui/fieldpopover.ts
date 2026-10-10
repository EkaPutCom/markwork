// A small popover to change one field of an item in place: a list of options for a select (with a way to type
// an option that is not in the list yet), a calendar for a date, and an entry with validation for the rest.
// It only collects the new text; the caller writes it into the document (one undo step).

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { nearestOption, OPTION_TEXT, parseValue, type FieldDef } from '../markdown/fields.js';
import { withDueDate } from '../markdown/kanban.js';
import { _ } from '../i18n.js';

export interface FieldPopoverOptions {
    def: FieldDef;
    current: string;                                  // the field's text now, empty if the item has no value
    apply(raw: string, newOption?: string): void;     // raw '' clears the field; newOption is added to the field's list first
}

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
    // Typing can start at once; an entry that is left without focus in a closing popover also crashed GTK in tests.
    box.connect('map', () => entry.grab_focus());
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

// One popover that a view keeps for its whole life. It is a child of a widget that is never rebuilt (the view's own
// widget) and points at the chip or button that was clicked, so redrawing the rows and cards under it never destroys a
// popover. Creating and unparenting a popover for every click raced with its closing in GTK and crashed now and then.
// A change is handed to `apply` only after the popover has closed, because applying it redraws the view.
export class FieldPopover {
    private popover: Gtk.Popover | null = null;
    private pending: (() => void) | null = null;

    constructor(private readonly host: Gtk.Widget) {}

    // The options of `options.def` (or a calendar, or an entry) in the popover, pointing at `source`.
    edit(source: Gtk.Widget, options: FieldPopoverOptions): Gtk.Popover | null {
        const { def } = options;
        const wrapped = { ...options, apply: (raw: string, newOption?: string) => this.finish(() => options.apply(raw, newOption)) };
        return this.show(source, def.type === 'date' ? dateContent(wrapped)
            : def.type === 'select' && !def.multiple && def.options.length ? selectContent(wrapped) : entryContent(wrapped));
    }

    // A list of the fields that have no value yet; choosing one calls `choose` after the list has closed.
    menu(source: Gtk.Widget, defs: FieldDef[], choose: (def: FieldDef) => void): Gtk.Popover | null {
        const box = content();
        for (const def of defs) box.append(flatButton(def.key, () => this.finish(() => choose(def))));
        return this.show(source, box);
    }

    private finish(run: () => void): void {
        this.pending = run;
        this.popover?.popdown();
    }

    private show(source: Gtk.Widget, child: Gtk.Widget): Gtk.Popover | null {
        const at = source.translate_coordinates(this.host, 0, 0);
        if (!at?.[0]) return null;
        const popover = this.ensure();
        if (popover.get_mapped()) popover.popdown();
        this.pending = null;
        popover.set_child(child);
        popover.set_pointing_to(new Gdk.Rectangle({ x: Math.round(at[1]), y: Math.round(at[2]), width: source.get_width(), height: source.get_height() }));
        popover.popup();
        return popover;
    }

    private ensure(): Gtk.Popover {
        if (this.popover) return this.popover;
        const popover = new Gtk.Popover();
        popover.set_parent(this.host);
        popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const run = this.pending;
            this.pending = null;
            run?.();
            return GLib.SOURCE_REMOVE;
        }));
        // A widget must not be finalized with a child popover left on it.
        this.host.connect('destroy', () => { if (popover.get_parent()) popover.unparent(); });
        this.popover = popover;
        return popover;
    }
}
