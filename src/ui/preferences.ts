// Preferences dialog. Its widgets are declared in preferences.ui and bound directly to
// GSettings; the main window applies the changes through the "changed" signal.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { DEEPSEEK_MODELS } from '../agent/deepseek.js';
import { uiTemplate } from '../gtkutil.js';
import type { AppSettings } from '../settings.js';
import template from './preferences.ui?raw';

// The same order as the "Color scheme" items in preferences.ui.
const SCHEMES = ['system', 'light', 'dark'];

export class PreferencesDialog extends Adw.PreferencesDialog {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkPreferencesDialog',
            Template: uiTemplate(template),
            InternalChildren: ['colorScheme', 'focus', 'typewriter', 'home', 'autosave', 'chatModel', 'chatModels', 'chatThinking', 'chatSave', 'forgePoll', 'forgeNotify'],
        }, this);
    }

    declare _colorScheme: Adw.ComboRow;
    declare _focus: Adw.SwitchRow;
    declare _typewriter: Adw.SwitchRow;
    declare _home: Adw.SwitchRow;
    declare _autosave: Adw.SwitchRow;
    declare _chatModel: Adw.ComboRow;
    declare _chatModels: Gtk.StringList;
    declare _chatThinking: Adw.SwitchRow;
    declare _chatSave: Adw.SwitchRow;
    declare _forgePoll: Adw.SpinRow;
    declare _forgeNotify: Adw.SwitchRow;

    constructor(settings: AppSettings) {
        super();
        const gs = settings.gsettings;
        const flags = Gio.SettingsBindFlags.DEFAULT;
        gs.bind('focus', this._focus, 'active', flags);
        gs.bind('typewriter', this._typewriter, 'active', flags);
        gs.bind('home', this._home, 'active', flags);
        gs.bind('autosave', this._autosave, 'active', flags);
        gs.bind('chat-thinking', this._chatThinking, 'active', flags);
        gs.bind('chat-save', this._chatSave, 'active', flags);
        gs.bind('forge-poll-seconds', this._forgePoll, 'value', flags);
        gs.bind('forge-notify', this._forgeNotify, 'active', flags);

        this.bindChoice(gs, 'color-scheme', this._colorScheme, SCHEMES);
        for (const model of DEEPSEEK_MODELS) this._chatModels.append(model);
        this.bindChoice(gs, 'chat-model', this._chatModel, DEEPSEEK_MODELS);
    }

    // ComboRow ↔ string-typed key: the row index is the position of its value in `values`.
    private bindChoice(gs: Gio.Settings, key: string, row: Adw.ComboRow, values: string[]): void {
        const sync = () => {
            const index = values.indexOf(gs.get_string(key));
            if (index >= 0 && row.selected !== index) row.selected = index;
        };
        sync();
        gs.connect(`changed::${key}`, sync);
        row.connect('notify::selected', () => gs.set_string(key, values[row.selected]));
    }
}
