// The command registry and the application session.

import { AppSettings } from '../../src/base/settings.js';
import type { SettingValue } from '../../src/platform/index.js';
import { COMMANDS, COMMAND_LABELS, commandEnabled, commandIds, type CommandHost, type EditCommands, type FrontendCommands } from '../../src/app/commands.js';
import { AppSession, type AppFrontend, type DocumentTitle, type FrontendHost } from '../../src/app/session.js';
import type { TextEditor, ToastButton } from '../../src/app/document.js';
import { addCard, parseBoard } from '../../src/markdown/kanban.js';
import { applyChangeBatch } from '../../src/app/agentwrites.js';
import { platform, setPlatform } from '../../src/platform/index.js';
import { fileUri } from '../../src/base/files.js';
import { section, test, eq, ok, tmp, disk, until, untilText } from '../core/framework.js';

// A settings store in memory; the keys the application layer reads at startup have a value, any other reads as empty.
export function memorySettings(): AppSettings {
    const values = new Map<string, SettingValue>([['tabs', []], ['recent-files', []], ['projects', {}], ['machines', {}], ['project-options', {}], ['machine-projects', {}]]);
    const listeners = new Set<(key: string) => void>();
    return new AppSettings({
        get: key => values.get(key) ?? '',
        set: (key, value) => { values.set(key, value); for (const l of listeners) l(key); },
        onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    });
}

export class FakeEditor implements TextEditor {
    text = '';
    modified = false;
    headings: { level: number; text: string; line: number }[] = [];
    jumped: number | null = null;
    readonly cursorOffset = 0;
    readonly cursorLine = 0;
    readonly selection = '';
    getText(): string { return this.text; }
    setText(text: string): void { this.text = text; this.modified = false; }
    replaceText(text: string): void { this.text = text; this.modified = true; }
    insertAtCursor(text: string): void { this.text += text; this.modified = true; }
    update(edit: (text: string) => string | null): void { const next = edit(this.text); if (next !== null) this.replaceText(next); }
    isModified(): boolean { return this.modified; }
    setModified(modified: boolean): void { this.modified = modified; }
    jumpToLine(line: number): void { this.jumped = line; }
    setMode(): void {}
    restoreCursor(): void {}
    selected: [number, number, number] | null = null;
    selectRange(line: number, column: number, length: number): void { this.selected = [line, column, length]; }
}

// An editor whose writes land one turn later, the way they will over the app protocol: there the core's replica only
// changes once the frontend has applied a write (docs/design/protocol.md, 5.4 and 5.5). Reading the text while a write
// is still on its way throws, so a controller that reads back its own write in the same turn fails here, on Node, long
// before a second frontend exists. Opening a file (setText) is not a write the frontend can refuse, so it lands at once.
export class LaggingEditor extends FakeEditor {
    private pending: string | null = null;
    private readonly waiting: ((text: string) => string | null)[] = [];
    override getText(): string {
        if (this.pending !== null) throw new Error(`read the text while a write to it had not landed (docs/design/protocol.md 5.5)\n${new Error().stack}`);
        return this.text;
    }
    // A whole text computed while a write is on its way would undo that write; update() is the way to follow one.
    override replaceText(text: string): void {
        if (this.pending !== null) throw new Error('wrote a whole text before the previous write had landed; use update() (docs/design/protocol.md 5.5)');
        this.pending = text;
        setTimeout(() => this.land(), 0);
    }
    override insertAtCursor(text: string): void { this.update(t => t + text); }
    // Marking the document saved after writing it (a discard that took the file again) arrives after that write, as messages
    // keep their order (4.3), so it waits behind it instead of being undone when the write lands.
    override setModified(modified: boolean): void {
        if (this.pending === null) { this.modified = modified; return; }
        this.waiting.push(() => { this.modified = modified; return null; });
    }
    // Runs at once when nothing is on its way, otherwise after the write lands, against the text it left.
    override update(edit: (text: string) => string | null): void {
        if (this.pending !== null) { this.waiting.push(edit); return; }
        const next = edit(this.text);
        if (next !== null) this.replaceText(next);
    }
    private land(): void {
        this.text = this.pending!;
        this.pending = null;
        this.modified = true;
        while (this.pending === null && this.waiting.length) this.update(this.waiting.shift()!);
    }
}

// The tab row as the frontend keeps it: what the document controller asks it to add and remove, in order.
export function tabRow(): Pick<AppFrontend<FakeEditor>['documents'], 'tabOrder' | 'attach' | 'detach' | 'listTab' | 'attachPage' | 'detachPage'> {
    const row: number[] = [];
    const drop = (id: number) => { const at = row.indexOf(id); if (at >= 0) row.splice(at, 1); };
    return {
        tabOrder: () => [...row],
        attach: id => { row.push(id); },
        detach: drop,
        listTab: (id, listed) => { if (listed && !row.includes(id)) row.push(id); else if (!listed) drop(id); },
        attachPage: page => { row.push(page.id); },
        detachPage: drop,
    };
}

// Any member the test does not care about does nothing.
export const quiet = <T extends object>(members: Partial<T>): T => new Proxy(members, { get: (target, key) => key in target ? (target as never)[key] : () => undefined }) as T;

// extra: host members a test sets itself (the work folder, the Assistant panel); root also answers for the documents.
export function fakeFrontend(settings: AppSettings, toasts: string[], makeEditor: () => FakeEditor = () => new FakeEditor(),
                             extra: Partial<FrontendHost<FakeEditor>> = {}): AppFrontend<FakeEditor> {
    return {
        settings,
        createEditor: makeEditor,
        host: quiet<FrontendHost<FakeEditor>>({
            screen: quiet<FrontendHost<FakeEditor>['screen']>({}),
            chatPanel: quiet<FrontendHost<FakeEditor>['chatPanel']>({}),
            board: quiet({}), inbox: quiet({}), table: quiet({}), csv: quiet({}), layouts: quiet({}),
            collabPanel: quiet({}), outlineView: quiet({}), preferencesView: quiet({}), pullView: quiet({}), reviewView: quiet({}), logs: quiet({}), fileTree: quiet({}), searchView: quiet({}),
            toast: message => { toasts.push(message); },
            ...extra,
        }),
        documents: quiet<AppFrontend<FakeEditor>['documents']>({ dialogs: quiet({}), ...tabRow() }),
        // The file dialogs are a plain object a test can fill in; they answer "cancelled" until it does.
        dialogs: quiet<AppFrontend<FakeEditor>['dialogs']>({ files: { name: async () => null, confirm: async () => false, error: () => {} }, search: { confirm: async () => false }, preferences: { machine: async () => null, removeWorktree: async () => false } }),
    };
}

export async function appSessionTests(): Promise<void> {
    section('Command registry');
    await test('ids are unique, keys are well formed, and the palette order is kept', () => {
        eq(new Set(COMMANDS.map(c => c.id)).size, COMMANDS.length, 'duplicate command id');
        for (const c of COMMANDS) for (const key of c.keys) ok(/^((Ctrl|Alt|Shift)\+)*(\S|[A-Z][A-Za-z0-9]+)$/.test(key), `${c.id}: ${key}`);
        eq(Object.keys(COMMAND_LABELS).slice(0, 3), ['new', 'open', 'open-folder']);
        eq(Object.keys(COMMAND_LABELS).at(-1), 'command-palette');
        ok(!('heading1' in COMMAND_LABELS) && !('layout' in COMMAND_LABELS), 'unlabeled commands stay out of the palette');
    });

    await test('a command is enabled by what the view shows', () => {
        const bold = COMMANDS.find(c => c.id === 'bold')!;
        const save = COMMANDS.find(c => c.id === 'save')!;
        const fields = COMMANDS.find(c => c.id === 'fields-edit')!;
        eq([bold, save, fields].map(c => commandEnabled(c, { page: false, structured: false })), [true, true, false], 'text');
        eq([bold, save, fields].map(c => commandEnabled(c, { page: false, structured: true })), [false, true, true], 'board');
        eq([bold, save, fields].map(c => commandEnabled(c, { page: true, structured: false })), [false, false, false], 'home');
        ok(commandIds('text').includes('heading3') && commandIds('document').includes('layout'), 'scopes');
    });

    await test('a command acts only through the host', () => {
        const calls: string[] = [];
        const edit = quiet<EditCommands>({
            wrap: marker => { calls.push(`wrap ${marker}`); },
            heading: level => { calls.push(`heading ${level}`); },
            table: op => { calls.push(`table ${op}`); },
            lineKind: kind => { calls.push(`line ${kind}`); },
            block: (before, after) => { calls.push(`block ${JSON.stringify(before + after)}`); },
        });
        const host = quiet<CommandHost>({ edit, switchTab: step => { calls.push(`tab ${step}`); }, setOption: (key, on) => { calls.push(`${key} ${on}`); }, setSource: on => { calls.push(`source ${on}`); } });
        const run = (id: string, arg?: boolean | string) => COMMANDS.find(c => c.id === id)!.run(host, arg);
        run('bold'); run('strike'); run('heading2'); run('table-align-center'); run('prev-tab'); run('dark', true); run('source', false);
        eq(calls, ['wrap **', 'wrap ~~', 'heading 2', 'table align-center', 'tab -1', 'dark true', 'source false']);
        calls.length = 0;
        run('ulist'); run('olist'); run('tasklist'); run('quote'); run('paragraph'); run('divider');
        eq(calls, ['line bullet', 'line numbered', 'line task', 'line quote', 'line paragraph', 'block "\\n---\\n\\n"'], 'the visual editor\'s blocks');
    });

    await test('a command says where it runs: the editor\'s edits and the frontend\'s own windows there, the rest in the core', () => {
        const editor = COMMANDS.filter(c => c.runs === 'editor').map(c => c.id);
        for (const id of ['bold', 'undo', 'find', 'search-files', 'heading2', 'table-format', 'source', 'command-palette', 'quit']) ok(editor.includes(id), id);
        for (const id of ['save', 'open', 'open-folder', 'image', 'layout', 'dark', 'sidebar', 'kanban-view', 'visual', 'preferences']) ok(!editor.includes(id), id);
        const frontend: string[] = [];
        const settings = memorySettings();
        const session = new AppSession(fakeFrontend(settings, []));
        session.start();
        const host = session.commands(quiet<FrontendCommands>({ edit: quiet<EditCommands>({}), quit: () => { frontend.push('quit'); } }));
        const run = (id: string, arg?: boolean | string) => COMMANDS.find(c => c.id === id)!.run(host, arg);
        run('dark', true);
        run('kanban-new');
        run('quit');
        eq([settings.dark, frontend], [true, ['quit']], 'a setting is written by the core; quitting is the frontend\'s');
        host.setOption('visual', false);
        eq(settings.visual, false, 'the Visual Editor setting');
        ok(session.documents.active.editor.getText().includes('layout: board'), 'a new board, made by the core');
        session.dispose();
    });

    section('Application session');
    await test('the session builds the controllers on a frontend and opens a file', () => {
        const toasts: string[] = [];
        const settings = memorySettings();
        const session = new AppSession(fakeFrontend(settings, toasts));
        session.start();
        eq(session.documents.all.length, 1, 'the first document');
        const dir = disk.join(tmp, 'appsession');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'note.md');
        disk.write(file, '# Note\n');
        ok(session.host.openInTab(file), 'openInTab');
        eq(session.documents.active.file, file);
        eq((session.documents.active.editor as FakeEditor).text, '# Note\n');
        eq(session.host.active(), session.documents.active, 'the host answers from the document controller');
        eq(session.host.docs().length, 1, 'the empty first tab was reused');
        ok(session.harness && session.journal && session.collab && session.pulls && session.contribute && session.review && session.homePage, 'controllers');
        session.dispose();
    });

    await test('the session decides what the window opens with: a folder and a file, the last tabs, the welcome text, or Home', () => {
        const dir = disk.join(tmp, 'appsession-open');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'plan.md');
        disk.write(file, '# Plan\n');
        const fresh = (settings: AppSettings, path: string | null) => {
            const session = new AppSession(fakeFrontend(settings, []));
            session.start();
            session.open(path);
            return session;
        };
        const settings = memorySettings();
        let session = fresh(settings, null);
        ok((session.documents.active.editor as FakeEditor).text.startsWith('# Welcome to Markwork'), 'the welcome text the first time');
        ok(settings.welcomed, 'and only the first time');
        session.dispose();
        session = fresh(settings, dir);
        eq([session.files.root, settings.folder], [dir, dir], 'a folder from the command line is the work folder, and remembered');
        session.documents.openInTab(file);
        session.documents.rememberTabs();
        session.dispose();
        session = fresh(settings, null);
        eq([session.files.root, session.documents.active.file], [dir, file], 'the last folder and the last tabs');
        session.dispose();
        settings.tabs = [];
        settings.store.set('home', true);
        session = fresh(settings, null);
        eq(session.documents.page?.kind, 'home', 'Home when nothing else is to be opened');
        session.dispose();
        session = fresh(settings, file);
        eq(session.documents.active.file, file, 'a file from the command line wins over the last tabs and Home');
        session.dispose();
    });

    await test('opening another folder closes the tabs outside it, shows the Files tab, and closing remembers the tabs', async () => {
        const base = disk.join(tmp, 'appsession-folders');
        const [one, two] = [disk.join(base, 'one'), disk.join(base, 'two')];
        disk.mkdirs(one);
        disk.mkdirs(two);
        disk.write(disk.join(one, 'a.md'), 'a\n');
        const settings = memorySettings();
        const pages: string[] = [];
        const session = new AppSession(fakeFrontend(settings, [], undefined, { showSidebar: page => { pages.push(page); } }));
        session.start();
        session.open(null);
        eq(await session.openFolder(one), true);
        session.documents.openInTab(disk.join(one, 'a.md'));
        eq(await session.openFolder(two, false), true, 'a file without changes is closed without asking');
        eq([session.files.root, settings.folder], [two, two]);
        ok(session.documents.all.every(d => d.file === null), 'the tab of the other folder is closed');
        eq(pages, ['files'], 'the Files tab is shown when asked for, not when the last folder is restored');
        ok(settings.sidebar, 'and the side panel is opened');
        session.documents.openInTab(disk.join(two, 'b.md'));
        disk.write(disk.join(two, 'b.md'), 'b\n');
        eq(await session.closeRequest(), true);
        eq(settings.tabs.map(t => t.file), [disk.join(two, 'b.md')], 'the tabs are remembered for the next launch');
        session.dispose();
    });

    await test('unsaved changes are asked about one tab at a time: Cancel keeps the tab, the folder, and the window', async () => {
        const base = disk.join(tmp, 'appsession-unsaved');
        const [one, two] = [disk.join(base, 'one'), disk.join(base, 'two')];
        disk.mkdirs(one);
        disk.mkdirs(two);
        const [a, b, c] = ['a.md', 'b.md', 'c.md'].map(name => disk.join(one, name));
        for (const f of [a, b, c]) disk.write(f, 'saved\n');
        const settings = memorySettings();
        settings.autosave = false;
        const asked: string[] = [], answers: ('save' | 'discard' | 'cancel')[] = [];
        const frontend = fakeFrontend(settings, []);
        const session = new AppSession({ ...frontend, documents: quiet<AppFrontend<FakeEditor>['documents']>({ ...frontend.documents,
            dialogs: quiet<AppFrontend<FakeEditor>['documents']['dialogs']>({ askSaveChanges: async name => { asked.push(name); return answers.shift() ?? 'cancel'; } }) }) });
        session.start();
        session.open(null);
        eq(await session.openFolder(one), true);
        const docs = session.documents;
        const doc = (file: string) => docs.all.find(d => d.file === file)!;
        for (const f of [a, b, c]) { docs.openInTab(f); docs.active.editor.replaceText(`typed in ${f.slice(-4)}\n`); }

        answers.push('cancel');
        eq(await docs.closeTab(doc(a)), false, 'Cancel');
        eq([asked, docs.all.length, doc(a).editor.isModified()], [['a.md'], 3, true], 'the tab and its changes stay');

        asked.length = 0;
        answers.push('discard', 'cancel');
        eq(await session.openFolder(two), false, 'Cancel on the second tab');
        eq(asked, ['a.md', 'b.md'], 'asked in order, and not past the Cancel');
        eq([session.files.root, settings.folder, docs.all.length], [one, one, 3], 'the folder is not switched and no tab is closed');

        asked.length = 0;
        answers.push('cancel');
        eq(await session.closeRequest(), false, 'Cancel keeps the window');
        eq(asked, ['a.md']);

        asked.length = 0;
        answers.push('discard');
        eq(await docs.closeTab(doc(a)), true, 'Discard');
        eq([docs.all.length, disk.read(a)], [2, 'saved\n'], 'the tab is closed, the file untouched');

        asked.length = 0;
        answers.push('save', 'discard');
        eq(await session.openFolder(two), true);
        eq(asked, ['b.md', 'c.md']);
        eq([disk.read(b), disk.read(c)], ['typed in b.md\n', 'saved\n'], 'Save wrote b; Discard left c');
        eq([session.files.root, settings.folder], [two, two]);
        ok(docs.all.every(d => d.file === null), 'the tabs of the other folder are closed');
        session.dispose();
    });

    await test('the history is read only while its tab is shown, and coming back to the window reads it again', () => {
        const session = new AppSession(fakeFrontend(memorySettings(), []));
        session.start();
        const reads: boolean[] = [];
        session.history.show = (_file, _folder, force = false) => { reads.push(force); };
        session.open(null);
        session.windowFocused(true);
        eq(reads, [], 'not while the side panel is closed');
        session.sidebarShown('files');
        session.windowFocused(true);
        eq(reads, [], 'not while another tab is shown');
        session.sidebarShown('history');
        session.windowFocused(false);
        session.windowFocused(true);
        eq(reads, [false, true], 'shown, then read again when the window gets the focus back');
        session.sidebarShown('files', true);
        eq(reads.length, 3, 'the Files view reads it while it shows its Timeline');
        session.sidebarShown('files', false);
        eq(reads.length, 3, 'and not without it');
        ok(session.host.isActive(), 'the focus as the frontend reported it');
        session.dispose();
    });

    await test('titles, links, the Recent list, and a file chosen in the tree are the session\'s', async () => {
        // The home folder is the test folder here, so the title can show `~` without touching the real one.
        const real = platform();
        setPlatform({ ...real, paths: new Proxy(real.paths, { get: (target, key) => key === 'homeDir' ? () => tmp : Reflect.get(target, key) }) });
        const dir = disk.join(tmp, 'appsession-titles', 'notes');
        const other = disk.join(tmp, 'appsession-titles', 'other');
        disk.mkdirs(dir);
        disk.mkdirs(other);
        const note = disk.join(dir, 'note.md'), next = disk.join(dir, 'next.md'), image = disk.join(dir, 'cover.png'), page = disk.join(dir, 'report.html');
        for (const f of [note, next, image, page]) disk.write(f, 'x\n');
        const titles = new Map<number, DocumentTitle>();
        const uris: string[] = [], images: string[] = [], recent: string[][] = [];
        const frontend = fakeFrontend(memorySettings(), [], undefined, {
            openUri: uri => { uris.push(uri); }, showImage: path => { images.push(path); }, setRecent: paths => { recent.push(paths); },
        });
        const session = new AppSession({ ...frontend, documents: quiet<AppFrontend<FakeEditor>['documents']>({ ...frontend.documents, setTitle: (id, title) => { titles.set(id, title); } }) });
        try {
            session.start();
            session.open(note);
            const id = session.documents.active.id;
            eq(titles.get(id), { name: 'note.md', file: note, page: false, place: '~/appsession-titles/notes' }, 'the home folder is ~');
            await session.openFolder(dir, false);
            eq(session.host.projectName(note), 'note.md');
            eq(session.host.projectName(disk.join(other, 'x.md')), 'x.md');
            session.openLink(id, 'next.md#part');
            eq(session.documents.active.file, next, 'a Markdown link opens in a tab, read from the document\'s folder');
            session.openLink(session.documents.active.id, 'https://example.org/a b');
            session.openLink(session.documents.active.id, 'my file.pdf');
            eq(uris, ['https://example.org/a b', fileUri(disk.join(dir, 'my file.pdf'))], 'anything else goes to the system');
            session.host.openFile(image);
            eq(images, [image], 'an image goes to the viewer');
            session.host.openFile(page);
            eq(session.documents.page?.file, page, 'an HTML page opens as a page tab, not as a document');
            eq(session.documents.active.file, next, 'and no document was opened for it');
            ok(recent.at(-1)!.includes(note) && recent.at(-1)!.includes(next), JSON.stringify(recent.at(-1)));
            disk.remove(note);
            session.settings.recentFiles = [...session.settings.recentFiles];
            ok(!recent.at(-1)!.includes(note), 'a file that is gone leaves the Recent list');
        } finally {
            session.dispose();
            setPlatform(real);
        }
    });

    await test('a toast button reaches the frontend as a token; the session runs its action once, and forgets old ones', () => {
        const buttons: (ToastButton | undefined)[] = [];
        const session = new AppSession(fakeFrontend(memorySettings(), [], undefined, { toast: (_message, button) => { buttons.push(button); } }));
        session.start();
        const ran: string[] = [];
        session.host.toast('Plain');
        session.host.toast('First', { label: 'Open', run: () => ran.push('first') });
        eq(buttons[0], undefined, 'no button');
        eq(buttons[1]?.label, 'Open');
        eq(JSON.parse(JSON.stringify(buttons[1])), buttons[1], 'not plain data');
        session.toastActivated(buttons[1]!.token);
        session.toastActivated(buttons[1]!.token);
        session.toastActivated(9999);
        eq(ran, ['first'], 'once, and an unknown token does nothing');
        session.host.toast('Old', { label: 'Old', run: () => ran.push('old') });
        const old = buttons.at(-1)!.token;
        for (let i = 0; i < 10; i++) session.host.toast('More', { label: 'More', run: () => ran.push('more') });
        session.toastActivated(old);
        eq(ran, ['first'], 'a toast long gone has no action');
        session.toastActivated(buttons.at(-1)!.token);
        eq(ran, ['first', 'more'], 'the latest still works');
        session.dispose();
    });

    await test('the core holds the board: it reads it from the document, not from the view', () => {
        const session = new AppSession(fakeFrontend(memorySettings(), [], () => new LaggingEditor()));
        session.start();
        const dir = disk.join(tmp, 'appsession-board');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'board.md');
        disk.write(file, '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n');
        ok(session.host.openInTab(file), 'openInTab');
        eq(session.host.boardNow().columns[0].cards.map(c => c.text), ['One']);
        session.host.commitBoard(addCard(session.host.boardNow(), 0, 'Two'));
        eq(session.host.boardNow().columns[0].cards.map(c => c.text), ['One', 'Two'], 'the board committed is the board read back, before the write lands');
        session.dispose();
    });

    await test('a card\'s harness menu is plain entries with tokens; a token runs its action, and the tokens of an earlier menu are forgotten', () => {
        const toasts: string[] = [];
        const session = new AppSession(fakeFrontend(memorySettings(), toasts));
        session.start();
        const board = parseBoard('---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n');
        const card = board.columns[0].cards[0];
        const first = session.harness.menu(card, { column: 0, index: 0 });
        ok(first.length > 0 && first.every(e => typeof e.token === 'number' && !('run' in e)), JSON.stringify(first));
        eq(JSON.parse(JSON.stringify(first)), first, 'not plain data');
        const assign = first.find(e => e.label.startsWith('Work on it with'))!;
        session.harness.runMenu(assign.token);
        eq(toasts, ['Save the board first before assigning cards'], 'the entry ran its action');
        const second = session.harness.menu(card, { column: 0, index: 0 });
        session.harness.runMenu(assign.token);
        session.harness.runMenu(9999);
        eq(toasts.length, 1, 'an old token and an unknown one do nothing');
        ok(second.every(e => first.every(f => f.token !== e.token)), 'tokens are not reused');
        session.dispose();
    });

    await test('a batch that fails after writing an open document restores it, even when the editor applies writes a turn later', async () => {
        const session = new AppSession(fakeFrontend(memorySettings(), [], () => new LaggingEditor()));
        session.start();
        const dir = disk.join(tmp, 'appsession-rollback');
        disk.mkdirs(dir);
        disk.write(disk.join(dir, 'a.md'), 'one\n');
        disk.write(disk.join(dir, 'second.md'), 'first\n');
        session.files.setRoot(dir);
        ok(session.host.openInTab(disk.join(dir, 'a.md')), 'openInTab');
        // The disk refuses the second file, after the first one (open in its editor) was written.
        const real = platform();
        const fs = new Proxy(real.fs, { get: (target, key) => key === 'writeText'
            ? (path: string, text: string) => { if (path.endsWith('second.md') && text === 'second\n') throw new Error('disk full'); target.writeText(path, text); }
            : Reflect.get(target, key) });
        setPlatform({ ...real, fs });
        let error: string | null;
        try {
            error = applyChangeBatch(session.host, [
                { kind: 'edit', file: 'a.md', before: 'one\n', after: 'two\n', reason: 'edit' },
                { kind: 'edit', file: 'second.md', before: 'first\n', after: 'second\n', reason: 'edit' },
            ]);
        } finally { setPlatform(real); }
        ok(error !== null && error.includes('restored'), `error: ${error}`);
        await untilText(session.documents.active.editor, 'one\n');   // the open document is back to what it was
        eq(disk.read(disk.join(dir, 'second.md')), 'first\n');
        session.dispose();
    });

    await test('writes to an open board land even when the editor applies them a turn later', async () => {
        const session = new AppSession(fakeFrontend(memorySettings(), [], () => new LaggingEditor()));
        session.start();
        const dir = disk.join(tmp, 'appsession-lag');
        disk.mkdirs(dir);
        const file = disk.join(dir, 'board.md');
        disk.write(file, '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n');
        ok(session.host.openInTab(file), 'openInTab');
        // Two harness runs that end in the same turn, each moving its own card.
        eq(session.host.updateBoardFile(file, b => addCard(b, 0, 'Two')), null, 'first');
        eq(session.host.updateBoardFile(file, b => addCard(b, 0, 'Three')), null, 'second');
        // The editor lands its writes in a timer; Windows timers can take 15 ms.
        await until(() => { try { session.documents.active.editor.getText(); return true; } catch { return false; } });
        const text = session.documents.active.editor.getText();
        ok(text.includes('- [ ] Two') && text.includes('- [ ] Three'), text);
        session.dispose();
    });
}
