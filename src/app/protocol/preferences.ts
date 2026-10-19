// The Preferences dialog over the protocol: the values go out as `view.prefs.open` and `view.prefs.values` (whenever a setting
// changes while it is open), and a change comes back as `act.prefs.set` (docs/design/protocol.md 9.2). The project pages and the
// worktrees of the agent tab (showProject, showWorktrees) are sent as they come; the general tabs do not use them.

import type { PreferencesData, PreferencesView } from '../preferences.js';
import type { Wire } from './messages.js';

export type { PreferencesData };

export class ProtocolPreferences implements PreferencesView {
    onSet: PreferencesView['onSet'] = () => {};
    onAddMachine: PreferencesView['onAddMachine'] = () => {};
    onRemoveMachine: PreferencesView['onRemoveMachine'] = () => {};
    onOpenProject: PreferencesView['onOpenProject'] = () => {};
    onSetProject: PreferencesView['onSetProject'] = () => null;
    onRemoveWorktree: PreferencesView['onRemoveWorktree'] = () => null;

    constructor(private readonly wire: Wire) {}

    open(data: PreferencesData): void { this.wire.notify('view.prefs.open', { data }); }
    showValues(data: PreferencesData): void { this.wire.notify('view.prefs.values', { data }); }
    showProject(page: Parameters<PreferencesView['showProject']>[0]): void { this.wire.notify('view.prefs.project', { page }); }
    showWorktrees(list: Parameters<PreferencesView['showWorktrees']>[0]): void { this.wire.notify('view.prefs.worktrees', { list }); }
}
