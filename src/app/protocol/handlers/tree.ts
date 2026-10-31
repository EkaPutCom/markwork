// The Files tab: what the user does with the tree (FilesController). A path must be one inside the work folder, except what
// is dropped in from a file manager, which is copied and never written over.

import { insideName } from '../../../base/files';
import type { NewKind } from '../../files';
import { RequestError } from '../messages';
import { str, type HandlerContext } from './context';

const KINDS: readonly NewKind[] = ['file', 'folder', 'board', 'inbox', 'table', 'csv', 'agent'];

export function treeHandlers({ wire, session, frontend }: HandlerContext): void {
    const tree = frontend.tree;
    // A path of the work folder (or the folder itself, where the tree is the root).
    const inRoot = (value: unknown, what: string, allowRoot = false): string => {
        const path = str(value, what), root = session.files.root;
        if (!root || (!(allowRoot && path === root) && insideName(root, path) === null)) throw new RequestError('bad_request', `${what} is not in the work folder`);
        return path;
    };

    wire.on('act.tree.openFolder', p => { tree.onOpenFolder(inRoot(p.dir, 'dir', true)); });
    wire.on('act.tree.activate', p => { tree.onActivate(inRoot(p.path, 'path')); });
    wire.on('act.tree.create', async p => {
        const kind = p.kind as NewKind;
        if (!KINDS.includes(kind)) throw new RequestError('bad_request', 'kind is not one the tree can make');
        return { path: await tree.onCreate(kind, inRoot(p.dir, 'dir', true)) };
    });
    wire.on('act.tree.rename', async p => ({ path: await tree.onRename(inRoot(p.path, 'path')) }));
    wire.on('act.tree.remove', async p => ({ removed: await tree.onRemove(inRoot(p.path, 'path')) }));
    wire.on('act.tree.move', async p => ({ moved: await tree.onMove(inRoot(p.source, 'source'), inRoot(p.dir, 'dir', true)) }));
    wire.on('act.tree.copy', async p => {
        const sources = Array.isArray(p.sources) ? p.sources.filter((s): s is string => typeof s === 'string') : [];
        return { copied: sources.length > 0 && await tree.onCopy(sources, inRoot(p.dir, 'dir', true)) };
    });
}
