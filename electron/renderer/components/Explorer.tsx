// The Files tab: the work folder as a tree that reads a folder when it is first opened. The core sends the
// entries (view.tree.*) and does the work (create, rename, delete to the Trash, move, copy in); this draws and reports.
// A right click opens a menu, F2 and Delete work on the focused row, a row can be dragged onto a folder, and files dropped from
// a file manager are copied in.

import { useRef, useState, type DragEvent } from 'react';
import type { FolderEntry, NewKind } from '../../../src/app/protocol/tree.js';
import { Icon } from './Icons.js';
import { FILE_DRAG } from './Tabs.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Button } from '../ui/button.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '../ui/context-menu.js';

const INTERNAL = 'application/x-markwork-path';


const NEW_ITEMS: { kind: NewKind; label: string }[] = [
    { kind: 'file', label: 'New File…' }, { kind: 'folder', label: 'New Folder…' }, { kind: 'board', label: 'New Kanban Board…' },
    { kind: 'inbox', label: 'New Inbox…' }, { kind: 'table', label: 'New Table…' }, { kind: 'csv', label: 'New CSV Table…' },
];

// The menu of a right click on the tree: what to make in the folder (or beside the file) clicked, and for a row its Rename
// and Move to Trash. `target` is null for the work folder itself.
function TreeMenu({ target, root }: { target: FolderEntry | null; root: string }) {
    const client = useClient();
    // New things go into the folder clicked, or next to the file clicked.
    const dir = !target ? root : target.isDir ? target.path : target.path.slice(0, Math.max(target.path.lastIndexOf('/'), target.path.lastIndexOf('\\')));
    return (
        <ContextMenuContent className="min-w-52">
            {NEW_ITEMS.map(i => <ContextMenuItem key={i.kind} onSelect={() => client.createEntry(i.kind, dir)}>{i.label}</ContextMenuItem>)}
            {target && <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => client.renameEntry(target.path)}>Rename…<ContextMenuShortcut>F2</ContextMenuShortcut></ContextMenuItem>
                <ContextMenuItem onSelect={() => client.removeEntry(target.path)}>Move to Trash<ContextMenuShortcut>Del</ContextMenuShortcut></ContextMenuItem>
            </>}
        </ContextMenuContent>
    );
}

function Row({ entry, depth, onMenu }: { entry: FolderEntry; depth: number; onMenu: (target: FolderEntry) => void }) {
    const client = useClient();
    const { tree } = useStore();
    const open = entry.isDir && tree.expanded.includes(entry.path);
    const active = tree.revealed === entry.path;
    const [over, setOver] = useState(false);
    const activate = () => (entry.isDir ? client.toggleFolder(entry.path) : client.activateEntry(entry.path));

    // A folder takes what is dropped on it; a file takes nothing (the drop goes to the folder around it).
    const drop = (e: DragEvent) => {
        setOver(false);
        if (!entry.isDir) return;
        e.preventDefault();
        e.stopPropagation();
        const source = e.dataTransfer.getData(INTERNAL);
        if (source) { if (source !== entry.path) client.moveEntry(source, entry.path); return; }
        client.copyInto(window.markwork.pathsOf([...e.dataTransfer.files]), entry.path);
    };
    return (
        <>
            <div
                role="treeitem" tabIndex={0} aria-expanded={entry.isDir ? open : undefined} aria-selected={active}
                className={`row${active ? ' active' : ''}${over ? ' drop' : ''}`} style={{ paddingLeft: 10 + depth * 20 }}
                draggable onDragStart={e => { e.dataTransfer.setData(INTERNAL, entry.path); if (!entry.isDir) e.dataTransfer.setData(FILE_DRAG, entry.path); e.dataTransfer.effectAllowed = 'copyMove'; }}
                onDragOver={e => { if (entry.isDir) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)} onDrop={drop}
                onClick={activate} onContextMenu={() => onMenu(entry)}
                onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
                    else if (e.key === 'F2') { e.preventDefault(); client.renameEntry(entry.path); }
                    else if (e.key === 'Delete') { e.preventDefault(); client.removeEntry(entry.path); }
                }}
            >
                {entry.isDir ? <Icon name={open ? 'pan-down' : 'pan-end'} size={12} className="twisty" /> : <span className="twisty" />}
                <Icon name={entry.isDir ? 'folder' : 'text-x-generic'} className="icon" />
                <span className="label">{entry.name}</span>
            </div>
            {open && <Folder dir={entry.path} depth={depth + 1} onMenu={onMenu} />}
        </>
    );
}

function Folder({ dir, depth, onMenu }: { dir: string; depth: number; onMenu: (target: FolderEntry) => void }) {
    const { tree } = useStore();
    const entries = tree.folders[dir];
    if (!entries) return <div className="row" style={{ paddingLeft: 10 + depth * 20 }}><span className="label dim">Loading…</span></div>;
    return <>{entries.map(e => <Row key={e.path} entry={e} depth={depth} onMenu={onMenu} />)}</>;
}

// The work folder as a tree: the body of the Files view's folder section.
export function FolderTree() {
    const client = useClient();
    const { tree } = useStore();
    // A right click on a row names it, then reaches the tree, whose menu opens for it; on the tree itself, for the folder.
    const clicked = useRef<FolderEntry | null>(null);
    const [target, setTarget] = useState<FolderEntry | null>(null);
    const { root } = tree;
    const name = root?.split(/[\\/]/).pop() ?? '';

    if (!root) {
        return (
            <div className="placeholder">
                <p>No folder is open</p>
                <Button variant="outline" size="sm" onClick={() => void client.openFolder()}>Open Folder…</Button>
            </div>
        );
    }
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div className="tree" role="tree" aria-label={name} onContextMenu={() => { setTarget(clicked.current); clicked.current = null; }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                        e.preventDefault();
                        const source = e.dataTransfer.getData(INTERNAL);
                        if (source) client.moveEntry(source, root); else client.copyInto(window.markwork.pathsOf([...e.dataTransfer.files]), root);
                    }}>
                    <Folder dir={root} depth={0} onMenu={entry => { clicked.current = entry; }} />
                    {tree.folders[root]?.length === 0 && <p className="empty">No notes in this folder.</p>}
                </div>
            </ContextMenuTrigger>
            <TreeMenu target={target} root={root} />
        </ContextMenu>
    );
}
