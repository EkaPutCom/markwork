// The Preferences dialog over the protocol: the values go out as `view.prefs.open` and `view.prefs.values` (whenever a setting
// changes while it is open), and a change comes back as `act.prefs.set` (docs/design/protocol.md 9.2). The project pages and the
// worktrees of the agent tab (showProject, showWorktrees) are sent as they come; the general tabs do not use them.

import type { MachineDraft, PreferencesData, PreferencesDialogs, PreferencesView } from '../preferences';
import type { ProjectPage, WorktreeList } from '../projects';
import type { Question } from '../dialogs';
import type { Asks } from './asks';
import type { Wire } from './messages';

export type { MachineDraft, PreferencesData, ProjectPage, WorktreeList };

export class ProtocolPreferences implements PreferencesView {
    onSet: PreferencesView['onSet'] = () => {};
    onAddMachine: PreferencesView['onAddMachine'] = async () => {};
    onRemoveMachine: PreferencesView['onRemoveMachine'] = () => {};
    onOpenProject: PreferencesView['onOpenProject'] = () => {};
    onSetProject: PreferencesView['onSetProject'] = async () => null;
    onRemoveWorktree: PreferencesView['onRemoveWorktree'] = async () => null;

    constructor(private readonly wire: Wire) {}

    open(data: PreferencesData): void { this.wire.notify('view.prefs.open', { data }); }
    showValues(data: PreferencesData): void { this.wire.notify('view.prefs.values', { data }); }
    showProject(page: Parameters<PreferencesView['showProject']>[0]): void { this.wire.notify('view.prefs.project', { page }); }
    showWorktrees(list: Parameters<PreferencesView['showWorktrees']>[0]): void { this.wire.notify('view.prefs.worktrees', { list }); }
}

// The questions of the Agents page: a machine to add (the name and where to reach it; the core checks both again), and the
// removal of a card worktree (a `Question`).
export class ProtocolPreferencesDialogs implements PreferencesDialogs {
    constructor(private readonly asks: Asks) {}

    machine(taken: string[]): Promise<MachineDraft | null> {
        return this.asks.ask<MachineDraft | null>('ask.machine', { taken }, r => {
            const m = r.machine as Partial<MachineDraft> | null | undefined;
            return m && typeof m.name === 'string' && typeof m.target === 'string' ? { name: m.name.trim(), target: m.target.trim() } : undefined;
        }, null);
    }

    removeWorktree(question: Question): Promise<boolean> { return this.asks.question('ask.removeWorktree', question); }
}
