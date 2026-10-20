// The window, laid out as the GTK one is: a header bar, a rail of icons with its panel, the editor with its tabs, the
// counts at the foot, and the command palette over all of it.

import { useEffect, useMemo, useState } from 'react';
import { COMMANDS } from '../../src/app/commands.js';
import { countWords, cpLength } from '../../src/markdown/offsets.js';
import { EditorArea } from './EditorArea.js';
import { Explorer } from './Explorer.js';
import { Outline } from './Outline.js';
import { Search } from './Search.js';
import { Palette } from './Palette.js';
import { DialogLayer } from './Dialog.js';
import { AboutDialog, PreferencesDialog, ShortcutsDialog } from './Modals.js';
import { FieldsDialog } from './FieldsDialog.js';
import { ImageViewer } from './ImageViewer.js';
import { Chat, ChatReview } from './Chat.js';
import { Collab, SendChangesDialog, TokenDialog } from './Collab.js';
import { History, HistoryViewers } from './History.js';
import { LogViewer, RunLogs } from './LogViewer.js';
import { AgentAsks, PullRequestDialog } from './Harness.js';
import { Tabs } from './Tabs.js';
import { Icon, type IconName } from './Icons.js';
import { label, matches } from './keys.js';
import { useClient, useStore } from './useClient.js';
import { layoutOf } from './client.js';

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

// One line of a menu: a command (with the argument it runs with), a heading over what follows, or a separator.
interface MenuItem { id: string; label?: string; keys?: string; arg?: string; heading?: boolean }

function Menu({ items, onClose, align }: { items: MenuItem[]; onClose: () => void; align?: 'right' }) {
    const client = useClient();
    useEffect(() => {
        const close = (e: Event) => { if (!(e.target as Element).closest('.popover')) onClose(); };
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', key);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
    }, [onClose]);
    return (
        <div className={`popover${align === 'right' ? ' right' : ''}`} role="menu">
            {items.map((item, i) => item.id === '-' ? <hr key={i} /> : item.heading ? <div key={item.label} className="menu-heading">{item.label}</div> : (
                <button key={`${item.id}:${item.arg ?? ''}`} role="menuitem" title={item.arg} onClick={() => { onClose(); if (item.id === 'open-folder') void client.openFolder(); else client.run(item.id, item.arg); }}>
                    <span>{item.label}</span>{item.keys && <kbd>{label(item.keys)}</kbd>}
                </button>
            ))}
        </div>
    );
}

// The name on the layout button: the page shown, as the GTK header bar names it.
const LAYOUT_NAMES: Record<string, string> = { board: 'Board', list: 'List', inbox: 'List', table: 'Table', calendar: 'Calendar', timeline: 'Timeline', gallery: 'Gallery', chart: 'Chart' };
const layoutName = (layout: string, page: string): string => LAYOUT_NAMES[page] ?? (layout ? LAYOUT_NAMES[layout] ?? 'Text' : 'Text');

function HeaderBar() {
    const client = useClient();
    const s = useStore();
    const panels = layoutOf(s);
    const [menu, setMenu] = useState(false);
    const [main, setMain] = useState(false);
    const [layoutMenu, setLayoutMenu] = useState(false);
    const tab = s.tabs.find(t => t.id === s.active);
    const keyOf = (id: string) => COMMANDS.find(c => c.id === id)?.keys[0];
    // A command of the table as a menu line, left out when this window cannot carry it out.
    const entry = (id: string, text?: string): MenuItem[] => {
        const command = COMMANDS.find(c => c.id === id);
        if (!command?.label || (id !== 'open-folder' && !client.enabled(command))) return [];
        return [{ id, label: text ?? command.label.replace(/…$/, ''), keys: keyOf(id) }];
    };
    const named = (id: string): MenuItem[] => entry(id, COMMANDS.find(c => c.id === id)?.label ?? undefined);
    const recent: MenuItem[] = s.recent.length
        ? [{ id: '-' }, { id: 'recent', label: 'Recent', heading: true }, ...s.recent.map(path => ({ id: 'open-recent', label: path.split(/[\\/]/).pop(), arg: path }))]
        : [];
    const items: MenuItem[] = [
        ...['new', 'kanban-new', 'table-new', 'inbox-new', 'csv-new'].flatMap(id => entry(id)),
        { id: '-' }, ...named('open'), ...named('open-folder'), ...recent,
    ];
    // The layout menu: the text view and each layout the document can be shown as; the one shown is marked.
    const LAYOUT_MENU: [string, string][] = [['', 'Text'], ['board', 'Board'], ['list', 'List'], ['table', 'Table'], ['calendar', 'Calendar'], ['timeline', 'Timeline'], ['gallery', 'Gallery'], ['chart', 'Chart']];
    const layoutItems: MenuItem[] = [
        ...LAYOUT_MENU.map(([arg, name]) => ({ id: 'layout', arg, label: `${s.layout.layout === arg ? '✓ ' : ''}${name}` })),
        ...(s.layout.structured ? [{ id: '-' }, ...entry('fields-edit', 'Fields…')] : []),
    ];
    const mainItems: MenuItem[] = [
        ...named('command-palette'), ...named('find'), ...named('export-html'),
        { id: '-' }, ...named('home'), ...named('journal'), ...named('journal-capture'), ...named('journal-summary'),
        { id: '-' }, ...named('dark'), ...named('preferences'), ...named('shortcuts'), ...named('about'), ...named('quit'),
    ];
    return (
        <header className={`headerbar${panels.compact ? ' compact' : ''}`}>
            <div className="start">
                <button className={`button flat${panels.sidebar.shown ? ' checked' : ''}`} title="Toggle Sidebar" aria-label="Toggle Sidebar" aria-pressed={panels.sidebar.shown} onClick={() => client.toggleSidebar()}>
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
                {tab && s.layout.layout !== null && (
                    <div className="split">
                        <button className={`button flat${s.layout.structured ? ' checked' : ''}`} title="Board/List/Table View" aria-pressed={s.layout.structured}
                            disabled={!client.enabled(COMMANDS.find(c => c.id === 'kanban-view')!)} onClick={() => client.run('kanban-view')}>
                            <Icon name="text-x-generic" /><span>{layoutName(s.layout.layout, tab.page)}</span>
                        </button>
                        <button className="button flat narrow" aria-label="Layout" title="Layout" aria-haspopup="menu" aria-expanded={layoutMenu} onClick={() => setLayoutMenu(v => !v)}><Icon name="pan-down" /></button>
                        {layoutMenu && <Menu items={layoutItems} onClose={() => setLayoutMenu(false)} align="right" />}
                    </div>
                )}
                <button className={`button flat${panels.chat.shown ? ' checked' : ''}`} title="Assistant (Ctrl+Shift+A)" aria-label="Assistant" aria-pressed={panels.chat.shown}
                    onClick={() => client.run('chat')}><Icon name="chat-message-new" /></button>
                <div className="split">
                    <button className="button flat" title="Main Menu" aria-label="Main Menu" aria-haspopup="menu" aria-expanded={main} onClick={() => setMain(v => !v)}><Icon name="open-menu" /></button>
                    {main && <Menu items={mainItems} onClose={() => setMain(false)} align="right" />}
                </div>
            </div>
        </header>
    );
}

// The rail of icons that picks the panel beside it, in the order of the GTK window.
const PAGES: { page: string; label: string; icon: IconName }[] = [
    { page: 'files', label: 'Files', icon: 'folder' },
    { page: 'search', label: 'Search', icon: 'search' },
    { page: 'outline', label: 'Outline', icon: 'outline' },
    { page: 'history', label: 'History', icon: 'document-open-recent' },
    { page: 'collab', label: 'Pull requests', icon: 'pull-request' },
];

function Rail() {
    const client = useClient();
    const state = useStore();
    const sidebar = layoutOf(state).sidebar.shown;
    const current = state.settings['sidebar-page'] ?? 'files';
    return (
        <nav className="rail" aria-label="Sidebar pages">
            {PAGES.map(({ page, label, icon }) => (
                <button key={page} className={`button flat${sidebar && current === page ? ' checked' : ''}`} title={label} aria-label={label}
                    aria-pressed={sidebar && current === page} onClick={() => client.showSidebarPage(page)}>
                    <Icon name={icon} />
                </button>
            ))}
        </nav>
    );
}

// The counts at the foot of the editor: no bar, only the numbers, as the GTK window has them.
function StatusBar() {
    const s = useStore();
    const tab = s.tabs.find(t => t.id === s.active);
    // The text's counts are the window's own (it has the text); the others come from the core (view.status).
    const { counts, visible } = s.status;
    const text = useMemo(() => tab && counts.kind === 'text' ? { words: countWords(tab.mirror.text), characters: cpLength(tab.mirror.text) } : null,
        [tab, tab?.mirror.version, counts.kind]);
    if (!tab) return <footer className="statusbar">{!s.ready ? 'Starting…' : ''}</footer>;
    if (!visible) return <footer className="statusbar" />;
    return (
        <footer className="statusbar">
            {counts.kind === 'board' && <span>{counts.lists} lists · {counts.cards} cards</span>}
            {counts.kind === 'inbox' && <span>{counts.items} items</span>}
            {counts.kind === 'csv' && <span>{counts.rows} rows · {counts.columns} columns</span>}
            {text && (
                <>
                    <span>{text.words} words</span>
                    <span>{text.characters} characters</span>
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
    const state = useStore();
    const page = state.settings['sidebar-page'];
    const panels = layoutOf(state);

    // The window's width decides which side panels float (client.ts layoutOf).
    useEffect(() => {
        const resize = () => client.setWidth(window.innerWidth);
        resize();
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, [client]);

    // Escape closes a floating panel, unless something inside took the key (a popover, a suggestion list).
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !event.defaultPrevented && !client.getState().dialog) client.closeFloating();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [client]);

    // Every key of the command table, for the commands this window carries out. Captured before the editor sees it.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            // A dialog has the keys to itself.
            if (client.getState().dialog) return;
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
            <div className={`main${panels.sidebar.floats ? ' float-sidebar' : ''}${panels.chat.floats ? ' float-chat' : ''}`}>
                <Rail />
                {panels.sidebar.shown && (page === 'outline' ? <Outline /> : page === 'search' ? <Search /> : page === 'history' ? <History /> : page === 'collab' ? <Collab /> : <Explorer />)}
                <div className="editor-group">
                    <Tabs />
                    <EditorArea />
                    <StatusBar />
                </div>
                {panels.chat.shown && <Chat />}
                {/* A floating panel closes when the content beside it is clicked, as a collapsed GTK split view does. */}
                {((panels.sidebar.floats && panels.sidebar.shown) || (panels.chat.floats && panels.chat.shown)) &&
                    <div className="float-backdrop" aria-hidden="true" onMouseDown={() => client.closeFloating()} />}
            </div>
            <Notification />
            <Palette />
            <ImageViewer />
            <PreferencesDialog />
            <ShortcutsDialog />
            <AboutDialog />
            <FieldsDialog />
            <ChatReview />
            <LogViewer />
            <RunLogs />
            <AgentAsks />
            <PullRequestDialog />
            <HistoryViewers />
            <TokenDialog />
            <SendChangesDialog />
            <DialogLayer />
        </div>
    );
}
