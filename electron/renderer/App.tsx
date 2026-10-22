// The window: the sidebar (or its rail), the header of the document, the editor with its tabs, the counts at the foot,
// the Assistant beside them, and the command palette over all of it. The look is shadcn/ui's (docs/design/shadcn/).

import { useEffect, useMemo } from 'react';
import { COMMANDS } from '../../src/app/commands.js';
import { countWords, cpLength } from '../../src/markdown/offsets.js';
import { EditorArea } from './components/EditorArea.js';
import { FilesView } from './components/FilesView.js';
import { Search } from './components/Search.js';
import { Palette } from './components/Palette.js';
import { DialogLayer } from './components/Dialog.js';
import { AboutDialog, PreferencesDialog, ShortcutsDialog } from './components/Modals.js';
import { FieldsDialog } from './components/FieldsDialog.js';
import { ImageViewer } from './components/ImageViewer.js';
import { Chat, ChatReview } from './components/Chat.js';
import { Collab, SendChangesDialog, TokenDialog } from './components/Collab.js';
import { History, HistoryViewers } from './components/History.js';
import { LogViewer, RunLogs } from './components/LogViewer.js';
import { AgentAsks, PullRequestDialog } from './components/Harness.js';
import { Icon, type IconName } from './components/Icons.js';
import { label, matches } from './lib/keys.js';
import { ActivityBar, SideShell } from './components/Sidebar.js';
import { MenuBar } from './components/MenuBar.js';
import { Button } from './ui/button.js';
import {
    DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { cn } from './lib/utils.js';
import { useClient, useStore } from './lib/useClient.js';
import { layoutOf } from './lib/client.js';
import { EditingMode, STRUCTURED_PAGES } from './components/EditingMode.js';
import { currentPane, isSolo } from './lib/panes.js';

// The title of the header: where the document is, as a breadcrumb, and its name, which is the Document Menu button
// (Save, Save As, Autosave, Export, the recent files). Home and an empty window have a plain title.
function Title({ items }: { items: MenuItem[] }) {
    const s = useStore();
    const tab = s.tabs.find(t => t.id === s.active);
    if (!tab) return <nav className="title" aria-label="Breadcrumb"><span className="name">Markwork</span></nav>;
    // Where the document is, as the core words it (~ for the home folder); a page (Home, an HTML file) is not saved.
    const place = tab.place ?? (tab.file ? tab.file.replace(/[\\/][^\\/]*$/, '') : null);
    const crumbs = place ? place.split(/[\\/]/).filter(Boolean).slice(-2) : [];
    const separator = <Icon name="pan-end" size={14} />;
    return (
        <nav className="title" aria-label="Breadcrumb" title={place ?? undefined}>
            {crumbs.map((crumb, i) => <span key={i} className="contents">{<span className="crumb">{crumb}</span>}{separator}</span>)}
            {tab.page === 'home' || tab.page === 'programs' ? <span className="name">{tab.name}</span> : (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button className="title-button" title="Document Menu" aria-label="Document Menu">
                            <span className="name">{tab.name}</span><Icon name="pan-down" size={14} />
                        </button>
                    </DropdownMenuTrigger>
                    <MenuContent items={items} align="start" />
                </DropdownMenu>
            )}
        </nav>
    );
}

// Whether the document has changes not saved yet: a badge with words, not only a dot.
function SaveState() {
    const s = useStore();
    const tab = s.tabs.find(t => t.id === s.active);
    if (!tab || tab.page === 'home' || tab.page === 'programs' || tab.page === 'html') return null;
    if (tab.mirror.modified) return <span className="state"><span className="dot" aria-hidden="true" /><span className="word">Unsaved</span></span>;
    if (!tab.file) return null;
    return <span className="state"><Icon name="emblem-ok" size={12} /><span className="word">Saved</span></span>;
}

// One line of a menu: a command (with the argument it runs with), a heading over what follows, or a separator. A line
// with an icon can be the one chosen (`checked`, the layout shown); a `check` line is an on/off setting with its box.
interface MenuItem { id: string; label?: string; keys?: string; arg?: string; heading?: boolean; icon?: IconName; checked?: boolean; check?: boolean; enabled?: boolean }

// The lines of a menu of the header, in shadcn's DropdownMenu. The focus is not given back to the menu's button when it
// closes, since the command chosen may have moved it (to the editor, to a dialog).
function MenuContent({ items, align = 'end', className }: { items: MenuItem[]; align?: 'start' | 'center' | 'end'; className?: string }) {
    const client = useClient();
    const run = (item: { id: string; arg?: string }) => { if (item.id === 'open-folder') void client.openFolder(); else client.run(item.id, item.arg); };
    return (
        <DropdownMenuContent align={align} className={cn('min-w-56', className)} onCloseAutoFocus={e => e.preventDefault()}>
            {items.map((item, i) => item.id === '-' ? <DropdownMenuSeparator key={i} />
                : item.heading ? <DropdownMenuLabel key={item.label}>{item.label}</DropdownMenuLabel>
                : item.check !== undefined && item.check !== false ? (
                    <DropdownMenuCheckboxItem key={`${item.id}:${item.arg ?? ''}`} checked={item.checked === true} disabled={item.enabled === false}
                        onSelect={() => run(item)}>
                        {item.label}{item.keys && <DropdownMenuShortcut>{label(item.keys)}</DropdownMenuShortcut>}
                    </DropdownMenuCheckboxItem>
                ) : (
                    <DropdownMenuItem key={`${item.id}:${item.arg ?? ''}`} title={item.arg} className={item.checked ? 'checked' : undefined} disabled={item.enabled === false}
                        onSelect={() => run(item)}>
                        {item.icon && <Icon name={item.icon} />}<span className="flex-1">{item.label}</span>{item.keys && <DropdownMenuShortcut>{label(item.keys)}</DropdownMenuShortcut>}
                    </DropdownMenuItem>
                ))}
        </DropdownMenuContent>
    );
}

// The layouts the layout button offers, with the name and the icon it shows for each; '' is the text view.
const LAYOUTS: { layout: string; name: string; icon: IconName }[] = [
    { layout: 'table', name: 'Table', icon: 'x-office-spreadsheet' },
    { layout: 'board', name: 'Board', icon: 'view-dual' },
    { layout: 'list', name: 'List', icon: 'view-list' },
    { layout: 'calendar', name: 'Calendar', icon: 'x-office-calendar' },
    { layout: 'timeline', name: 'Timeline', icon: 'view-continuous' },
    { layout: 'gallery', name: 'Gallery', icon: 'view-grid' },
    { layout: 'chart', name: 'Chart', icon: 'view-sort-descending' },
    { layout: '', name: 'Text', icon: 'text-x-generic' },
];
// What the layout button shows: the page on screen (an inbox is drawn as a list).
const PAGE_LAYOUT: Record<string, string> = { board: 'board', list: 'list', inbox: 'list', table: 'table', calendar: 'calendar', timeline: 'timeline', gallery: 'gallery', chart: 'chart' };
const shownLayout = (layout: string, page: string, structured: boolean) => LAYOUTS.find(l => l.layout === (PAGE_LAYOUT[page] ?? (structured ? layout : ''))) ?? LAYOUTS[LAYOUTS.length - 1];

function HeaderBar() {
    const client = useClient();
    const s = useStore();
    const panels = layoutOf(s);
    const tab = s.tabs.find(t => t.id === s.active);
    const keyOf = (id: string) => COMMANDS.find(c => c.id === id)?.keys[0];
    // A command of the table as a menu line, left out when this window cannot carry it out.
    const entry = (id: string, text?: string, extra: Partial<MenuItem> = {}): MenuItem[] => {
        const command = COMMANDS.find(c => c.id === id);
        if (!command?.label || (id !== 'open-folder' && !client.enabled(command))) return [];
        return [{ id, label: text ?? command.label.replace(/…$/, ''), keys: keyOf(id), ...extra }];
    };
    const named = (id: string, extra: Partial<MenuItem> = {}): MenuItem[] => entry(id, COMMANDS.find(c => c.id === id)?.label ?? undefined, extra);
    const recent: MenuItem[] = s.recent.length
        ? [{ id: '-' }, { id: 'recent', label: 'Recent', heading: true }, ...s.recent.map(path => ({ id: 'open-recent', label: path.split(/[\\/]/).pop(), arg: path }))]
        : [];
    const items: MenuItem[] = [
        ...['new', 'kanban-new', 'table-new', 'inbox-new', 'csv-new'].flatMap(id => entry(id)),
        { id: '-' }, ...named('open'), ...named('open-folder'), ...recent,
    ];
    // The document's menu: what is done to the document itself.
    const documentItems: MenuItem[] = [
        ...named('save'), ...named('save-as'), ...named('autosave', { check: true, checked: s.settings.autosave === true }),
        { id: '-' }, ...named('export-html'), ...recent,
    ];
    // The layout menu: a row for each layout with its icon, the one shown marked, then the view modes as checks.
    const shown = tab ? shownLayout(s.layout.layout ?? '', tab.page, s.layout.structured) : LAYOUTS[LAYOUTS.length - 1];
    const layoutItems: MenuItem[] = [
        ...LAYOUTS.flatMap(({ layout, name, icon }): MenuItem[] => [...layout === '' ? [{ id: '-' }] : [], { id: 'layout', arg: layout, label: name, icon, checked: shown.layout === layout }]),
        { id: '-' },
        ...named('visual', { check: true, checked: s.settings.visual !== false }),
        ...named('source', { check: true, checked: s.source }),
        ...named('focus', { check: true, checked: s.settings.focus === true }),
        ...named('typewriter', { check: true, checked: s.settings.typewriter === true }),
    ];
    return (
        <header className={`headerbar${panels.compact ? ' compact' : ''}`}>
            <Button variant="ghost" size="icon-sm" title="Toggle Sidebar" aria-label="Toggle Sidebar" aria-pressed={panels.sidebar.shown} onClick={() => client.toggleSidebar()}>
                <Icon name="sidebar-show" />
            </Button>
            <span className="vsep" aria-hidden="true" />
            <Title items={documentItems} />
            <SaveState />
            <span className="spacer" />
            {tab && isSolo(s.panes) && !s.pullShown && !s.reviewShown && ['text', 'csv', ...STRUCTURED_PAGES].includes(tab.page) && <EditingMode tab={tab} pane={currentPane(s.panes)} />}
            {tab && s.layout.layout !== null && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" aria-label="Layout" title="View">
                            <Icon name={shown.icon} /><span className="label-text">{shown.name}</span><Icon name="pan-down" className="text-muted-foreground" />
                        </Button>
                    </DropdownMenuTrigger>
                    <MenuContent items={layoutItems} className="layout-menu min-w-52" />
                </DropdownMenu>
            )}
            <Button variant="ghost" size="icon-sm" className="header-split" title={`Split Editor Right (${label(keyOf('split-right') ?? '')})`} aria-label="Split Editor Right" onClick={() => client.run('split-right')}>
                <Icon name="split-right" />
            </Button>
            <div className="split-button">
                <Button size="sm" title="New Document (Ctrl+N)" onClick={() => client.run('new')}><Icon name="document-new" /><span className="label-text">New</span></Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="sm" aria-label="More ways to create"><Icon name="pan-down" /></Button>
                    </DropdownMenuTrigger>
                    <MenuContent items={items} />
                </DropdownMenu>
            </div>
            <span className="vsep" aria-hidden="true" />
            <Button variant="ghost" size="icon-sm" title="Assistant (Ctrl+Shift+A)" aria-label="Assistant" aria-pressed={panels.chat.shown} onClick={() => client.run('chat')}>
                <Icon name="chat-message-new" />
            </Button>
        </header>
    );
}

// The counts at the foot of the editor: no bar, only the numbers.
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
            {counts.kind === 'inbox' && <span>{counts.items} {counts.items === 1 ? 'note' : 'notes'}</span>}
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
            <div className="titlebar"><MenuBar /></div>
            <div className={`shell${panels.sidebar.floats ? ' float-sidebar' : ''}`}>
                <ActivityBar />
                {panels.sidebar.shown && (
                    <SideShell>
                        {page === 'search' ? <Search /> : page === 'history' ? <History /> : page === 'collab' ? <Collab /> : <FilesView />}
                    </SideShell>
                )}
                <div className="main">
                    <HeaderBar />
                    <div className={`content${panels.chat.floats ? ' float-chat' : ''}`}>
                        <div className="editor-group">
                            <EditorArea />
                            <StatusBar />
                        </div>
                        {panels.chat.shown && <Chat />}
                        {/* A floating panel closes when the content beside it is clicked; the header stays in reach. */}
                        {((panels.sidebar.floats && panels.sidebar.shown) || (panels.chat.floats && panels.chat.shown)) &&
                            <div className="float-backdrop" aria-hidden="true" onMouseDown={() => client.closeFloating()} />}
                    </div>
                </div>
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
