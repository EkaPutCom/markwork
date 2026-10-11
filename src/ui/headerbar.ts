// Header bar (Adw.HeaderBar, wrapped in Adw.Bin because that class is final): the buttons and the ☰ menu, declared in headerbar.ui. Each button/menu
// only names an action ("app.save"); the action itself is registered in actions.ts.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';

import { uiTemplate } from '../gtkutil.js';
import template from './headerbar.ui?raw';

export class HeaderBar extends Adw.Bin {
    static {
        GObject.registerClass({
            GTypeName: 'NyeratHeaderBar',
            Template: uiTemplate(template),
            InternalChildren: ['windowTitle', 'layoutButton'],
        }, this);
    }
    declare _windowTitle: Adw.WindowTitle;
    declare _layoutButton: Gtk.MenuButton;

    setTitle(title: string, subtitle: string): void {
        this._windowTitle.set_title(title);
        this._windowTitle.set_subtitle(subtitle);
    }

    // The layout button shows the name of the layout the document is shown in; null hides it (Home).
    setLayoutLabel(label: string | null): void {
        this._layoutButton.set_visible(label !== null);
        if (label !== null) this._layoutButton.set_label(label);
    }
}
