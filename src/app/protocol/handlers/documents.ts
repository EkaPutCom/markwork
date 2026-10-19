// Documents and their tabs (DocumentController, FilesController's folder): opening, switching, closing, and the text
// and cursor the frontend's editor reports (docs/design/protocol.md, section 5).

import { insideName } from '../../../files.js';
import { platform } from '../../../platform/index.js';
import { RequestError, type Change } from '../messages.js';
import { num, str, type HandlerContext } from './context.js';

export function documentHandlers({ wire, session, frontend, notice, sendFiles }: HandlerContext): void {
    // Open the tabs of the last session, or the path the frontend was started with.
    wire.on('start', p => {
        session.start();
        // The side panel's page as the settings have it, so the history is read when its tab is the one that was open.
        session.sidebarShown(session.settings.sidebar ? session.settings.sidebarPage : null);
        session.open(typeof p.path === 'string' ? p.path : null);
        sendFiles();
    });
    // A folder the user chose in a dialog of the frontend.
    wire.on('open.folder', async p => {
        await session.openFolder(str(p.path, 'path'));
        sendFiles();
    });
    // A file of the list the core sent (view.files): the core decides where it goes, a tab or the frontend's viewer.
    wire.on('open.file', p => {
        const root = session.files.root;
        const path = root && platform().paths.join(root, str(p.name, 'name'));
        if (!root || !path || insideName(root, path) === null) throw new RequestError('bad_request', 'that file is not in the work folder');
        session.host.openFile(path);
    });
    wire.on('tab.select', p => { session.documents.select(num(p.doc, 'doc')); });
    wire.on('tab.close', async p => ({ closed: await session.documents.closeById(num(p.doc, 'doc')) }));

    notice('doc.edit', p => frontend.editors.get(num(p.doc, 'doc'))?.receiveEdit(num(p.version, 'version'), p.modified === true, p.changes as Change[]));
    notice('doc.cursor', p => frontend.editors.get(num(p.doc, 'doc'))?.receiveCursor(num(p.version, 'version'), num(p.offset, 'offset'),
        (p.selection as [number, number] | null) ?? null));
    notice('window.active', p => session.windowFocused(p.active === true));
}
