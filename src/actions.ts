// All application actions and their shortcuts, in one place.
//
// Actions (Gio.SimpleAction) are triggered by header bar buttons, menu items, or shortcuts.
// "Toggle" actions have an on/off state that automatically shows as a checkmark in menus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { wrapSelection, insertLink, insertBlock, togglePrefix, setHeading } from './editor/editing.js';
import { showAbout } from './ui/dialogs.js';
import { PreferencesDialog } from './ui/preferences.js';
import type { ProjectsAccess } from './ui/projectsettings.js';
import { CommandPalette } from './ui/palette.js';
import { showShortcuts } from './ui/shortcuts.js';
import type Adw from 'gi://Adw?version=1';
import type { TableCommand } from './editor/tableedit.js';
import type { Mode, MarkdownView } from './editor/view.js';
import type { FindBar } from './ui/findbar.js';
import type { AppSettings } from './settings.js';
import type { Awaitable } from './gtkutil.js';
import type { JournalController } from './window/journal.js';
import { gsettingsOf } from './platform/gjs/settings.js';

// View options that can be changed from the menu.
export type Option = 'sidebar' | 'chat' | 'dark' | 'autosave' | Mode;

// What the actions need from the main window. Kept narrow so this module does not depend on window.ts,
// which registers the actions by passing itself.
export interface ActionHost {
    readonly win: Adw.ApplicationWindow;
    readonly settings: AppSettings;
    readonly harness: ProjectsAccess;
    readonly findBar: FindBar;
    showSearch(withReplace?: boolean): void;
    readonly editor: MarkdownView;
    readonly dark: boolean;
    newDocument(): void;
    newBoardDocument(): void;
    newInboxDocument(): void;
    newTableDocument(): void;
    editFields(): void;
    sendChanges(): void;
    closeTab(): Awaitable<boolean>;
    switchTab(step: number): void;
    openHome(): void;
    readonly journal: Pick<JournalController, 'open' | 'capture' | 'summarize'>;
    open(): Promise<void>;
    load(path: string): boolean;
    chooseFolder(): Promise<void>;
    save(): Awaitable<boolean>;
    saveAs(): Promise<boolean>;
    exportHtml(): Promise<void>;
    insertImage(): Promise<void>;
    toggleBoardView(on: boolean): void;
    setLayout(layout: string): void;
    setOption(key: Option, value: boolean): void;
    syncActionsEnabled(): void;
}

const TABLE_TEMPLATE: [before: string, after: string] = ['| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n| ', ' |  |  |\n'];

// Actions that edit the document text. While the kanban board is shown, its text is hidden, so
// these actions are disabled (menu dims, shortcuts and palette do not trigger them).
export const TEXT_ACTIONS = new Set([
    'find', 'replace', 'bold', 'italic', 'strike', 'inline-code', 'highlight', 'link', 'image', 'zoom-image', 'codeblock', 'table',
    'quote', 'ulist', 'olist', 'heading0', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
    'table-row-below', 'table-row-above', 'table-delete-row', 'table-col-right', 'table-col-left', 'table-delete-col',
    'table-align-left', 'table-align-center', 'table-align-right', 'table-format',
]);

export function registerActions(app: Adw.Application, w: ActionHost): void {
    const action = (name: string, accels: string[] | null, run: () => void) => {
        const a = new Gio.SimpleAction({ name });
        a.connect('activate', run);
        app.add_action(a);
        if (accels) app.set_accels_for_action(`app.${name}`, accels);
    };
    // Toggles that are not GSettings keys: source mode and dark mode.
    const toggle = (name: Option, accels: string[], initial: boolean) => {
        const a = Gio.SimpleAction.new_stateful(name, null, GLib.Variant.new_boolean(initial));
        a.connect('change-state', (act, value) => {
            if (!value) return;
            act.set_state(value);
            w.setOption(name, value.get_boolean());
        });
        app.add_action(a);
        if (accels) app.set_accels_for_action(`app.${name}`, accels);
    };

    // File
    action('new', ['<Control>n'], () => w.newDocument());
    action('close-tab', ['<Control>w'], () => w.closeTab());
    action('home', ['<Alt>Home'], () => w.openHome());
    action('journal', ['<Control><Alt>j'], () => void w.journal.open());
    action('journal-capture', ['<Control><Shift>j'], () => w.journal.capture());
    action('journal-summary', null, () => void w.journal.summarize());
    action('next-tab', ['<Control>Page_Down', '<Control>Tab'], () => w.switchTab(1));
    action('prev-tab', ['<Control>Page_Up', '<Control><Shift>Tab', '<Control><Shift>ISO_Left_Tab'], () => w.switchTab(-1));
    action('open', ['<Control>o'], () => w.open());
    action('open-folder', ['<Control><Shift>o'], () => w.chooseFolder());
    // A file of the Recent list in the New menu and the document's menu; the target is its path.
    const openRecent = new Gio.SimpleAction({ name: 'open-recent', parameter_type: GLib.VariantType.new('s') });
    openRecent.connect('activate', (_a, path) => { if (path) w.load(path.get_string()[0]); });
    app.add_action(openRecent);
    action('save', ['<Control>s'], () => w.save());

    // Undo/redo through actions, so they also work while the kanban board is shown (the text editor is
    // not focused). In text view the result is the same as the built-in GtkSourceView shortcuts.
    action('undo', ['<Control>z'], () => w.editor.buffer.undo());
    action('redo', ['<Control><Shift>z', '<Control>y'], () => w.editor.buffer.redo());

    // Kanban board
    action('kanban-new', null, () => w.newBoardDocument());
    action('inbox-new', null, () => w.newInboxDocument());
    action('table-new', null, () => w.newTableDocument());
    action('fields-edit', null, () => w.editFields());
    action('send-changes', null, () => w.sendChanges());
    const view = Gio.SimpleAction.new_stateful('kanban-view', null, GLib.Variant.new_boolean(false));
    view.connect('change-state', (_a, value) => { if (value) w.toggleBoardView(value.get_boolean()); });
    app.add_action(view);
    app.set_accels_for_action('app.kanban-view', ['<Control><Shift>b']);
    // The layout menu in the header bar: the state is the layout the document is shown in ('' for the text view).
    const layout = Gio.SimpleAction.new_stateful('layout', GLib.VariantType.new('s'), GLib.Variant.new_string(''));
    layout.connect('change-state', (_a, value) => { if (value) w.setLayout(value.get_string()[0]); });
    app.add_action(layout);
    action('save-as', ['<Control><Shift>s'], () => w.saveAs());
    action('export-html', ['<Control><Shift>e'], () => w.exportHtml());
    action('quit', ['<Control>q'], () => w.win.close());
    action('preferences', ['<Control>comma'], () => new PreferencesDialog(w.settings, w.harness).present(w.win));
    action('command-palette', ['<Control><Shift>p'], () => new CommandPalette(app).present(w.win));
    action('shortcuts', ['<Control>question'], () => showShortcuts(app, w.win));
    action('about', null, () => showAbout(w.win));
    action('find', ['<Control>f'], () => w.findBar.open());
    action('replace', ['<Control>h'], () => w.findBar.open(true));
    action('search-files', ['<Control><Shift>f'], () => w.showSearch());
    action('replace-files', ['<Control><Shift>h'], () => w.showSearch(true));

    // Inline formatting
    action('bold', ['<Control>b'], () => wrapSelection(w.editor.buffer, '**'));
    action('italic', ['<Control>i'], () => wrapSelection(w.editor.buffer, '*'));
    action('strike', ['<Alt><Shift>5', '<Control><Shift>x'], () => wrapSelection(w.editor.buffer, '~~'));
    action('inline-code', ['<Control>grave'], () => wrapSelection(w.editor.buffer, '`'));
    action('highlight', ['<Control><Shift>h'], () => wrapSelection(w.editor.buffer, '=='));
    action('link', ['<Control>k'], () => insertLink(w.editor.buffer));
    action('image', ['<Control><Shift>i'], () => w.insertImage());
    action('zoom-image', null, () => w.editor.zoomImage());

    // Blocks
    action('codeblock', ['<Control><Shift>k'], () => insertBlock(w.editor.buffer, '```\n', '\n```'));
    action('table', ['<Control>t'], () => insertBlock(w.editor.buffer, ...TABLE_TEMPLATE));

    // Edit the table at the cursor position
    const tableActions: [string, TableCommand, string[] | null][] = [
        ['table-row-below', 'row-below', null], ['table-row-above', 'row-above', null], ['table-delete-row', 'delete-row', null],
        ['table-col-right', 'col-right', null], ['table-col-left', 'col-left', null], ['table-delete-col', 'delete-col', null],
        ['table-align-left', 'align-left', null], ['table-align-center', 'align-center', null], ['table-align-right', 'align-right', null],
        ['table-format', 'format', ['<Control><Shift>t']],
    ];
    for (const [name, command, accels] of tableActions) action(name, accels, () => w.editor.tableCommand(command));
    action('quote', ['<Control><Shift>q'], () => togglePrefix(w.editor.buffer, /^>\s?/, '> '));
    action('ulist', ['<Control><Shift>bracketright'], () => togglePrefix(w.editor.buffer, /^[-*+]\s+/, '- '));
    action('olist', ['<Control><Shift>bracketleft'], () => togglePrefix(w.editor.buffer, /^\d+[.)]\s+/, '1. '));
    for (let n = 0; n <= 6; n++)
        action(`heading${n}`, [`<Control>${n}`], () => setHeading(w.editor.buffer, n));

    // View
    const s = w.settings;
    // Toggle bound to a GSettings key: the action's state follows that key.
    const setting = (key: string, accels: string[]) => {
        app.add_action(gsettingsOf(s).create_action(key));
        if (accels.length) app.set_accels_for_action(`app.${key}`, accels);
    };
    setting('sidebar', ['<Control>backslash', '<Control><Shift>1']);
    setting('chat', ['<Control><Shift>a']);
    setting('focus', ['F8']);
    setting('typewriter', ['F9']);
    setting('autosave', []);
    toggle('source', ['<Control>slash'], false);
    toggle('dark', ['<Control><Shift>d'], w.dark);
    w.syncActionsEnabled();
}
