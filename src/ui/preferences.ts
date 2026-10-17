// Preferences dialog. Its widgets are declared in preferences.ui. It is a view (PreferencesView, app/preferences.ts):
// it shows the values it is sent, reports each change as a key and a value, and is sent the values again when a setting
// changes anywhere. Only the Projects group of the Agents page still reads the settings itself.

import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import { COLOR_SCHEMES, type PreferencesData, type PreferencesView } from '../app/preferences.js';
import { uiTemplate } from '../gtkutil.js';
import { _ } from '../i18n.js';
import type { ProjectPage, WorktreeList } from '../app/projects.js';
import { ProjectsGroup, ProjectSubpage } from './projectsettings.js';
import template from './preferences.ui?raw';

export class PreferencesDialog extends Adw.PreferencesDialog {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkPreferencesDialog',
            Template: uiTemplate(template),
            InternalChildren: ['colorScheme', 'focus', 'typewriter', 'home', 'autosave', 'chatModel', 'chatModels', 'chatThinking', 'chatSave', 'forgePoll', 'forgeNotify', 'harnessMachine', 'harnessMachines', 'daemonCommand', 'machinesGroup', 'addMachine', 'agentsPage'],
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
    declare _agentsPage: Adw.PreferencesPage;
    private machineRows: Adw.ActionRow[] = [];
    private machinesShown = '';
    private filling = false;   // the widgets are being set from the values: that is not a change of the user's

    private readonly projects: ProjectsGroup;
    private subpage: ProjectSubpage | null = null;

    constructor(private readonly view: PreferencesView, data: PreferencesData) {
        super();
        const set = (key: Parameters<PreferencesView['onSet']>[0], value: string | number | boolean) => { if (!this.filling) this.view.onSet(key, value); };
        const bindSwitch = (row: Adw.SwitchRow, key: 'focus' | 'typewriter' | 'home' | 'autosave' | 'chatThinking' | 'chatSave' | 'forgeNotify') =>
            row.connect('notify::active', () => set(key, row.active));
        bindSwitch(this._focus, 'focus');
        bindSwitch(this._typewriter, 'typewriter');
        bindSwitch(this._home, 'home');
        bindSwitch(this._autosave, 'autosave');
        bindSwitch(this._chatThinking, 'chatThinking');
        bindSwitch(this._chatSave, 'chatSave');
        bindSwitch(this._forgeNotify, 'forgeNotify');
        this._forgePoll.connect('notify::value', () => set('forgePollSeconds', Math.round(this._forgePoll.value)));
        this._colorScheme.connect('notify::selected', () => set('colorScheme', COLOR_SCHEMES[this._colorScheme.selected] ?? 'system'));
        this._chatModel.connect('notify::selected', () => set('chatModel', this.models[this._chatModel.selected] ?? ''));
        this._daemonCommand.connect('notify::text', () => set('daemonCommand', this._daemonCommand.text));
        this._harnessMachine.connect('notify::selected', () => set('harnessMachine', this.choices[this._harnessMachine.selected] ?? ''));
        this._addMachine.connect('clicked', () => void this.view.onAddMachine());
        this.projects = new ProjectsGroup(view);
        this._agentsPage.add(this.projects.group);
        this.showValues(data);
    }

    private models: string[] = [];
    private choices: string[] = [];

    // Set the widgets from the values; a widget that already shows its value is left alone.
    showValues(data: PreferencesData): void {
        this.filling = true;
        this._focus.active = data.focus;
        this._typewriter.active = data.typewriter;
        this._home.active = data.home;
        this._autosave.active = data.autosave;
        this._chatThinking.active = data.chatThinking;
        this._chatSave.active = data.chatSave;
        this._forgeNotify.active = data.forgeNotify;
        if (Math.round(this._forgePoll.value) !== data.forgePollSeconds) this._forgePoll.value = data.forgePollSeconds;
        this._colorScheme.selected = Math.max(0, COLOR_SCHEMES.indexOf(data.colorScheme as typeof COLOR_SCHEMES[number]));
        if (this.models.join() !== data.chatModels.join()) {
            this.models = data.chatModels;
            this._chatModels.splice(0, this._chatModels.get_n_items(), this.models);
        }
        this._chatModel.selected = Math.max(0, this.models.indexOf(data.chatModel));
        if (this._daemonCommand.text !== data.daemonCommand) this._daemonCommand.text = data.daemonCommand;
        this.fillMachines(data);
        this.projects.setRows(data.projects);
        this.filling = false;
    }

    // A project's page, pushed over the dialog; the worktrees follow as git answers.
    showProject(page: ProjectPage): void {
        this.subpage = new ProjectSubpage(this.view, page);
        this.push_subpage(this.subpage.navigation);
    }

    showWorktrees(list: WorktreeList): void {
        if (this.subpage?.name === list.project) this.subpage.showWorktrees(list);
    }

    // Rebuilds the "Run agents" choices and the list of machines.
    private fillMachines(data: PreferencesData): void {
        this.choices = data.machineChoices.map(c => c.value);
        this._harnessMachines.splice(0, this._harnessMachines.get_n_items(), data.machineChoices.map(c => c.label));
        this._harnessMachine.selected = Math.max(0, this.choices.indexOf(data.harnessMachine));

        const shown = JSON.stringify(data.machines);
        if (shown === this.machinesShown) return;
        this.machinesShown = shown;
        for (const row of this.machineRows.splice(0)) this._machinesGroup.remove(row);
        for (const { name, target } of data.machines) {
            const row = new Adw.ActionRow({ title: name, subtitle: target, subtitle_selectable: true });
            const remove = new Gtk.Button({ icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Remove Machine') });
            remove.add_css_class('flat');
            remove.update_property([Gtk.AccessibleProperty.LABEL], [`${_('Remove Machine')}: ${name}`]);
            remove.connect('clicked', () => this.view.onRemoveMachine(name));
            row.add_suffix(remove);
            this._machinesGroup.add(row);
            this.machineRows.push(row);
        }
    }
}

// The presenter the window hands the controller: it makes the dialog on `open` and keeps it up to date until it closes.
export class PreferencesPresenter implements PreferencesView {
    onSet: PreferencesView['onSet'] = () => {};
    onAddMachine: PreferencesView['onAddMachine'] = () => {};
    onRemoveMachine: PreferencesView['onRemoveMachine'] = () => {};
    onOpenProject: PreferencesView['onOpenProject'] = () => {};
    onSetProject: PreferencesView['onSetProject'] = () => 'preferences are not available';
    onRemoveWorktree: PreferencesView['onRemoveWorktree'] = () => 'preferences are not available';
    private dialog: PreferencesDialog | null = null;

    // parent: the window to present over; closed: told when the dialog closes.
    constructor(private readonly parent: () => Gtk.Widget, private readonly closed: () => void) {}

    open(data: PreferencesData): void {
        const dialog = new PreferencesDialog(this, data);
        this.dialog = dialog;
        dialog.connect('closed', () => { if (this.dialog === dialog) this.dialog = null; this.closed(); });
        dialog.present(this.parent());
    }

    showValues(data: PreferencesData): void {
        this.dialog?.showValues(data);
    }

    showProject(page: ProjectPage): void {
        this.dialog?.showProject(page);
    }

    showWorktrees(list: WorktreeList): void {
        this.dialog?.showWorktrees(list);
    }
}
