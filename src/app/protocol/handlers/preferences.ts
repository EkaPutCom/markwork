// The Preferences dialog: a setting changed in it, and the dialog closing (PreferencesController).

import { RequestError } from '../messages';
import type { PreferenceKey } from '../../preferences';
import { str, type HandlerContext } from './context';

export function preferencesHandlers({ wire, session, frontend }: HandlerContext): void {
    const view = frontend.preferences;

    // A key or a value the dialog does not have is refused; the values the dialog shows are sent again by the controller.
    wire.on('act.prefs.set', p => {
        const value = p.value;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new RequestError('bad_request', 'value is missing');
        if (!session.preferences.set(str(p.key, 'key') as PreferenceKey, value)) throw new RequestError('bad_request', 'that is not a setting of the dialog');
    });
    // The Agents page. A machine is added through the dialog (the controller re-checks what it answers); a project and a worktree
    // must be ones the controller listed, and a change to a project is checked field by field before it is written.
    wire.on('act.prefs.addMachine', async () => { await view.onAddMachine(); });
    wire.on('act.prefs.removeMachine', p => { view.onRemoveMachine(str(p.name, 'name')); });
    wire.on('act.prefs.openProject', p => { view.onOpenProject(str(p.name, 'name')); });
    wire.on('act.prefs.setProject', async p => {
        if (!p.patch || typeof p.patch !== 'object' || Array.isArray(p.patch)) throw new RequestError('bad_request', 'patch is missing');
        return { error: await view.onSetProject(str(p.name, 'name'), p.patch as Parameters<typeof view.onSetProject>[1]) };
    });
    wire.on('act.prefs.removeWorktree', async p => ({ error: await view.onRemoveWorktree(str(p.name, 'name'), str(p.path, 'path')) }));
    wire.on('act.prefs.closed', () => { session.preferences.closed(); });
}
