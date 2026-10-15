// Header bar (Adw.HeaderBar, wrapped in Adw.Bin because that class is final): the buttons and the menus, declared in headerbar.ui. Each button/menu
// only names an action ("app.save"); the action itself is registered in actions.ts.
//
//   [sidebar] [New ▾]        [• name ▾ / folder · Saved]        [Text ▾] [assistant] [☰] | window controls
//
// New ▾ creates and opens (and lists the recent files), the title is the document's menu (Save, Save As, Export, recent files), the
// layout button also holds the view modes, and ☰ starts with a row of quick actions. In a compact window the labels are hidden.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
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
            InternalChildren: ['titleStack', 'windowTitle', 'titleButton', 'documentTitle', 'newLabel', 'primaryButton', 'layoutButton', 'layoutIcon', 'layoutLabel', 'newMenu', 'documentMenu'],
            Properties: { compact: GObject.ParamSpec.boolean('compact', null, null, GObject.ParamFlags.READWRITE, false) },
        }, this);
    }
    declare _titleStack: Gtk.Stack;
    declare _windowTitle: Adw.WindowTitle;
    declare _titleButton: Gtk.MenuButton;
    declare _documentTitle: Adw.WindowTitle;
    declare _newLabel: Gtk.Label;
    declare _primaryButton: Gtk.MenuButton;
    declare _newMenu: Gio.Menu;
    declare _documentMenu: Gio.Menu;
    private readonly recent = new Gio.Menu();
    private isCompact = false;
    declare _layoutButton: Gtk.MenuButton;
    declare _layoutIcon: Gtk.Image;
    declare _layoutLabel: Gtk.Label;

    constructor() {
        super();
        this._layoutButton.set_popover(this.layoutPopover());
        (this._primaryButton.get_popover() as Gtk.PopoverMenu).add_child(this.quickActions(), 'quick');
        // The same Recent section in the New menu and in the document's menu.
        this._newMenu.append_section(_('Recent'), this.recent);
        this._documentMenu.append_section(_('Recent'), this.recent);
    }

    // A window narrower than the breakpoint (600sp) shows icons only, so the header bar fits.
    get compact(): boolean { return this.isCompact; }
    set compact(value: boolean) {
        if (value === this.isCompact) return;
        this.isCompact = value;
        this._newLabel.set_visible(!value);
        this._layoutLabel.set_visible(!value);
        this.notify('compact');
    }

    // The first row of the ☰ menu: the three actions used most from anywhere, with a label under the icon.
    private quickActions(): Gtk.Widget {
        const row = new Gtk.Box({ spacing: 6, homogeneous: true, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6 });
        const items: [string, string, string][] = [
            ['system-run-symbolic', _('Commands'), 'app.command-palette'],
            ['edit-find-symbolic', _('Find'), 'app.find'],
            ['document-send-symbolic', _('Export'), 'app.export-html'],
        ];
        for (const [icon, label, action] of items) {
            const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
            content.append(Gtk.Image.new_from_icon_name(icon));
            content.append(new Gtk.Label({ label }));
            const button = new Gtk.Button({ child: content, action_name: action, tooltip_text: label });
            button.connect('clicked', () => this._primaryButton.popdown());
            row.append(button);
        }
        return row;
    }

    // The recent files (most recent first) listed in the New menu and the document's menu; a click opens one.
    setRecent(paths: readonly string[]): void {
        this.recent.remove_all();
        for (const path of paths) {
            const item = Gio.MenuItem.new(GLib.path_get_basename(path), null);
            item.set_action_and_target_value('app.open-recent', GLib.Variant.new_string(path));
            this.recent.append_item(item);
        }
    }

    // A row for each layout with its icon, checked for the one the document is in (the toggle follows the state of `app.layout`),
    // then the view modes as check buttons (they follow the boolean state of their actions).
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
        box.append(new Gtk.Separator({ margin_top: 4, margin_bottom: 4 }));
        for (const [action, label] of [['app.source', _('Source Mode')], ['app.focus', _('Focus Mode')], ['app.typewriter', _('Typewriter Mode')]])
            box.append(new Gtk.CheckButton({ label, action_name: action, margin_start: 6, margin_end: 6 }));
        popover.set_child(box);
        return popover;
    }

    // `document` makes the title the document's menu button; Home has a plain title.
    setTitle(title: string, subtitle: string, document = false): void {
        const shown = document ? this._documentTitle : this._windowTitle;
        shown.set_title(title);
        shown.set_subtitle(subtitle);
        this._titleStack.set_visible_child_name(document ? 'document' : 'plain');
    }

    // The layout button shows the layout the document is shown in (its name and icon); null hides it (Home).
    setLayoutButton(shown: { label: string; icon: string } | null): void {
        this._layoutButton.set_visible(shown !== null);
        if (!shown) return;
        this._layoutLabel.set_label(shown.label);
        this._layoutIcon.set_from_icon_name(shown.icon);
    }
}
