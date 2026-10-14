// Preferences dialog. Its widgets are declared in preferences.ui and bound directly to
// GSettings; the main window applies the changes through the "changed" signal.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { DEEPSEEK_MODELS } from '../agent/deepseek.js';
import { LOCAL_MACHINE, machineProjectKey } from '../agent/daemon/machines.js';
import { uiTemplate } from '../gtkutil.js';
import { _ } from '../i18n.js';
import { machineDialog } from './dialogs.js';
import type { AppSettings } from '../settings.js';
import template from './preferences.ui?raw';

// The same order as the "Color scheme" items in preferences.ui.
const SCHEMES = ['system', 'light', 'dark'];

export class PreferencesDialog extends Adw.PreferencesDialog {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkPreferencesDialog',
            Template: uiTemplate(template),
            InternalChildren: ['colorScheme', 'focus', 'typewriter', 'home', 'autosave', 'chatModel', 'chatModels', 'chatThinking', 'chatSave', 'forgePoll', 'forgeNotify', 'harnessMachine', 'harnessMachines', 'daemonCommand', 'machinesGroup', 'addMachine'],
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
    declare _harnessMachine: Adw.ComboRow;
    declare _harnessMachines: Gtk.StringList;
    declare _daemonCommand: Adw.EntryRow;
    declare _machinesGroup: Adw.PreferencesGroup;
    declare _addMachine: Gtk.Button;
    private machineRows: Adw.ActionRow[] = [];
    private fillingMachines = false;

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

        gs.bind('daemon-command', this._daemonCommand, 'text', flags);
        this.fillMachines(settings);
        gs.connect('changed::machines', () => this.fillMachines(settings));
        gs.connect('changed::harness-machine', () => this.fillMachines(settings));
        this._harnessMachine.connect('notify::selected', () => {
            if (!this.fillingMachines) settings.harnessMachine = this.machineChoices(settings)[this._harnessMachine.selected] ?? '';
        });
        this._addMachine.connect('clicked', () => void this.addMachine(settings));
    }

    // The values of "Run agents", in the order of its rows: in this window, this computer, then the SSH machines.
    private machineChoices(settings: AppSettings): string[] {
        return ['', LOCAL_MACHINE, ...Object.keys(settings.machines)];
    }

    // Rebuilds the "Run agents" choices and the list of machines from the settings.
    private fillMachines(settings: AppSettings): void {
        const machines = settings.machines;
        this.fillingMachines = true;
        this._harnessMachines.splice(0, this._harnessMachines.get_n_items(), [_('In this window'), _('This computer (markworkd)'), ...Object.keys(machines)]);
        this._harnessMachine.selected = Math.max(0, this.machineChoices(settings).indexOf(settings.harnessMachine));
        this.fillingMachines = false;

        for (const row of this.machineRows.splice(0)) this._machinesGroup.remove(row);
        for (const [name, target] of Object.entries(machines)) {
            const row = new Adw.ActionRow({ title: name, subtitle: target, subtitle_selectable: true });
            const remove = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Remove Machine') });
            remove.add_css_class('flat');
            remove.update_property([Gtk.AccessibleProperty.LABEL], [`${_('Remove Machine')}: ${name}`]);
            remove.connect('clicked', () => this.removeMachine(settings, name));
            row.add_suffix(remove);
            this._machinesGroup.add(row);
            this.machineRows.push(row);
        }
    }

    private async addMachine(settings: AppSettings): Promise<void> {
        const root = this.get_root();
        const machine = await machineDialog(root instanceof Gtk.Window ? root : null, Object.keys(settings.machines));
        if (machine) settings.machines = { ...settings.machines, [machine.name]: machine.target };
    }

    private removeMachine(settings: AppSettings, name: string): void {
        const { [name]: _removed, ...rest } = settings.machines;
        if (settings.harnessMachine === name) settings.harnessMachine = '';
        const projects = Object.fromEntries(Object.entries(settings.machineProjects).filter(([key]) => !key.startsWith(machineProjectKey(name, ''))));
        settings.machineProjects = projects;
        settings.machines = rest;
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
