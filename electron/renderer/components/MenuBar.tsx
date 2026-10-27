// The menu bar at the top of the window, as VS Code's: File, Edit, Insert, View, Go, Help. Each line is a command of the
// table (src/app/commands.ts), with its keys; a command this window cannot carry out now is dimmed.

import { COMMANDS } from '../../../src/app/commands';
import { label } from '../lib/keys';
import { useClient, useStore } from '../lib/useClient';
import { layoutOf } from '../lib/client';
import {
    Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut, MenubarSub, MenubarSubContent, MenubarSubTrigger, MenubarTrigger,
} from '../ui/menubar';

// A line of a menu: a command (with its argument, and its state when it is a check), a separator, or a submenu.
type Line = { id: string; text?: string; arg?: string; check?: boolean } | { sub: string; lines: Line[] } | '-';

const LAYOUTS = [['table', 'Table'], ['board', 'Board'], ['list', 'List'], ['calendar', 'Calendar'], ['timeline', 'Timeline'], ['gallery', 'Gallery'], ['chart', 'Chart'], ['', 'Text']] as const;

export function MenuBar() {
    const client = useClient();
    const s = useStore();
    const panels = layoutOf(s);
    const checked: Record<string, boolean> = {
        sidebar: panels.sidebar.shown, chat: panels.chat.shown, visual: s.settings.visual !== false, source: s.source, focus: s.settings.focus === true,
        typewriter: s.settings.typewriter === true, dark: s.settings['color-scheme'] === 'dark', autosave: s.settings.autosave === true, 'kanban-view': s.layout.structured,
    };
    const recent: Line[] = s.recent.map(path => ({ id: 'open-recent', text: path.split(/[\\/]/).pop(), arg: path }));
    const layouts: Line[] = s.layout.layout === null ? [] : LAYOUTS.map(([layout, name]) => ({ id: 'layout', text: name, arg: layout }));
    const shownLayout = s.layout.layout ?? '';

    const menus: [string, Line[]][] = [
        ['File', [
            { id: 'new' }, { id: 'kanban-new' }, { id: 'table-new' }, { id: 'inbox-new' }, { id: 'csv-new' }, '-',
            { id: 'open' }, { id: 'open-folder' }, ...(recent.length ? [{ sub: 'Open Recent', lines: recent }] : []), '-',
            { id: 'save' }, { id: 'save-as' }, { id: 'autosave', check: true }, '-',
            { id: 'export-html' }, { id: 'send-changes' }, '-',
            { id: 'preferences' }, '-', { id: 'close-tab' }, { id: 'close-all-tabs' }, { id: 'quit' },
        ]],
        ['Edit', [
            { id: 'undo' }, { id: 'redo' }, '-',
            { id: 'find' }, { id: 'replace' }, { id: 'search-files' }, { id: 'replace-files' }, '-',
            { sub: 'Format', lines: [
                { id: 'bold' }, { id: 'italic' }, { id: 'strike' }, { id: 'inline-code' }, { id: 'highlight' }, '-',
                { id: 'paragraph' }, { id: 'quote' }, { id: 'ulist' }, { id: 'olist' }, { id: 'tasklist' }, '-', { id: 'block-up' }, { id: 'block-down' },
            ] },
            { sub: 'Table', lines: [
                { id: 'table-row-above' }, { id: 'table-row-below' }, { id: 'table-delete-row' }, '-', { id: 'table-col-left' }, { id: 'table-col-right' }, { id: 'table-delete-col' }, '-',
                { id: 'table-align-left' }, { id: 'table-align-center' }, { id: 'table-align-right' }, '-', { id: 'table-format' },
            ] },
            { id: 'fields-edit' },
        ]],
        ['Insert', [{ id: 'link' }, { id: 'image' }, '-', { id: 'codeblock' }, { id: 'table' }, { id: 'divider' }]],
        ['View', [
            { id: 'command-palette' }, '-',
            { id: 'sidebar', check: true }, { id: 'chat', check: true }, '-',
            { id: 'split-right' }, { id: 'split-down' }, { id: 'move-to-next-pane' }, { id: 'close-pane' }, '-',
            ...(layouts.length ? [{ sub: 'Layout', lines: layouts }, '-' as const] : []),
            { id: 'kanban-view', check: true }, { id: 'visual', check: true }, { id: 'source', check: true }, { id: 'focus', check: true }, { id: 'typewriter', check: true }, '-',
            { id: 'dark', check: true },
        ]],
        ['Go', [
            { id: 'home' }, { id: 'programs' }, '-', { id: 'journal' }, { id: 'journal-capture' }, { id: 'journal-summary' }, '-', { id: 'next-tab' }, { id: 'prev-tab' },
        ]],
        ['Help', [{ id: 'shortcuts' }, { id: 'report-problem' }, '-', { id: 'about' }]],
    ];

    const run = (id: string, arg?: string) => { if (id === 'open-folder') void client.openFolder(); else client.run(id, arg); };
    const render = (line: Line, i: number): React.ReactNode => {
        if (line === '-') return <MenubarSeparator key={i} />;
        if ('sub' in line) {
            return (
                <MenubarSub key={line.sub}>
                    <MenubarSubTrigger>{line.sub}</MenubarSubTrigger>
                    <MenubarSubContent>{line.lines.map(render)}</MenubarSubContent>
                </MenubarSub>
            );
        }
        const command = COMMANDS.find(c => c.id === line.id);
        if (!command) return null;
        const name = line.text ?? command.label ?? command.id;
        const disabled = line.id !== 'open-folder' && !client.enabled(command);
        const keys = command.keys[0];
        const shortcut = keys && !line.arg && <MenubarShortcut>{label(keys)}</MenubarShortcut>;
        if (line.check) {
            return <MenubarCheckboxItem key={line.id} checked={checked[line.id] === true} disabled={disabled} onSelect={() => run(line.id)}>{name}{shortcut}</MenubarCheckboxItem>;
        }
        // The layout shown is marked like a check, so is the one chosen of a group.
        if (line.id === 'layout') {
            return <MenubarCheckboxItem key={line.arg} checked={line.arg === shownLayout} disabled={disabled} onSelect={() => run(line.id, line.arg)}>{name}</MenubarCheckboxItem>;
        }
        return <MenubarItem key={`${line.id}:${line.arg ?? ''}`} title={line.arg} disabled={disabled} onSelect={() => run(line.id, line.arg)}>{name}{shortcut}</MenubarItem>;
    };

    return (
        <Menubar className="menubar" aria-label="Menu">
            {menus.map(([name, lines]) => (
                <MenubarMenu key={name}>
                    <MenubarTrigger>{name}</MenubarTrigger>
                    <MenubarContent onCloseAutoFocus={e => e.preventDefault()}>{lines.map(render)}</MenubarContent>
                </MenubarMenu>
            ))}
        </Menubar>
    );
}
