// Preferences in the application layer: which settings the dialog shows and may change, their values as plain data, and
// the machines where agents run (adding one, removing one with what hangs on it). The dialog of a frontend is a view
// (docs/design/protocol.md 9.2): it opens with the values it is sent, reports each change as a key and a value, and is
// sent the values again when a setting changes anywhere (the menu, another window). A key or value that is not one of
// these is refused, so a frontend can write no setting but the ones the dialog has.

import { DEEPSEEK_MODELS } from '../agent/models.js';
import { LOCAL_MACHINE, isValidMachineName, isValidSshTarget, machineProjectKey } from '../agent/daemon/machines.js';
import type { AppSettings } from '../settings.js';
import type { Awaitable } from '../awaitable.js';
import type { Isolation } from '../agent/worktree.js';
import { _ } from '../i18n.js';
import type { Question } from './dialogs.js';
import { ProjectsPages, type ProjectPage, type ProjectRow, type ProjectsAccess, type WorktreeList } from './projects.js';

export const COLOR_SCHEMES = ['system', 'light', 'dark'] as const;
export const FORGE_POLL_RANGE = { min: 30, max: 3600 } as const;   // seconds; the same as the schema's

export interface MachineDraft {
    name: string;
    target: string;
}

// One choice of "Run agents".
export interface MachineChoice {
    value: string;      // '' = in this window, 'local' = the markworkd daemon here, else the name of an SSH machine
    label: string;
}

// Everything the dialog shows.
export interface PreferencesData {
    colorScheme: string;           // one of COLOR_SCHEMES
    focus: boolean;
    typewriter: boolean;
    home: boolean;
    autosave: boolean;
    chatModel: string;
    chatModels: string[];
    chatThinking: boolean;
    chatSave: boolean;
    forgePollSeconds: number;
    forgeNotify: boolean;
    daemonCommand: string;
    harnessMachine: string;
    machineChoices: MachineChoice[];
    machines: MachineDraft[];
    projects: ProjectRow[];        // the projects agents work on, on the machine they run on
}

// The settings the dialog may change by key, with what each accepts.
type Plain = string | number | boolean;
export type PreferenceKey = 'colorScheme' | 'focus' | 'typewriter' | 'home' | 'autosave' | 'chatModel' | 'chatThinking' | 'chatSave'
    | 'forgePollSeconds' | 'forgeNotify' | 'daemonCommand' | 'harnessMachine';

export interface PreferencesView {
    onSet: (key: PreferenceKey, value: Plain) => void;
    onAddMachine: () => Awaitable<void>;
    onRemoveMachine: (name: string) => void;
    onOpenProject: (name: string) => void;       // a project's row was chosen: its page and worktrees follow
    onSetProject: (name: string, patch: Partial<Isolation>) => Awaitable<string | null>;   // an error message, or null once written
    onRemoveWorktree: (name: string, path: string) => Awaitable<string | null>;
    open(data: PreferencesData): void;           // show the dialog
    showValues(data: PreferencesData): void;     // a setting changed while it is open
    showProject(page: ProjectPage): void;        // a project's page
    showWorktrees(list: WorktreeList): void;     // the card worktrees of a project
}

export interface PreferencesDialogs {
    machine(taken: string[]): Awaitable<MachineDraft | null>;
    removeWorktree(question: Question): Awaitable<boolean>;
}

export interface PreferencesHost {
    readonly settings: AppSettings;
    readonly harness: ProjectsAccess;
    readonly preferencesView: PreferencesView;
}

const isBool = (v: Plain): v is boolean => typeof v === 'boolean';
const isString = (v: Plain): v is string => typeof v === 'string';

export class PreferencesController {
    private isOpen = false;
    private readonly projects: ProjectsPages;
    private readonly stop: () => void;
    // The writer of each key; it answers false for a value the key does not take.
    private readonly writers: Record<PreferenceKey, (value: Plain) => boolean>;

    constructor(private readonly host: PreferencesHost, readonly dialogs: PreferencesDialogs) {
        const s = host.settings;
        const flag = (write: (v: boolean) => void) => (v: Plain) => isBool(v) && (write(v), true);
        this.writers = {
            colorScheme: v => (COLOR_SCHEMES as readonly Plain[]).includes(v) && (s.dark = v === 'system' ? null : v === 'dark', true),
            focus: flag(v => { s.focus = v; }),
            typewriter: flag(v => { s.typewriter = v; }),
            home: flag(v => { s.home = v; }),
            autosave: flag(v => { s.autosave = v; }),
            chatModel: v => isString(v) && DEEPSEEK_MODELS.includes(v) && (s.chatModel = v, true),
            chatThinking: flag(v => { s.chatThinking = v; }),
            chatSave: flag(v => { s.chatSave = v; }),
            forgePollSeconds: v => typeof v === 'number' && Number.isInteger(v) && v >= FORGE_POLL_RANGE.min && v <= FORGE_POLL_RANGE.max && (s.forgePollSeconds = v, true),
            forgeNotify: flag(v => { s.forgeNotify = v; }),
            daemonCommand: v => isString(v) && (s.daemonCommand = v, true),
            harnessMachine: v => isString(v) && this.machineChoices().some(c => c.value === v) && (s.harnessMachine = v, true),
        };
        const view = host.preferencesView;
        view.onSet = (key, value) => this.set(key, value);
        view.onAddMachine = () => this.addMachine();
        view.onRemoveMachine = name => this.removeMachine(name);
        this.projects = new ProjectsPages(s, host.harness, dialogs, list => host.preferencesView.showWorktrees(list));
        view.onOpenProject = name => this.openProject(name);
        view.onSetProject = (name, patch) => this.projects.set(name, patch);
        view.onRemoveWorktree = (name, path) => this.projects.remove(name, path);
        // The dialog follows the settings it shows, whoever changes them.
        this.stop = s.onChanged(null, () => { if (this.isOpen) host.preferencesView.showValues(this.data()); });
    }

    // Show the dialog. The frontend says when it is closed.
    open(): void {
        this.isOpen = true;
        this.host.preferencesView.open(this.data());
    }

    closed(): void {
        this.isOpen = false;
    }

    dispose(): void {
        this.stop();
    }

    data(): PreferencesData {
        const s = this.host.settings;
        return {
            colorScheme: s.dark === null ? 'system' : s.dark ? 'dark' : 'light',
            focus: s.focus, typewriter: s.typewriter, home: s.home, autosave: s.autosave,
            chatModel: s.chatModel, chatModels: [...DEEPSEEK_MODELS], chatThinking: s.chatThinking, chatSave: s.chatSave,
            forgePollSeconds: s.forgePollSeconds, forgeNotify: s.forgeNotify, daemonCommand: s.daemonCommand,
            harnessMachine: s.harnessMachine,
            machineChoices: this.machineChoices(),
            machines: Object.entries(s.machines).map(([name, target]) => ({ name, target })),
            projects: this.projects.rows(),
        };
    }

    // A project's row was chosen: send its page, then its card worktrees as git answers.
    private openProject(name: string): void {
        const page = this.projects.page(name);
        if (!page) return;
        this.host.preferencesView.showProject(page);
        void this.projects.load(name);
    }

    // The choices of "Run agents": in this window, this computer, then the SSH machines.
    private machineChoices(): MachineChoice[] {
        return [
            { value: '', label: _('In this window') },
            { value: LOCAL_MACHINE, label: _('This computer (markworkd)') },
            ...Object.keys(this.host.settings.machines).map(name => ({ value: name, label: name })),
        ];
    }

    // A change from the dialog. false = refused (a key or a value the dialog does not have).
    set(key: PreferenceKey, value: Plain): boolean {
        const write = Object.hasOwn(this.writers, key) ? this.writers[key] : undefined;
        return write ? write(value) : false;
    }

    async addMachine(): Promise<void> {
        const s = this.host.settings;
        const machine = await this.dialogs.machine(Object.keys(s.machines));
        if (!machine || !isValidMachineName(machine.name) || !isValidSshTarget(machine.target) || Object.hasOwn(s.machines, machine.name)) return;
        s.machines = { ...s.machines, [machine.name]: machine.target };
    }

    // Remove a machine, and what refers to it: the choice of where agents run, and the project folders it had.
    removeMachine(name: string): void {
        const s = this.host.settings;
        if (!Object.hasOwn(s.machines, name)) return;
        const { [name]: _removed, ...rest } = s.machines;
        if (s.harnessMachine === name) s.harnessMachine = '';
        const prefix = machineProjectKey(name, '');
        s.machineProjects = Object.fromEntries(Object.entries(s.machineProjects).filter(([key]) => !key.startsWith(prefix)));
        s.machines = rest;
    }
}
