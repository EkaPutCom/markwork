import { useMemo, useState } from 'react';
import { Icon } from './Icons.js';
import { useClient, useStore } from './useClient.js';

interface Node { name: string; path: string; children: Node[] | null }

// The sorted tree of the file names ('/' separated): folders first, then files, each alphabetically, as the GTK window lists them.
function treeOf(files: string[]): Node[] {
    const root: Node = { name: '', path: '', children: [] };
    for (const file of files) {
        let at = root;
        file.split('/').forEach((part, i, parts) => {
            const last = i === parts.length - 1;
            const path = parts.slice(0, i + 1).join('/');
            let child = at.children!.find(c => c.name === part && (c.children === null) === last);
            if (!child) at.children!.push(child = { name: part, path, children: last ? null : [] });
            at = child;
        });
    }
    const sort = (nodes: Node[]) => {
        nodes.sort((a, b) => (a.children === null ? 1 : 0) - (b.children === null ? 1 : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        for (const n of nodes) if (n.children) sort(n.children);
    };
    sort(root.children!);
    return root.children!;
}

function Row({ node, depth, activePath, collapsed, toggle, open }: {
    node: Node; depth: number; activePath: string | null; collapsed: Set<string>; toggle: (path: string) => void; open: (path: string) => void;
}) {
    const isFolder = node.children !== null;
    const closed = collapsed.has(node.path);
    return (
        <>
            <div
                role="treeitem"
                tabIndex={0}
                aria-expanded={isFolder ? !closed : undefined}
                aria-selected={node.path === activePath}
                className={`row${node.path === activePath ? ' active' : ''}`}
                style={{ paddingLeft: 10 + depth * 20 }}
                onClick={() => (isFolder ? toggle(node.path) : open(node.path))}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (isFolder) toggle(node.path); else open(node.path); } }}
            >
                {isFolder ? <Icon name={closed ? 'pan-end' : 'pan-down'} size={12} className="twisty" /> : <span className="twisty" />}
                <Icon name={isFolder ? 'folder' : 'text-x-generic'} className="icon" />
                <span className="label">{node.name}</span>
            </div>
            {isFolder && !closed && node.children!.map(c => (
                <Row key={c.path} node={c} depth={depth + 1} activePath={activePath} collapsed={collapsed} toggle={toggle} open={open} />
            ))}
        </>
    );
}

export function Explorer() {
    const client = useClient();
    const { root, files, tabs, active } = useStore();
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const tree = useMemo(() => treeOf(files), [files]);
    const activeTab = tabs.find(t => t.id === active);
    const activePath = root && activeTab?.file && activeTab.file.startsWith(root) ? activeTab.file.slice(root.length + 1) : null;
    const toggle = (path: string) => setCollapsed(c => { const n = new Set(c); if (!n.delete(path)) n.add(path); return n; });
    const name = root?.split(/[\\/]/).pop() ?? '';

    return (
        <aside className="sidebar" aria-label="Files">
            <div className="side-title">{root ? name.toUpperCase() : 'FILES'}</div>
            {!root ? (
                <div className="placeholder">
                    <p>No folder is open</p>
                    <button className="button" onClick={() => void client.openFolder()}>Open Folder…</button>
                </div>
            ) : (
                <div className="tree" role="tree" aria-label={name}>
                    {tree.map(n => <Row key={n.path} node={n} depth={0} activePath={activePath} collapsed={collapsed} toggle={toggle} open={client.openFile} />)}
                    {tree.length === 0 && <p className="empty">No Markdown files in this folder.</p>}
                </div>
            )}
        </aside>
    );
}
