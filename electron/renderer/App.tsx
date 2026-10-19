// The window, laid out as the GTK one is: a header bar, a rail of icons with its panel, the editor with its tabs, the
// counts at the foot, and the command palette over all of it.

import { useEffect, useMemo, useState } from 'react';
import { COMMANDS } from '../../src/app/commands.js';
import { countWords, cpLength } from '../../src/markdown/offsets.js';
import { EditorArea } from './EditorArea.js';
import { Explorer } from './Explorer.js';
import { Palette } from './Palette.js';
import { Tabs } from './Tabs.js';
import { Icon } from './Icons.js';
import { label, matches } from './keys.js';
import { useClient, useStore } from './useClient.js';

// The title of the header bar: the document's name over where it is, as the GTK window shows them.
function Title() {
    const s = useStore();
    const tab = s.tabs.find(t => t.id === s.active);
    if (!tab) return <div className="title"><span className="name">Markwork</span></div>;
    const dir = tab.file ? tab.file.replace(/[\\/][^\\/]*$/, '') : null;
    return (
        <div className="title">
            <span className="name">{tab.mirror.modified ? '• ' : ''}{tab.name}</span>
            <span className="subtitle">{dir ? `${dir}${tab.mirror.modified ? '' : ' · Saved'}` : 'Markwork'}</span>
        </div>
    );
}

function Menu({ items, onClose }: { items: { id: string; label: string; keys?: string }[]; onClose: () => void }) {
    const client = useClient();
    useEffect(() => {
        const close = (e: Event) => { if (!(e.target as Element).closest('.popover')) onClose(); };
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', key);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
    }, [onClose]);
    return (
        <div className="popover" role="menu">
            {items.map(item => (
                <button key={item.id} role="menuitem" onClick={() => { onClose(); if (item.id === 'open-folder') void client.openFolder(); else client.run(item.id); }}>
                    <span>{item.label}</span>{item.keys && <kbd>{label(item.keys)}</kbd>}
                </button>
            ))}
        </div>
    );
}

function HeaderBar() {
    const client = useClient();
    const s = useStore();
    const [menu, setMenu] = useState(false);
    const tab = s.tabs.find(t => t.id === s.active);
    const keyOf = (id: string) => COMMANDS.find(c => c.id === id)?.keys[0];
    const items = ['new', 'open-folder', 'kanban-new', 'table-new', 'inbox-new']
        .map(id => ({ id, command: COMMANDS.find(c => c.id === id) }))
        .filter(x => x.command?.label && (x.id === 'open-folder' || client.enabled(x.command)))
        .map(x => ({ id: x.id, label: x.command!.label!.replace(/…$/, ''), keys: keyOf(x.id) }));
    return (
        <header className="headerbar">
            <div className="start">
                <button className={`button flat${s.sidebar ? ' checked' : ''}`} title="Toggle Sidebar" aria-label="Toggle Sidebar" aria-pressed={s.sidebar} onClick={() => client.toggleSidebar()}>
                    <Icon name="sidebar-show" />
                </button>
                <div className="split">
                    <button className="button flat" title="New Document (Ctrl+N)" onClick={() => client.run('new')}><Icon name="document-new" /><span>New</span></button>
                    <button className="button flat narrow" aria-label="More ways to create" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(v => !v)}><Icon name="pan-down" /></button>
                    {menu && <Menu items={items} onClose={() => setMenu(false)} />}
                </div>
            </div>
            <Title />
            <div className="end">
                {tab && (
                    <button className="button flat" title="Board/List/Table View" disabled={!client.enabled(COMMANDS.find(c => c.id === 'kanban-view')!)} onClick={() => client.run('kanban-view')}>
                        <Icon name="text-x-generic" /><span>{tab.page === 'board' ? 'Board' : 'Text'}</span>
                    </button>
                )}
                <button className="button flat" title="Commands (Ctrl+Shift+P)" aria-label="Main Menu" onClick={() => client.openPalette()}><Icon name="open-menu" /></button>
            </div>
        </header>
    );
}

// The rail of icons that picks the panel beside it. Files is the only panel carried over so far.
function Rail() {
    const client = useClient();
    const { sidebar } = useStore();
    return (
        <nav className="rail" aria-label="Sidebar pages">
            <button className={`button flat${sidebar ? ' checked' : ''}`} title="Files" aria-label="Files" aria-pressed={sidebar} onClick={() => client.toggleSidebar()}>
                <Icon name="folder" />
            </button>
        </nav>
    );
}

// The counts at the foot of the editor: no bar, only the numbers, as the GTK window has them.
function StatusBar() {
    const s = useStore();
    const tab = s.tabs.find(t => t.id === s.active);
    const counts = useMemo(() => tab && tab.page !== 'board' ? { words: countWords(tab.mirror.text), characters: cpLength(tab.mirror.text) } : null, [tab, tab?.mirror.version]);
    if (!tab) return <footer className="statusbar">{!s.ready ? 'Starting…' : ''}</footer>;
    const board = tab.page === 'board' && tab.board;
    return (
        <footer className="statusbar">
            {board ? <span>{board.columns.length} lists · {board.columns.reduce((n, c) => n + c.cards.length, 0)} cards</span> : counts && (
                <>
                    <span>{counts.words} words</span>
                    <span>{counts.characters} characters</span>
                    <span>Line {s.line}, Column {s.column}</span>
                </>
            )}
        </footer>
    );
}

function Notification() {
    const client = useClient();
    const { toast, coreError } = useStore();
    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => client.dismissToast(), 6000);
        return () => clearTimeout(timer);
    }, [toast, client]);
    const text = coreError ?? toast?.text;
    if (!text) return null;
    return (
        <div className={`notification${coreError ? ' error' : ''}`} role="alert">
            <Icon name={coreError ? 'dialog-error' : 'dialog-information'} />
            <span className="message">{text}</span>
            {toast?.action && <button className="button suggested" onClick={() => client.runToast(toast.action!.token)}>{toast.action.label}</button>}
            {!coreError && <button className="button flat circular" aria-label="Dismiss" onClick={() => client.dismissToast()}><Icon name="window-close" /></button>}
        </div>
    );
}

export function App() {
    const client = useClient();
    const { sidebar } = useStore();

    // Every key of the command table, for the commands this window carries out. Captured before the editor sees it.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            for (const command of COMMANDS) {
                if (command.keys.some(k => matches(event, k)) && client.enabled(command)) {
                    event.preventDefault();
                    event.stopPropagation();
                    client.run(command.id);
                    return;
                }
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [client]);

    return (
        <div className="workbench">
            <HeaderBar />
            <div className="main">
                <Rail />
                {sidebar && <Explorer />}
                <div className="editor-group">
                    <Tabs />
                    <EditorArea />
                    <StatusBar />
                </div>
            </div>
            <Notification />
            <Palette />
        </div>
    );
}
