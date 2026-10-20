// The application's commands as data, shared by every frontend: an id, the label of the command palette, the default
// keys, when it applies, and what it does. The Electron window maps this table onto its keys and menus; another
// frontend maps it onto its own menus and keymap. A command acts only through CommandHost, so nothing here knows a widget.

import { _ } from '../i18n.js';

// The edits a command makes to the text of the active document; the frontend implements them on its editor.
export type TableOperation =
    | 'row-below' | 'row-above' | 'col-right' | 'col-left' | 'delete-row' | 'delete-col'
    | 'align-left' | 'align-center' | 'align-right' | 'format';

export interface EditCommands {
    undo(): void;
    redo(): void;
    wrap(marker: string): void;                          // **bold**, *italic*, ... around the selection
    link(): void;
    block(before: string, after: string): void;          // insert a block around the cursor or selection
    prefix(pattern: RegExp, text: string): void;         // toggle a line prefix (quote, list)
    heading(level: number): void;                        // 0 = plain paragraph
    table(operation: TableOperation): void;              // edit the table at the cursor
    zoomImage(): void;
}

// A view option the commands can change: the boolean settings and source mode.
export type ViewOption = 'sidebar' | 'chat' | 'dark' | 'autosave' | 'focus' | 'typewriter' | 'source';

// What a command may ask of the frontend: its editor's edits and its own windows. These commands are carried out by the
// frontend without asking the core (`runs: 'editor'`), so they stay instant over the app protocol.
export interface FrontendCommands {
    readonly edit: EditCommands;
    openFind(withReplace?: boolean): void;
    showSearch(withReplace?: boolean): void;   // the Search panel, with the selected text as the query
    setSource(on: boolean): void;              // source mode, in every editor
    showPalette(): void;
    showShortcuts(): void;
    showAbout(): void;
    quit(): void;
}

// What a command may ask of the application (`runs: 'core'`). AppSession implements it (AppSession.commands).
export interface CoreCommands {
    newDocument(): void;
    newBoardDocument(): void;
    newInboxDocument(): void;
    newTableDocument(): void;
    newCsvTable(): void;
    editFields(): void;
    sendChanges(): void;
    closeTab(): Promise<boolean>;
    switchTab(step: number): void;
    openHome(): void;
    readonly journal: { open(): unknown; capture(): unknown; summarize(): unknown };
    open(): Promise<void>;
    load(path: string): boolean;
    chooseFolder(): Promise<void>;
    save(): Promise<boolean>;
    saveAs(): Promise<boolean>;
    exportHtml(): Promise<void>;
    insertImage(): Promise<void>;
    toggleBoardView(on: boolean): void;
    setLayout(layout: string): void;
    setOption(key: Exclude<ViewOption, 'source'>, value: boolean): void;
    showPreferences(): void;
}

// Everything a command may ask; a test can implement it whole.
export type CommandHost = CoreCommands & FrontendCommands;

// When a command applies. 'text' commands need the text editor (not a board or Home), 'document' commands need a
// document (not Home), 'structured' commands need a board or a list.
export type CommandScope = 'always' | 'text' | 'document' | 'structured';

// How a command is invoked: a plain action, an on/off toggle that is not a setting, a setting of the same name in
// AppSettings (the frontend keeps its state), or a choice that carries a string.
export type CommandKind = 'action' | 'toggle' | 'setting' | 'choice';

// Where a command is carried out: in the core, or by the frontend alone (docs/design/protocol.md, section 8).
export type CommandRunner = 'core' | 'editor';

export interface Command {
    readonly id: string;
    readonly label?: string;                  // listed in the command palette; without one it is not
    readonly keys: readonly string[];         // default keys, "Ctrl+Shift+P" (Ctrl, Alt, Shift, then the key); the first is shown
    readonly kind: CommandKind;
    readonly scope: CommandScope;
    readonly runs: CommandRunner;
    // A toggle whose state is kept by the application (the view), not by the toggle itself.
    readonly ownsState?: boolean;
    run(host: CommandHost, arg?: boolean | string): void;
}

interface Spec {
    label?: string;
    keys?: string[];
    scope?: CommandScope;
    run?: (host: CoreCommands, arg?: boolean | string) => void;
    editor?: (host: FrontendCommands, arg?: boolean | string) => void;   // a command the frontend carries out alone
    toggle?: ViewOption | 'kanban-view';
    ownsState?: boolean;
    setting?: boolean;
    choice?: boolean;
}

const command = (id: string, spec: Spec): Command => ({
    id, label: spec.label, keys: spec.keys ?? [], scope: spec.scope ?? 'always',
    kind: spec.setting ? 'setting' : spec.choice ? 'choice' : spec.toggle ? 'toggle' : 'action',
    ownsState: spec.ownsState,
    runs: spec.editor ? 'editor' : 'core',
    run: spec.editor ?? spec.run ?? (() => {}),
});

const wrap = (id: string, label: string, keys: string[], marker: string) =>
    command(id, { label, keys, scope: 'text', editor: h => h.edit.wrap(marker) });
const table = (id: string, label: string, operation: TableOperation, keys: string[] = []) =>
    command(id, { label, keys, scope: 'text', editor: h => h.edit.table(operation) });
const option = (id: Exclude<ViewOption, 'dark' | 'source'>, label: string, keys: string[]) => command(id, { label, keys, setting: true });
const asBoolean = (arg: boolean | string | undefined): boolean => arg === true;

// In the order of the command palette when the search is empty; the commands without a label come last.
export const COMMANDS: readonly Command[] = [
    command('new', { label: _('New Document'), keys: ['Ctrl+n'], run: h => h.newDocument() }),
    command('open', { label: _('Open File…'), keys: ['Ctrl+o'], run: h => void h.open() }),
    command('open-folder', { label: _('Open Folder…'), keys: ['Ctrl+Shift+o'], run: h => void h.chooseFolder() }),
    command('save', { label: _('Save'), keys: ['Ctrl+s'], scope: 'document', run: h => void h.save() }),
    command('save-as', { label: _('Save As…'), keys: ['Ctrl+Shift+s'], scope: 'document', run: h => void h.saveAs() }),
    command('export-html', { label: _('Export HTML…'), keys: ['Ctrl+Shift+e'], scope: 'document', run: h => void h.exportHtml() }),
    command('home', { label: _('Home'), keys: ['Alt+Home'], run: h => h.openHome() }),
    command('journal', { label: _("Today's Journal"), keys: ['Ctrl+Alt+j'], run: h => void h.journal.open() }),
    command('journal-capture', { label: _('Add to Journal…'), keys: ['Ctrl+Shift+j'], run: h => void h.journal.capture() }),
    command('journal-summary', { label: _('Summarize Journal with Assistant'), run: h => void h.journal.summarize() }),
    command('close-tab', { label: _('Close Tab'), keys: ['Ctrl+w'], run: h => void h.closeTab() }),
    command('next-tab', { label: _('Next Tab'), keys: ['Ctrl+PageDown', 'Ctrl+Tab'], run: h => h.switchTab(1) }),
    command('prev-tab', { label: _('Previous Tab'), keys: ['Ctrl+PageUp', 'Ctrl+Shift+Tab'], run: h => h.switchTab(-1) }),
    command('find', { label: _('Find'), keys: ['Ctrl+f'], scope: 'text', editor: h => h.openFind() }),
    command('replace', { label: _('Find and Replace'), keys: ['Ctrl+h'], scope: 'text', editor: h => h.openFind(true) }),
    command('search-files', { label: _('Search in All Notes'), keys: ['Ctrl+Shift+f'], editor: h => h.showSearch() }),
    command('replace-files', { label: _('Replace in All Notes'), keys: ['Ctrl+Shift+h'], editor: h => h.showSearch(true) }),
    // Undo and redo are commands, not editor shortcuts, so they also work while a board is shown.
    command('undo', { label: _('Undo'), keys: ['Ctrl+z'], scope: 'document', editor: h => h.edit.undo() }),
    command('redo', { label: _('Redo'), keys: ['Ctrl+Shift+z', 'Ctrl+y'], scope: 'document', editor: h => h.edit.redo() }),
    wrap('bold', _('Bold'), ['Ctrl+b'], '**'),
    wrap('italic', _('Italic'), ['Ctrl+i'], '*'),
    wrap('strike', _('Strikethrough'), ['Alt+Shift+5', 'Ctrl+Shift+x'], '~~'),
    wrap('inline-code', _('Inline Code'), ['Ctrl+`'], '`'),
    wrap('highlight', _('Highlight'), ['Ctrl+Shift+h'], '=='),
    command('link', { label: _('Insert Link'), keys: ['Ctrl+k'], scope: 'text', editor: h => h.edit.link() }),
    command('image', { label: _('Insert Image…'), keys: ['Ctrl+Shift+i'], scope: 'text', run: h => void h.insertImage() }),
    command('zoom-image', { label: _('Zoom Image'), scope: 'text', editor: h => h.edit.zoomImage() }),
    command('codeblock', { label: _('Insert Code Block'), keys: ['Ctrl+Shift+k'], scope: 'text', editor: h => h.edit.block('```\n', '\n```') }),
    command('table', {
        label: _('Insert Table'), keys: ['Ctrl+t'], scope: 'text',
        editor: h => h.edit.block('| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n| ', ' |  |  |\n'),
    }),
    command('quote', { label: _('Quote'), keys: ['Ctrl+Shift+q'], scope: 'text', editor: h => h.edit.prefix(/^>\s?/, '> ') }),
    command('ulist', { label: _('Bulleted List'), keys: ['Ctrl+Shift+]'], scope: 'text', editor: h => h.edit.prefix(/^[-*+]\s+/, '- ') }),
    command('olist', { label: _('Numbered List'), keys: ['Ctrl+Shift+['], scope: 'text', editor: h => h.edit.prefix(/^\d+[.)]\s+/, '1. ') }),
    table('table-row-below', _('Table: Add Row Below'), 'row-below'),
    table('table-row-above', _('Table: Add Row Above'), 'row-above'),
    table('table-delete-row', _('Table: Delete Row'), 'delete-row'),
    table('table-col-right', _('Table: Add Column to the Right'), 'col-right'),
    table('table-col-left', _('Table: Add Column to the Left'), 'col-left'),
    table('table-delete-col', _('Table: Delete Column'), 'delete-col'),
    table('table-align-left', _('Table: Align Left'), 'align-left'),
    table('table-align-center', _('Table: Align Center'), 'align-center'),
    table('table-align-right', _('Table: Align Right'), 'align-right'),
    table('table-format', _('Table: Tidy Up'), 'format', ['Ctrl+Shift+t']),
    command('kanban-new', { label: _('New Kanban Board'), run: h => h.newBoardDocument() }),
    command('inbox-new', { label: _('New Inbox'), run: h => h.newInboxDocument() }),
    command('table-new', { label: _('New Table'), run: h => h.newTableDocument() }),
    command('csv-new', { label: _('New CSV Table'), run: h => h.newCsvTable() }),
    // The view decides whether the document can be shown as a board, and reports its state back.
    command('kanban-view', {
        label: _('Board/List/Table View'), keys: ['Ctrl+Shift+b'], scope: 'document', toggle: 'kanban-view', ownsState: true,
        run: (h, on) => h.toggleBoardView(asBoolean(on)),
    }),
    command('fields-edit', { label: _('Fields…'), scope: 'structured', run: h => h.editFields() }),
    command('send-changes', { label: _('Send Changes as Pull Request…'), run: h => h.sendChanges() }),
    option('sidebar', _('Sidebar'), ['Ctrl+\\', 'Ctrl+Shift+1']),
    option('chat', _('Assistant'), ['Ctrl+Shift+a']),
    command('source', { label: _('Source Mode'), keys: ['Ctrl+/'], toggle: 'source', editor: (h, on) => h.setSource(asBoolean(on)) }),
    option('focus', _('Focus Mode'), ['F8']),
    option('typewriter', _('Typewriter Mode'), ['F9']),
    command('dark', { label: _('Dark Mode'), keys: ['Ctrl+Shift+d'], toggle: 'dark', run: (h, on) => h.setOption('dark', asBoolean(on)) }),
    option('autosave', _('Autosave'), []),
    command('preferences', { label: _('Preferences'), keys: ['Ctrl+,'], run: h => h.showPreferences() }),
    command('shortcuts', { label: _('Keyboard Shortcuts'), keys: ['Ctrl+?'], editor: h => h.showShortcuts() }),
    command('about', { label: _('About Markwork'), editor: h => h.showAbout() }),
    command('quit', { label: _('Quit'), keys: ['Ctrl+q'], editor: h => h.quit() }),
    command('command-palette', { label: _('Command Palette'), keys: ['Ctrl+Shift+p'], editor: h => h.showPalette() }),
    // Without a label: not in the palette.
    ...[0, 1, 2, 3, 4, 5, 6].map(level => command(`heading${level}`, { keys: [`Ctrl+${level}`], scope: 'text', editor: h => h.edit.heading(level) })),
    // The layout menu of the header bar: the argument is the layout, '' for the text view.
    command('layout', { choice: true, scope: 'document', run: (h, layout) => h.setLayout(String(layout ?? '')) }),
    // A file of the Recent list: the argument is its path.
    command('open-recent', { choice: true, run: (h, path) => { if (path) h.load(String(path)); } }),
];

// Names shown in the command palette (Ctrl+Shift+P), in the order displayed when the search is empty.
export const COMMAND_LABELS: Record<string, string> = Object.fromEntries(COMMANDS.filter(c => c.label).map(c => [c.id, c.label!]));

export const commandIds = (scope: CommandScope): string[] => COMMANDS.filter(c => c.scope === scope).map(c => c.id);

// What the application is showing, as far as the commands care.
export interface CommandState {
    readonly page: boolean;         // a tab that is not a document (Home, an HTML file): no text, nothing to save
    readonly structured: boolean;   // a board, list, table, or another structured page
}

// Whether a command applies to the current view (the enabled hook the frontends map onto their menu items).
export function commandEnabled(command: Pick<Command, 'scope'>, state: CommandState): boolean {
    switch (command.scope) {
        case 'text': return !(state.structured || state.page);
        case 'document': return !state.page;
        case 'structured': return state.structured && !state.page;
        default: return true;
    }
}
