// The Files view of the sidebar, as the Explorer of VS Code: sections that fold, share the height, and are shown or hidden
// from the view's ⋯ menu: Open Editors (by pane once the editor is split), the work folder, the Outline of the active
// document, and the Timeline of its file. Which are folded or hidden, and their sizes, are a setting the window writes.

import { Fragment, useRef, useState, type ReactNode } from 'react';
import { FolderTree } from './Explorer.js';
import { Icon } from './Icons.js';
import { commitTime } from './notes.js';
import { OutlineList } from './Outline.js';
import { SECTIONS, type SectionId, type SectionState } from '../lib/client.js';
import * as P from '../lib/panes.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu.js';

const MENU_NAMES: Record<SectionId, string> = { editors: 'Open Editors', folder: 'Folders', outline: 'Outline', timeline: 'Timeline' };

// One row of Open Editors: a document, as a tab of the pane that shows it.
function EditorRow({ doc, pane, current }: { doc: number; pane: number; current: boolean }) {
    const client = useClient();
    const tab = useStore().tabs.find(t => t.id === doc);
    if (!tab) return null;
    const board = ['board', 'inbox', 'table', 'calendar', 'timeline', 'gallery', 'chart'].includes(tab.page);
    return (
        <div role="option" aria-selected={current} tabIndex={0} className={`row${current ? ' active' : ''}`} title={tab.file ?? tab.name}
            onClick={() => client.selectTab(doc, pane)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); client.selectTab(doc, pane); } }}>
            <Icon name={board ? 'view-dual' : 'text-x-generic'} className="icon" />
            <span className="label">{tab.name}</span>
            {tab.mirror.modified && <span className="dot" role="img" aria-label="Unsaved" />}
            <button className="button flat circular close" aria-label={`Close editor ${tab.name}`} onClick={e => { e.stopPropagation(); client.closeTab(doc, pane); }}>
                <Icon name="window-close" size={14} />
            </button>
        </div>
    );
}

function OpenEditors() {
    const { panes } = useStore();
    const list = P.panesOf(panes);
    if (list.every(p => p.tabs.length === 0)) return <p className="empty">No documents are open.</p>;
    return (
        <div role="listbox" aria-label="Open Editors" className="editors">
            {list.map((pane, i) => (
                <Fragment key={pane.id}>
                    {list.length > 1 && <div className="group-title">Pane {i + 1}</div>}
                    {pane.tabs.map(doc => <EditorRow key={doc} doc={doc} pane={pane.id} current={panes.current === pane.id && pane.active === doc} />)}
                </Fragment>
            ))}
        </div>
    );
}

function Timeline() {
    const client = useClient();
    const { history } = useStore();
    if (history.commits.length === 0) return <p className="empty">{history.note || 'No history for this document.'}</p>;
    return (
        <div className="commits" aria-label="Timeline">
            {history.commits.map(c => (
                <button key={c.hash} className="commit" onClick={() => client.openCommit(c.hash)}>
                    <span className="subject">{c.subject || '(no message)'}</span>
                    <span className="meta">{c.author} · {commitTime(c.time)}</span>
                </button>
            ))}
            {history.more && <button className="button" onClick={() => client.moreHistory()}>Load more</button>}
        </div>
    );
}

// A section: its header folds it, shows its actions while the pointer is on it, and its body is what it holds.
function Section({ id, title, state, count, actions, children }: { id: SectionId; title: string; state: SectionState; count?: number; actions?: ReactNode; children: ReactNode }) {
    const client = useClient();
    const toggle = () => client.setSection(id, { open: !state.open });
    return (
        <div className={`section${state.open ? ' open' : ''}`} data-section={id} style={state.open ? { flex: `${state.size} 1 0` } : undefined}>
            <div className="section-head" role="button" tabIndex={0} aria-expanded={state.open} onClick={toggle}
                onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } }}>
                <Icon name="pan-end" size={14} className="chev" />
                <span className="t">{title}</span>
                {count !== undefined && <span className="count">{count}</span>}
                {state.open && actions && <span className="acts" onClick={e => e.stopPropagation()}>{actions}</span>}
            </div>
            {state.open && <div className="section-body">{children}</div>}
        </div>
    );
}

// The line between two open sections: dragged, it moves the share of the height of the two.
function Sash({ above, below }: { above: SectionId; below: SectionId }) {
    const client = useClient();
    const drag = useRef<{ y: number; a: number; b: number; px: number } | null>(null);
    const [on, setOn] = useState(false);
    return (
        <div role="separator" aria-orientation="horizontal" className={`section-sash${on ? ' on' : ''}`}
            onPointerDown={e => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                const sections = client.sidebarSections();
                const open = SECTIONS.filter(s => !sections[s].hidden && sections[s].open);
                const holder = e.currentTarget.parentElement!;
                const heights = [...holder.querySelectorAll<HTMLElement>('.section.open')].reduce((n, el) => n + el.getBoundingClientRect().height, 0);
                drag.current = { y: e.clientY, a: sections[above].size, b: sections[below].size, px: heights / open.reduce((n, s) => n + sections[s].size, 0) };
                setOn(true);
            }}
            onPointerMove={e => {
                const d = drag.current;
                if (!d) return;
                const sum = d.a + d.b, size = Math.min(sum - 0.2, Math.max(0.2, d.a + (e.clientY - d.y) / d.px));
                const sections = client.sidebarSections();
                client.writeSections({ ...sections, [above]: { ...sections[above], size }, [below]: { ...sections[below], size: sum - size } });
            }}
            onPointerUp={() => { drag.current = null; setOn(false); }} />
    );
}

export function FilesView() {
    const client = useClient();
    const { tabs, panes, tree } = useStore();
    const sections = client.sidebarSections();
    const root = tree.root;
    const name = root?.split(/[\\/]/).filter(Boolean).pop() ?? 'Folder';
    const shown = SECTIONS.filter(id => !sections[id].hidden);
    const count = P.panesOf(panes).reduce((n, p) => n + p.tabs.length, 0);
    const bodies: Record<SectionId, { title: string; count?: number; actions?: ReactNode; body: ReactNode }> = {
        editors: { title: 'Open Editors', count: tabs.length === 0 ? undefined : count, body: <OpenEditors /> },
        folder: {
            title: name,
            actions: root && (
                <>
                    <Button variant="ghost" size="icon-xs" title="New File…" aria-label="New File" onClick={() => client.createEntry('file', root)}><Icon name="document-new" size={15} /></Button>
                    <Button variant="ghost" size="icon-xs" title="New Folder…" aria-label="New Folder" onClick={() => client.createEntry('folder', root)}><Icon name="folder" size={15} /></Button>
                    <Button variant="ghost" size="icon-xs" title="Collapse Folders" aria-label="Collapse Folders" onClick={() => client.collapseFolders()}><Icon name="chevrons-up-down" size={15} /></Button>
                </>
            ),
            body: <FolderTree />,
        },
        outline: { title: 'Outline', body: <OutlineList /> },
        timeline: { title: 'Timeline', body: <Timeline /> },
    };
    const open = shown.filter(id => sections[id].open);
    return (
        <aside className="sidebar files-view" aria-label="Files">
            <div className="side-title">
                <span>Explorer</span>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label="Views and More Actions" title="Views and More Actions"><Icon name="view-more-horizontal" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-52" onCloseAutoFocus={e => e.preventDefault()}>
                        <DropdownMenuLabel>Sections</DropdownMenuLabel>
                        {SECTIONS.map(id => (
                            <DropdownMenuCheckboxItem key={id} checked={!sections[id].hidden} onSelect={() => client.setSection(id, { hidden: !sections[id].hidden })}>{MENU_NAMES[id]}</DropdownMenuCheckboxItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => client.writeSections(Object.fromEntries(SECTIONS.map(id => [id, { ...sections[id], open: false }])) as typeof sections)}>Collapse All Sections</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            <div className="sections">
                {shown.length === 0 && <p className="empty">All sections are hidden. Use the ⋯ menu to show one.</p>}
                {shown.map(id => (
                    <Fragment key={id}>
                        {sections[id].open && open.indexOf(id) > 0 && <Sash above={open[open.indexOf(id) - 1]} below={id} />}
                        <Section id={id} title={bodies[id].title} state={sections[id]} count={bodies[id].count} actions={bodies[id].actions}>{bodies[id].body}</Section>
                    </Fragment>
                ))}
            </div>
        </aside>
    );
}

