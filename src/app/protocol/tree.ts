// The Files tab over the protocol (FileTreeView): the folders the tree has open go out as `view.tree.*`, and what the user did
// comes back as `act.tree.*` (docs/design/protocol.md 6.5). The frontend asks for the contents of a folder when it first opens
// it (`act.tree.openFolder`); the core then keeps sending that folder when it changes on disk.

import type { FileTreeView, FolderEntry } from '../files.js';
import type { Wire } from './messages.js';

export class ProtocolTree implements FileTreeView {
    onOpenFolder: FileTreeView['onOpenFolder'] = () => {};
    onActivate: FileTreeView['onActivate'] = () => {};
    onCreate: FileTreeView['onCreate'] = () => null;
    onRename: FileTreeView['onRename'] = () => null;
    onRemove: FileTreeView['onRemove'] = () => false;
    onMove: FileTreeView['onMove'] = () => false;
    onCopy: FileTreeView['onCopy'] = () => false;

    constructor(private readonly wire: Wire) {}

    showRoot(root: string | null, entries: FolderEntry[]): void { this.wire.notify('view.tree.root', { root, entries }); }
    showFolder(dir: string, entries: FolderEntry[]): void { this.wire.notify('view.tree.folder', { dir, entries }); }
    expand(dir: string): void { this.wire.notify('view.tree.expand', { dir }); }
    reveal(path: string | null): void { this.wire.notify('view.tree.reveal', { path }); }
}

// What a frontend needs of the files module, as types (the renderer takes them from here).
export type { FolderEntry, NewKind } from '../files.js';
