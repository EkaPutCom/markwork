// The renderer's side of the app protocol as a store React can subscribe to. It speaks the protocol (connection, one
// DocMirror per document), keeps what the core shows (tabs, files, boards, toasts), and offers the actions the UI calls.
// It holds no widgets: the editor registers itself, and the views read the snapshot.

import { COMMANDS, type Command, type FrontendCommands } from '../../src/app/commands.js';
import type { StatusCounts } from '../../src/app/protocol/screen.js';
import { DocMirror } from '../../src/app/protocol/mirror.js';
import { RequestError, type Change, type Message } from '../../src/app/protocol/messages.js';
import { Connection, type Handler } from '../../src/app/protocol/wire.js';
import type { ChooseFileOptions, Prompt, Question } from '../../src/app/dialogs.js';
import type { CancelSignal } from '../../src/platform/index.js';
import type { Board } from '../../src/markdown/kanban.js';
import { applyNoteEdit, type NoteEdit } from '../../src/markdown/noteedit.js';
import type { MarkdownEditor } from './editor.js';
import { appUrl } from './images.js';
import type { SearchQuery, SearchResults } from '../../src/app/protocol/search.js';
import type { FolderEntry, NewKind } from '../../src/app/protocol/tree.js';
import type { HomeData } from '../../src/app/protocol/screen.js';

declare global {
    interface Window {
        markwork: { registerHtml(id: number, root: string): Promise<void>; unregisterHtml(id: number): Promise<void>; pathsOf(files: File[]): string[]; closeWindow(): Promise<void>; chooseFile(options: ChooseFileOptions): Promise<string | null>; initialFolder(): Promise<string | null>; openFolder(path: string): Promise<void> };
    }
}

export interface Tab {
    id: number;
    mirror: DocMirror;
    name: string;
    file: string | null;
    page: string;                 // 'text' or the structured page the core shows ('board', …); 'home' and 'html' for the pages that are tabs
    board: Board | null;
    home: HomeData | null;        // a Home tab: what the page shows (view.home)
    html: { file: string; root: string } | null;   // an HTML tab: the file, and the folder it may read
}

// A dialog in the window: a question with buttons, and an entry when it asks for text. The first button is the default.
export interface DialogButton { label: string; value: string; style?: 'suggested' | 'destructive' }
export interface Dialog {
    title: string;
    detail: string;
    buttons: DialogButton[];
    entry: { label: string; value: string } | null;
    close(value: string | null, text: string): void;   // null = dismissed (Escape, or the core withdrew the question)
}

// A command as the core's table lists it in the `hello` reply.
export interface CommandEntry { id: string; label: string | null; keys: string[]; kind: string; scope: string; runs: 'core' | 'editor' }

// The Search panel: what its fields hold, whether the Replace row is open, and the last results. `focus` counts the times a
// command asked for the query field, so the panel can take the focus again.
export interface SearchPanel { form: SearchQuery; replacement: string; replace: boolean; results: SearchResults | null; focus: number }

// The Files tree: the entries of every folder the core has sent (by folder path), the folders shown open, and the file to highlight.
export interface FileTree { root: string | null; folders: Record<string, FolderEntry[]>; expanded: string[]; revealed: string | null }

export interface Toast { text: string; action: { label: string; token: number } | null; at: number }

export interface State {
    ready: boolean;
    coreError: string | null;
    root: string | null;
    files: string[];
    tabs: Tab[];
    active: number;
    toast: Toast | null;
    line: number;                 // the cursor, from 1
    column: number;
    source: boolean;              // source mode: no syntax is hidden
    palette: boolean;
    sidebar: boolean;             // the `sidebar` setting
    settings: Record<string, unknown>;   // the core's settings, as `hello` and `setting` notices give them
    commands: CommandEntry[];     // the core's command table
    dialog: Dialog | null;        // the dialog shown; others wait behind it
    disabled: string[];           // the commands the core says do not apply now (commands.state)
    status: { visible: boolean; counts: StatusCounts };   // the counts at the foot (view.status)
    image: { src: string; title: string } | null;   // the picture shown large (view.image, or a double click)
    tree: FileTree;
    search: SearchPanel;             // the Search panel's fields and the core's results (view.search)
    outline: { level: number; text: string; line: number }[];   // the headings of the active document (view.outline)
    layout: { layout: string | null; structured: boolean };   // the layout button (view.layout): '' = text, null = hidden
}

// The core commands this window can carry out so far; the others need dialogs or views that are not carried over yet.
const CORE_COMMANDS = new Set(['home', 'focus', 'typewriter', 'new', 'open', 'open-folder', 'save', 'save-as', 'export-html', 'image', 'close-tab', 'next-tab', 'prev-tab',
    'kanban-new', 'kanban-view', 'inbox-new', 'table-new', 'sidebar', 'dark', 'autosave']);
const EDITOR_COMMANDS_UNAVAILABLE = new Set(['shortcuts', 'about']);

export const isAvailable = (command: Command): boolean =>
    command.runs === 'core' ? CORE_COMMANDS.has(command.id) : !EDITOR_COMMANDS_UNAVAILABLE.has(command.id);

export class Client {
    private snapshot: State = {
        ready: false, coreError: null, root: null, files: [], tabs: [], active: 0, toast: null, line: 1, column: 1,
        source: false, palette: false, sidebar: true, settings: {}, commands: [], dialog: null, image: null, tree: { root: null, folders: {}, expanded: [], revealed: null }, outline: [], search: { form: { text: '', include: '', exclude: '', caseSensitive: false, wholeWord: false, regex: false }, replacement: '', replace: false, results: null, focus: 0 }, disabled: [],
        status: { visible: true, counts: { kind: 'text' } }, layout: { layout: '', structured: false },
    };
    private readonly waitingDialogs: Dialog[] = [];
    private readonly listeners = new Set<() => void>();
    private conn: Connection | null = null;
    private editor: MarkdownEditor | null = null;
    private cursorTimer: ReturnType<typeof setTimeout> | null = null;

    // ---------- Store ----------

    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    getState = (): State => this.snapshot;

    private set(patch: Partial<State>): void {
        this.snapshot = { ...this.snapshot, ...patch };
        for (const l of this.listeners) l();
    }

    private changeTab(id: number, patch: Partial<Tab>): void {
        this.set({ tabs: this.snapshot.tabs.map(t => t.id === id ? { ...t, ...patch } : t) });
    }

    private tab(id = this.snapshot.active): Tab | undefined { return this.snapshot.tabs.find(t => t.id === id); }

    get activeTab(): Tab | undefined { return this.tab(); }

    // ---------- The editor ----------

    // The core asked to show a line of a document (a [[note#section]] link): now if its tab is the one shown, else when it is.
    private reveal: { doc: number; line: number; select?: [column: number, length: number] } | null = null;
    private applyReveal(): void {
        if (!this.reveal || this.reveal.doc !== this.snapshot.active || !this.editor) return;
        const { line, select } = this.reveal;
        if (select) this.editor.select(line, select[0], select[1]); else this.editor.reveal(line);
        this.reveal = null;
    }

    // Focus and typewriter mode are settings the core keeps; the editor draws them.
    private applyModes(): void {
        const { settings } = this.snapshot;
        this.editor?.setFocusMode(settings.focus === true);
        this.editor?.setTypewriterMode(settings.typewriter === true);
    }

    attachEditor(editor: MarkdownEditor | null): void {
        this.editor = editor;
        const tab = this.tab();
        if (editor && tab) editor.show(tab.id, tab.mirror.text);
        this.applyModes();
    }

    // The user typed: the editor reports its whole text, the mirror turns it into a small edit and the core gets it at once.
    typed(text: string): void {
        const tab = this.tab();
        const edit = tab?.mirror.typed(text);
        if (tab && edit) this.conn?.notify('doc.edit', { ...edit });
        if (tab) this.changeTab(tab.id, {});
    }

    moved(line: number, column: number): void {
        this.set({ line, column });
        if (this.cursorTimer) clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => {
            const tab = this.tab(), editor = this.editor;
            if (!tab || !editor) return;
            const { offset, selection } = editor.cursor();
            this.conn?.notify('doc.cursor', { doc: tab.id, version: tab.mirror.version, offset, selection });
        }, 150);
    }

    say(text: string, action: Toast['action'] = null): void { this.set({ toast: { text, action, at: Date.now() } }); }
    dismissToast(): void { this.set({ toast: null }); }
    runToast(token: number): void { void this.conn?.request('act.token', { token }); this.dismissToast(); }

    // ---------- Actions ----------

    // A request the user caused: a refusal is told, not swallowed.
    private async ask(op: string, payload: Record<string, unknown> = {}): Promise<void> {
        const reply = await this.conn?.request(op, payload);
        if (reply && !reply.ok) this.say(reply.error.message);
    }

    async openFolder(): Promise<void> {
        const path = await window.markwork.chooseFile({ title: 'Open Folder', selectFolder: true });
        if (path) await this.ask('open.folder', { path });
    }
    openFile = (name: string): void => { void this.ask('open.file', { name }); };
    selectTab = (doc: number): void => { void this.ask('tab.select', { doc }); };
    closeTab = (doc: number): void => { void this.ask('tab.close', { doc }); };

    // A change the user made on the board: shown at once with the function the core applies, then sent.
    editNotes(edit: NoteEdit): void {
        const tab = this.tab();
        const next = tab?.board && applyNoteEdit(tab.board, edit);
        if (tab && next) this.changeTab(tab.id, { board: next });
        void this.conn?.request('act.notes.edit', { doc: this.snapshot.active, edit });
    }

    zoomImage(image: { src: string; title: string }): void { this.set({ image }); }
    closeImage(): void { this.set({ image: null }); this.editor?.focus(); }

    // The folder of the active document, which its relative picture paths start from.
    baseDir(): string | null {
        const file = this.tab()?.file ?? null;
        return file && file.includes('/') ? file.slice(0, file.lastIndexOf('/')) || '/' : null;
    }

    // A link Ctrl+clicked in the active document: the core decides (a note in a tab, a URL in the browser).
    openLink(url: string): void { void this.ask('open.link', { doc: this.snapshot.active, url }); }

    // [[link]] Ctrl+clicked in the active document: the core finds or makes the note and opens its tab.
    openNote(link: string): void { void this.ask('open.note', { doc: this.snapshot.active, link }); }

    // The notes a [[ suggestion offers for the active document.
    async noteNames(): Promise<string[]> {
        const reply = await this.conn?.request('ask.notes', { doc: this.snapshot.active });
        return reply?.ok ? (reply.names as string[]) : [];
    }

    focusEditor(): void { this.editor?.focus(); }
    openPalette(open = true): void { this.set({ palette: open }); }
    toggleSidebar(): void { this.setSetting('sidebar', !this.snapshot.sidebar); }

    // A rail button: its page opens; the button of the page that is open closes the side panel.
    showSidebarPage(page: string): void {
        const { sidebar, settings } = this.snapshot;
        if (sidebar && settings['sidebar-page'] === page) { this.setSetting('sidebar', false); return; }
        this.setSetting('sidebar-page', page);
        if (!sidebar) this.setSetting('sidebar', true);
    }

    // ---------- Home ----------

    openRecent(path: string): void { void this.ask('act.home.openFile', { path }); }
    openWorkspaceFile(name: string): void { void this.ask('act.home.openWorkspaceFile', { name }); }
    openRun(id: number): void { void this.ask('act.home.openRun', { id }); }
    openJournal(): void { void this.ask('act.home.openJournal'); }
    // A task checked on Home: true = the core wrote it to its board, false = put the box back.
    async toggleTask(task: unknown, done: boolean): Promise<boolean> {
        const reply = await this.conn?.request('act.home.toggleTask', { task, done });
        return reply?.ok === true && reply.written === true;
    }

    // ---------- The Files tree ----------

    private expandFolder(dir: string): void {
        const { tree } = this.snapshot;
        if (tree.expanded.includes(dir)) return;
        if (!tree.folders[dir]) void this.conn?.request('act.tree.openFolder', { dir });
        this.set({ tree: { ...tree, expanded: [...tree.expanded, dir] } });
    }

    // Highlight a file, with the folders above it open.
    private revealPath(path: string | null): void {
        const { tree } = this.snapshot;
        this.set({ tree: { ...tree, revealed: path } });
        if (!path || !tree.root || !path.startsWith(tree.root)) return;
        const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
        const parts = path.slice(tree.root.length + 1).split(sep).slice(0, -1);
        let dir = tree.root;
        for (const part of parts) { dir = `${dir}${sep}${part}`; this.expandFolder(dir); }
    }

    toggleFolder(dir: string): void {
        const { tree } = this.snapshot;
        if (tree.expanded.includes(dir)) this.set({ tree: { ...tree, expanded: tree.expanded.filter(d => d !== dir) } });
        else this.expandFolder(dir);
    }

    activateEntry = (path: string): void => { void this.ask('act.tree.activate', { path }); };
    createEntry(kind: NewKind, dir: string): void { void this.ask('act.tree.create', { kind, dir }); }
    renameEntry(path: string): void { void this.ask('act.tree.rename', { path }); }
    removeEntry(path: string): void { void this.ask('act.tree.remove', { path }); }
    moveEntry(source: string, dir: string): void { void this.ask('act.tree.move', { source, dir }); }
    copyInto(sources: string[], dir: string): void { if (sources.length) void this.ask('act.tree.copy', { sources, dir }); }

    // ---------- Search in all notes ----------

    // Show the Search page with the selected text as the query (Ctrl+Shift+F), and the Replace row too (Ctrl+Shift+H).
    showSearch(replace = false): void {
        const selected = this.editor?.selectedText ?? '';
        const { search } = this.snapshot;
        const form = selected && !selected.includes('\n') ? { ...search.form, text: selected } : search.form;
        if (this.snapshot.settings['sidebar-page'] !== 'search' || !this.snapshot.sidebar) { this.setSetting('sidebar-page', 'search'); this.setSetting('sidebar', true); }
        this.set({ search: { ...search, form, replace: replace || search.replace, focus: search.focus + 1 } });
        if (form.text) this.runSearch(form);
    }

    setSearchForm(patch: Partial<SearchPanel>): void {
        const search = { ...this.snapshot.search, ...patch };
        this.set({ search });
        if (patch.form) this.runSearch(search.form);
    }

    private runSearch(query: SearchQuery): void { void this.ask('act.search.run', { query }); }
    openHit(file: string, index: number): void { void this.ask('act.search.openHit', { file, index }); }
    replaceAll(): void { void this.ask('act.search.replaceAll', { replacement: this.snapshot.search.replacement }); }

    jumpToHeading(index: number): void { void this.ask('act.outline.jump', { index }); }

    // ---------- Settings ----------

    // Shown at once, then written by the core, which sends the value back.
    setSetting(key: string, value: unknown): void {
        this.applySettings({ [key]: value });
        this.conn?.notify('setting', { key, value });
    }

    private applySettings(changed: Record<string, unknown>): void {
        const settings = { ...this.snapshot.settings, ...changed };
        this.set({ settings, sidebar: settings.sidebar !== false });
        // 'system' follows the system theme (the media query of theme.css); 'light' and 'dark' win over it.
        this.applyModes();
        const scheme = settings['color-scheme'];
        if (scheme === 'light' || scheme === 'dark') document.documentElement.dataset.theme = scheme;
        else delete document.documentElement.dataset.theme;
    }

    // The argument of an on/off command run from a key or the palette: the opposite of what is shown now.
    private toggled(command: Command): boolean | undefined {
        const { settings } = this.snapshot;
        if (command.id === 'kanban-view') return this.tab()?.page !== 'board';
        if (command.id === 'source') return !this.snapshot.source;
        if (command.id === 'dark') return settings['color-scheme'] !== 'dark';
        if (command.kind === 'setting') return settings[command.id] !== true;
        return undefined;
    }

    // ---------- Dialogs ----------

    // Show a dialog, or queue it behind the one shown. cancel = the core withdrew the question: it closes unanswered.
    showDialog(spec: Omit<Dialog, 'close'>, cancel?: CancelSignal): Promise<{ value: string | null; text: string }> {
        return new Promise(resolve => {
            let stop: (() => void) | undefined;
            const dialog: Dialog = {
                ...spec,
                close: (value, text) => {
                    stop?.();
                    const at = this.waitingDialogs.indexOf(dialog);
                    if (at < 0) return;
                    this.waitingDialogs.splice(at, 1);
                    this.set({ dialog: this.waitingDialogs[0] ?? null });
                    resolve({ value, text });
                },
            };
            this.waitingDialogs.push(dialog);
            this.set({ dialog: this.waitingDialogs[0] });
            stop = cancel?.onCancel(() => dialog.close(null, ''));
        });
    }

    // Any question of the core this window has no dialog of its own for: a `Question` (yes or no) or a `Prompt` (a line
    // of text), drawn with the generic dialog (app/protocol/asks.ts).
    private genericAsk = (op: string): Handler | null => {
        if (!op.startsWith('ask.')) return null;
        return async (p, cancel) => {
            if (p.question && typeof p.question === 'object') {
                const q = p.question as Question;
                const { value } = await this.showDialog({
                    title: q.message, detail: q.detail, entry: null,
                    buttons: [{ label: q.accept, value: 'yes', style: q.destructive ? 'destructive' : 'suggested' }, { label: 'Cancel', value: 'no' }],
                }, cancel);
                return { answer: value === 'yes' };
            }
            if (p.prompt && typeof p.prompt === 'object') {
                const q = p.prompt as Prompt;
                const { value, text } = await this.showDialog({
                    title: q.title, detail: '', entry: { label: q.label, value: q.value ?? '' },
                    buttons: [{ label: q.accept ?? 'OK', value: 'ok', style: 'suggested' }, { label: 'Cancel', value: 'cancel' }],
                }, cancel);
                return value === 'ok' ? { text } : {};
            }
            throw new RequestError('unknown_op', `no dialog for ${op}`);
        };
    };

    // Whether a command applies now: this window carries it out, and the core has not said it does not apply to what is
    // shown (commands.state, from the same rules as the GTK window's actions).
    enabled(command: Command): boolean {
        if (!isAvailable(command) || this.snapshot.disabled.includes(command.id)) return false;
        return command.scope === 'always' || this.snapshot.tabs.length > 0;
    }

    // The half of FrontendCommands that is this window's: its editor and its own panels.
    private frontendCommands(): FrontendCommands {
        const editor = this.editor;
        const none = () => this.say('This is not available in this window yet');
        return {
            edit: editor?.edit ?? ({ undo: none, redo: none, wrap: none, link: none, block: none, prefix: none, heading: none, table: none, zoomImage: none }),
            openFind: replace => { if (editor) editor.openFind(replace === true); else none(); },
            showSearch: replace => this.showSearch(replace === true),
            setSource: on => { editor?.setSourceMode(on); this.set({ source: on }); },
            showPalette: () => this.openPalette(),
            showShortcuts: none, showAbout: none,
            quit: () => window.close(),
        };
    }

    run(id: string, arg?: boolean | string): void {
        const command = COMMANDS.find(c => c.id === id);
        if (!command || !this.enabled(command)) return;
        const argument = arg ?? this.toggled(command);
        // The core's table says where a command runs; the window's own copy is the fallback before `hello` arrives.
        const runs = this.snapshot.commands.find(c => c.id === id)?.runs ?? command.runs;
        // A setting command is the setting of the same name (app/commands.ts): the frontend writes it, as GTK binds it.
        if (command.kind === 'setting') {
            this.setSetting(id, argument === true);
            return;
        }
        if (runs === 'core') {
            void this.ask('command', { name: id, arg: argument });
            return;
        }
        // The editor commands only use the part of the host that is theirs.
        command.run(this.frontendCommands() as never, argument);
    }

    // ---------- The core's side of the conversation ----------

    connect(port: MessagePort): void {
        const c = new Connection(m => port.postMessage(m), 'f');
        this.conn = c;
        port.onmessage = ({ data }: MessageEvent<Message>) => c.receive(data);

        c.onNotice((ev, p) => this.notice(ev, p));
        c.on('doc.replace', p => {
            const tab = this.tab(p.doc as number);
            if (!tab) throw new RequestError('stale', 'that document is closed');
            const result = tab.mirror.replace(p.base as number, p.changes as Change[]);
            if (!result.ok) throw new RequestError('conflict', 'text changed', { version: result.version });
            if (tab.id === this.snapshot.active) this.editor?.applyFromCore(result.applied);
            this.changeTab(tab.id, {});
            return result;
        });
        c.on('doc.close', p => {
            this.editor?.forget(p.doc as number);
            this.set({ tabs: this.snapshot.tabs.filter(t => t.id !== p.doc) });
        });
        c.on('doc.resync', p => {
            const tab = this.tab(p.doc as number);
            if (!tab) throw new RequestError('stale', 'that document is closed');
            return tab.mirror.snapshot(0);
        });
        c.on('ask.saveChanges', async (p, cancel) => {
            const { value } = await this.showDialog({
                title: 'Save Changes?', detail: `${String(p.document)} contains unsaved changes. Changes which are not saved will be permanently lost.`,
                entry: null,
                buttons: [{ label: 'Save', value: 'save', style: 'suggested' }, { label: 'Discard', value: 'discard', style: 'destructive' }, { label: 'Cancel', value: 'cancel' }],
            }, cancel);
            return { answer: value ?? 'cancel' };
        });
        c.on('ask.file', async p => ({ path: await window.markwork.chooseFile(p as unknown as ChooseFileOptions) }));
        c.onOther(this.genericAsk);

        void (async () => {
            const hello = await c.request('hello', { proto: 1, frontend: 'electron' });
            if (hello.ok) {
                this.set({ commands: (hello.commands as CommandEntry[] | undefined) ?? [] });
                this.applySettings((hello.settings as Record<string, unknown> | undefined) ?? {});
            }
            await c.request('start', { path: await window.markwork.initialFolder() });
            c.notify('window.active', { active: true });
            this.set({ ready: true });
        })();
    }

    // The window was asked to close: the core asks about unsaved documents, then the window goes (or stays).
    async closeRequested(): Promise<void> {
        const reply = await this.conn?.request('app.close', {});
        if (!this.conn || (reply?.ok && reply.allowed === true)) await window.markwork.closeWindow();
    }

    coreExited(code: number | null, stderr: string): void {
        this.conn = null;
        this.set({ coreError: stderr || `The core exited with code ${code}` });
    }

    windowActive(active: boolean): void { this.conn?.notify('window.active', { active }); }

    private notice(ev: string, p: Record<string, unknown>): void {
        const id = p.doc as number;
        const tab = this.tab(id);
        switch (ev) {
            case 'doc.open':
                this.set({ tabs: [...this.snapshot.tabs, { id, mirror: new DocMirror(id, p.text as string, p.version as number), name: 'Untitled', file: null, page: 'text', board: null, home: null, html: null }] });
                break;
            case 'page.open': {
                const page = p.page as number, kind = p.kind as string, file = p.file as string | null;
                this.set({ tabs: [...this.snapshot.tabs, {
                    id: page, mirror: new DocMirror(page, '', 0), name: kind === 'home' ? 'Home' : (file?.split(/[\\/]/).pop() ?? 'Page'), file, page: kind, board: null,
                    home: null, html: kind === 'html' ? { file: file!, root: p.root as string } : null,
                }] });
                break;
            }
            case 'page.close': this.set({ tabs: this.snapshot.tabs.filter(t => t.id !== p.page) }); break;
            case 'page.active': this.set({ active: p.page as number }); break;
            case 'view.home': {
                const home = this.snapshot.tabs.find(t => t.page === 'home');
                if (home) this.changeTab(home.id, { home: p.data as HomeData });
                break;
            }
            case 'doc.reset':
                if (!tab) break;
                tab.mirror.reset(p.text as string, p.version as number);
                this.changeTab(id, { board: null });
                if (id === this.snapshot.active) this.editor?.reset(p.text as string);
                break;
            case 'doc.active': {
                this.set({ active: id });
                const shown = this.tab(id);
                if (shown) this.editor?.show(id, shown.mirror.text);
                this.applyReveal();
                break;
            }
            case 'doc.select': this.reveal = { doc: id, line: p.line as number, select: [p.column as number, p.length as number] }; this.applyReveal(); break;
            case 'doc.reveal': this.reveal = { doc: id, line: p.line as number }; this.applyReveal(); break;
            case 'doc.title': {
                const title = p.title as { name: string; file: string | null };
                this.changeTab(id, { name: title.name, file: title.file });
                if (id === this.snapshot.active) this.editor?.rebuild();
                break;
            }
            case 'doc.saved': tab?.mirror.savedAt(p.version as number); this.changeTab(id, {}); break;
            case 'view.page': this.changeTab(id, { page: p.page as string }); break;
            case 'view.notes': this.changeTab(id, { board: p.board as Board, page: p.page as string }); break;
            case 'view.files': this.set({ root: p.root as string, files: p.files as string[] }); break;
            case 'toast': this.say(p.text as string, (p.action as Toast['action']) ?? null); break;
            case 'error': this.say(p.message as string); break;
            case 'view.tree.root': {
                const root = p.root as string | null;
                this.set({ tree: { root, folders: root ? { [root]: p.entries as FolderEntry[] } : {}, expanded: [], revealed: null } });
                break;
            }
            case 'view.tree.folder': this.set({ tree: { ...this.snapshot.tree, folders: { ...this.snapshot.tree.folders, [p.dir as string]: p.entries as FolderEntry[] } } }); break;
            case 'view.tree.expand': this.expandFolder(p.dir as string); break;
            case 'view.tree.reveal': this.revealPath(p.path as string | null); break;
            case 'view.search': this.set({ search: { ...this.snapshot.search, results: p.results as SearchResults } }); break;
            case 'view.outline': this.set({ outline: p.headings as State['outline'] }); break;
            case 'view.image': this.set({ image: { src: appUrl(p.path as string), title: String(p.path).split('/').pop() ?? '' } }); break;
            case 'open.uri': window.open(p.uri as string); break;
            case 'setting': this.applySettings({ [p.key as string]: p.value }); break;
            case 'commands.state': this.set({ disabled: p.disabled as string[] }); break;
            case 'view.status': this.set({ status: { visible: p.visible !== false, counts: p.counts as StatusCounts } }); break;
            case 'view.layout': this.set({ layout: { layout: p.layout as string | null, structured: p.structured === true } }); break;
            case 'find.close': this.editor?.closeFind(); break;
            // A desktop notification only when the window does not have the focus; otherwise the toast says it.
            case 'notify':
                if (!document.hasFocus()) new Notification(p.title as string, { body: p.body as string, tag: p.id as string });
                break;
            case 'reveal.folder': void window.markwork.openFolder(p.path as string); break;
        }
    }
}
