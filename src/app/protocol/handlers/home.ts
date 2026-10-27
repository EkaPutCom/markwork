// The Home tab: what the user did on it (HomeController, and the controllers its rows open).

import { RequestError } from '../messages';
import type { Task } from '../../../markdown/home';
import { num, str, type HandlerContext } from './context';

// A task as Home showed it: the core checks the card is still the one before it writes (HomeController.toggleTask).
function taskOf(value: unknown): Task {
    const t = value as Partial<Task> | undefined;
    const at = t?.at as Task['at'] | undefined;
    if (!t || typeof t.file !== 'string' || typeof t.card !== 'string' || typeof at?.column !== 'number' || typeof at?.index !== 'number') {
        throw new RequestError('bad_request', 'task is missing');
    }
    return t as Task;
}

export function homeHandlers({ wire, session }: HandlerContext): void {
    wire.on('act.home.openFile', p => { session.documents.openInTab(str(p.path, 'path')); });
    wire.on('act.home.openWorkspaceFile', p => { session.homePage.openWorkspaceFile(str(p.name, 'name')); });
    wire.on('act.home.toggleTask', p => ({ written: session.homePage.toggleTask(taskOf(p.task), p.done === true) }));
    wire.on('act.home.openRun', p => { session.harness.open(num(p.id, 'id')); });
    wire.on('act.home.openJournal', () => { session.journal.open(); });
}
