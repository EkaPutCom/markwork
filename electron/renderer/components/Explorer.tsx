// The Files tab: the work folder as a tree that reads a folder when it is first opened. The core sends the
// entries (view.tree.*) and does the work (create, rename, delete to the Trash, move, copy in); this draws and reports.
// A right click opens a menu, F2 and Delete work on the focused row, a row can be dragged onto a folder, and files dropped from
// a file manager are copied in.

import { useEffect, useState, type DragEvent } from 'react';
import type { FolderEntry, NewKind } from '../../../src/app/protocol/tree.js';
import { Icon } from './Icons.js';
import { FILE_DRAG } from './Tabs.js';
import { useClient, useStore } from '../lib/useClient.js';

const INTERNAL = 'application/x-markwork-path';


const NEW_ITEMS: { kind: NewKind; label: string }[] = [
    { kind: 'file', label: 'New File…' }, { kind: 'folder', label: 'New Folder…' }, { kind: 'board', label: 'New Kanban Board…' },
    { kind: 'inbox', label: 'New Inbox…' }, { kind: 'table', label: 'New Table…' }, { kind: 'csv', label: 'New CSV Table…' },
];

interface MenuState { x: number; y: number; target: FolderEntry | null }   // null = the work folder itself

function ContextMenu({ menu, root, close }: { menu: MenuState; root: string; close: () => void }) {
    const client = useClient();
    useEffect(() => {
        const away = (e: Event) => { if (!(e.target as Element).closest('.context-menu')) close(); };
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', away);
        document.addEventListener('keydown', key);
        return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
    }, [close]);
    const { target } = menu;
    // New things go into the folder clicked, or next to the file clicked.
    const dir = !target ? root : target.isDir ? target.path : target.path.slice(0, Math.max(target.path.lastIndexOf('/'), target.path.lastIndexOf('\\')));
    const run = (action: () => void) => () => { close(); action(); };
    return (
        <div className="popover context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
            {NEW_ITEMS.map(i => <button key={i.kind} role="menuitem" onClick={run(() => client.createEntry(i.kind, dir))}>{i.label}</button>)}
            {target && <hr />}
            {target && <button role="menuitem" onClick={run(() => client.renameEntry(target.path))}>Rename…<kbd>F2</kbd></button>}
            {target && <button role="menuitem" onClick={run(() => client.removeEntry(target.path))}>Move to Trash<kbd>Del</kbd></button>}
        </div>
    );
}

function Row({ entry, depth, onMenu }: { entry: FolderEntry; depth: number; onMenu: (e: React.MouseEvent, target: FolderEntry) => void }) {
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
                onClick={activate} onContextMenu={e => onMenu(e, entry)}
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

function Folder({ dir, depth, onMenu }: { dir: string; depth: number; onMenu: (e: React.MouseEvent, target: FolderEntry) => void }) {
    const { tree } = useStore();
    const entries = tree.folders[dir];
    if (!entries) return <div className="row" style={{ paddingLeft: 10 + depth * 20 }}><span className="label dim">Loading…</span></div>;
    return <>{entries.map(e => <Row key={e.path} entry={e} depth={depth} onMenu={onMenu} />)}</>;
}

export function Explorer() {
    const client = useClient();
    const { tree } = useStore();
    const [menu, setMenu] = useState<MenuState | null>(null);
    const { root } = tree;
    const name = root?.split(/[\\/]/).pop() ?? '';
    const show = (e: React.MouseEvent, target: FolderEntry | null) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, target }); };

    return (
        <aside className="sidebar" aria-label="Files">
            <div className="side-title">Files</div>
            {!root ? (
                <div className="placeholder">
                    <p>No folder is open</p>
                    <button className="button" onClick={() => void client.openFolder()}>Open Folder…</button>
                </div>
            ) : (
                <div className="tree" role="tree" aria-label={name} onContextMenu={e => show(e, null)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                        e.preventDefault();
                        const source = e.dataTransfer.getData(INTERNAL);
                        if (source) client.moveEntry(source, root); else client.copyInto(window.markwork.pathsOf([...e.dataTransfer.files]), root);
                    }}>
                    <Folder dir={root} depth={0} onMenu={show} />
                    {tree.folders[root]?.length === 0 && <p className="empty">No notes in this folder.</p>}
                </div>
            )}
            {menu && root && <ContextMenu menu={menu} root={root} close={() => setMenu(null)} />}
        </aside>
    );
}
