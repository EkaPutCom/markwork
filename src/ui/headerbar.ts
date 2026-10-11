// Header bar (Adw.HeaderBar, wrapped in Adw.Bin because that class is final): the buttons and the ☰ menu, declared in headerbar.ui. Each button/menu
// only names an action ("app.save"); the action itself is registered in actions.ts.

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';

import { _ } from '../i18n.js';
import { uiTemplate } from '../gtkutil.js';
import template from './headerbar.ui?raw';

// What the layout menu offers and the layout button shows: the layout's name and icon. The target is the value of the `app.layout`
// action: a layout, or '' for the text view.
export interface LayoutChoice { target: string; label: () => string; icon: string }
export const LAYOUT_CHOICES: readonly LayoutChoice[] = [
    { target: 'table', label: () => _('Table'), icon: 'x-office-spreadsheet-symbolic' },
    { target: 'board', label: () => _('Board'), icon: 'view-dual-symbolic' },
    { target: 'list', label: () => _('List'), icon: 'view-list-symbolic' },
    { target: 'calendar', label: () => _('Calendar'), icon: 'x-office-calendar-symbolic' },
    { target: 'timeline', label: () => _('Timeline'), icon: 'view-continuous-symbolic' },
    { target: 'gallery', label: () => _('Gallery'), icon: 'view-grid-symbolic' },
    { target: 'chart', label: () => _('Chart'), icon: 'view-sort-descending-symbolic' },
    { target: '', label: () => _('Text'), icon: 'text-x-generic-symbolic' },
];

export class HeaderBar extends Adw.Bin {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkHeaderBar',
            Template: uiTemplate(template),
            InternalChildren: ['windowTitle', 'layoutButton', 'layoutIcon', 'layoutLabel'],
        }, this);
    }
    declare _windowTitle: Adw.WindowTitle;
    declare _layoutButton: Gtk.MenuButton;
    declare _layoutIcon: Gtk.Image;
    declare _layoutLabel: Gtk.Label;

    constructor() {
        super();
        this._layoutButton.set_popover(this.layoutPopover());
    }

    // A row for each layout with its icon, checked for the one the document is in (the toggle follows the state of `app.layout`).
    private layoutPopover(): Gtk.Popover {
        const popover = new Gtk.Popover();
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        for (const choice of LAYOUT_CHOICES) {
            if (choice.target === '') box.append(new Gtk.Separator({ margin_top: 4, margin_bottom: 4 }));
            const row = new Gtk.Box({ spacing: 10 });
            row.append(Gtk.Image.new_from_icon_name(choice.icon));
            row.append(new Gtk.Label({ label: choice.label(), xalign: 0, hexpand: true }));
            const item = new Gtk.ToggleButton({ child: row, action_name: 'app.layout', action_target: GLib.Variant.new_string(choice.target) });
            item.add_css_class('flat');
            item.connect('clicked', () => popover.popdown());
            box.append(item);
        }
        popover.set_child(box);
        return popover;
    }

    setTitle(title: string, subtitle: string): void {
        this._windowTitle.set_title(title);
        this._windowTitle.set_subtitle(subtitle);
    }

    // The layout button shows the layout the document is shown in (its name and icon); null hides it (Home).
    setLayoutButton(shown: { label: string; icon: string } | null): void {
        this._layoutButton.set_visible(shown !== null);
        if (!shown) return;
        this._layoutLabel.set_label(shown.label);
        this._layoutIcon.set_from_icon_name(shown.icon);
    }
}
