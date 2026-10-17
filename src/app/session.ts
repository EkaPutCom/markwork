// The application session: builds the feature controllers of app/ and owns them, given one frontend. The frontend (the
// GTK window today) supplies what only it can: the views the controllers draw on, the dialogs they ask with, and the
// hooks for what must follow a document on screen. Everything that connects the controllers to each other lives here,
// so a second frontend implements AppFrontend and gets the same application, not a copy of the wiring.

import type { AppSettings, SidebarPage } from '../settings.js';
import { WorkspaceRepository } from '../workspace.js';
import { fileExists, fileUri, insideName } from '../files.js';
import { platform } from '../platform/index.js';
import { after, type Awaitable } from '../awaitable.js';
import { WELCOME } from '../welcome.js';
import { Autosaver, type AutosaveHost } from './autosave.js';
import { CollabController, type CollabDialogs, type CollabHost } from './collab.js';
import { ContributeController, type ContributeDialogs, type ContributeHost } from './contribute.js';
import { PullReviewController, type PullDialogs, type PullHost } from './pulls.js';
import { JournalController, type JournalDialogs, type JournalHost } from './journal.js';
import { HarnessController, type HarnessDialogs, type HarnessHost } from './harness.js';
import { HarnessReviewController, type ReviewDialogs, type ReviewHost } from './harnessreview.js';
import { HomeController, type HomeHost } from './home.js';
import { ViewController, type ViewDialogs, type ViewHost } from './views.js';
import { NoteLinks, type NoteHost } from './notes.js';
import { DocumentController, type DocumentsHost } from './documents.js';
import type { AgentWriteHost } from './agentwrites.js';
import { AssistantController, type AssistantHost } from './assistant.js';
import { HistoryController, type HistoryDialogs, type HistoryHost } from './history.js';
import { PreferencesController, type PreferencesDialogs, type PreferencesHost } from './preferences.js';
import { OutlineController, type OutlineHost } from './outline.js';
import { FilesController, isImageFile, type FilesDialogs, type FilesHost } from './files.js';
import { SearchController, type SearchDialogs, type SearchHost } from './search.js';
import type { Board } from '../markdown/kanban.js';
import type { Doc, TextEditor, ToastAction, ToastButton } from './document.js';
import type { CommandHost, CoreCommands, FrontendCommands } from './commands.js';
import { _ } from '../i18n.js';

// The host the controllers see, put together: each controller is typed with only the part it needs.
export type ControllerHost<E extends TextEditor> = AutosaveHost & JournalHost & HarnessHost & HomeHost & AgentWriteHost<E> & ViewHost<E>
    & NoteHost & CollabHost & PullHost & ContributeHost & ReviewHost & AssistantHost<E> & HistoryHost<E> & FilesHost & SearchHost<E> & OutlineHost<E> & PreferencesHost;

// What the session answers itself, from the controllers it owns.
type SessionProvided = 'harness' | 'journal' | 'homePage' | 'workspace' | 'active' | 'docs' | 'openInTab' | 'write' | 'fileMoved' | 'fileGone'
    | 'fileBack' | 'newDocument' | 'showDocument' | 'saveAll' | 'showChat' | 'boardShown' | 'updateBoardFile' | 'record' | 'agentHost' | 'runs'
    | 'journalSummary' | 'refreshHome' | 'chat' | 'root' | 'entryMoved' | 'entryDeleted' | 'settings' | 'toast' | 'boardNow' | 'commitBoard'
    | 'openFile' | 'projectName' | 'isActive' | 'refreshTree' | 'filesMoved' | 'showPull' | 'showReview' | 'showRuns';

// How a document's tab and the window are titled. The frontend adds its own mark for unsaved changes, since its editor
// knows them first.
export interface DocumentTitle {
    name: string;
    file: string | null;
    home: boolean;
    place: string | null;    // Home: the work folder's name; a file: its folder, `~` for the home folder; null: the app's name
}

// The views, notices, and system services of the frontend: the host members that are not another controller. A toast
// button reaches it as a token, which it gives back to AppSession.toastActivated when the user presses the button.
export type FrontendHost<E extends TextEditor> = Omit<ControllerHost<E>, SessionProvided> & {
    toast(message: string, action?: ToastButton): void;
    showSidebar(page: SidebarPage): void;   // open the side panel at a page (a folder was opened: the Files tab)
    showImage(path: string): void;          // an image chosen in the Files tab: the frontend's viewer
    setRecent(paths: string[]): void;       // the Recent list of the menus: files that still exist, latest first
    showPull(): void;                       // the content area shows the pull request page
    showReview(): void;                     // the content area shows the review page
};

// What the frontend's tabs do when the documents change; the rest of what follows a document is the session's.
export type FrontendDocuments<E extends TextEditor> = Omit<DocumentsHost<E>, 'autosaver' | 'refreshHome' | 'root' | 'settings' | 'toast'
    | 'createEditor' | 'contentChanged' | 'refreshTitle' | 'openFolder' | 'fileSaved'> & {
    setTitle(id: number, title: DocumentTitle): void;
};

// The questions the controllers ask the user. A dialog answers with a value or a Promise; tests replace them.
export interface AppDialogs {
    journal: JournalDialogs;
    collab: CollabDialogs;
    pulls: PullDialogs;
    contribute: ContributeDialogs;
    harness: HarnessDialogs;
    review: ReviewDialogs;
    views: ViewDialogs;
    history: HistoryDialogs;
    files: FilesDialogs;
    search: SearchDialogs;
    preferences: PreferencesDialogs;
}

export interface AppFrontend<E extends TextEditor> {
    // The settings belong to the core: the frontend is given the store they live in, not a view of them (docs/design/protocol.md 9.2).
    readonly settings: AppSettings;
    readonly host: FrontendHost<E>;
    readonly documents: FrontendDocuments<E>;
    // The editor of a new document. Over the protocol the core makes it itself (a replica of the text); under GTK it is the widget.
    createEditor(id: number): E;
    readonly dialogs: AppDialogs;
}

export class AppSession<E extends TextEditor> {
    readonly settings: AppSettings;
    // The Markdown files of the work folder; documents with unsaved changes are read from their editor.
    readonly workspace = new WorkspaceRepository(() => new Map(this.documents.all
        .filter(d => d.file && d.editor.isModified()).map(d => [d.file!, d.editor.getText()])));
    readonly autosaver: Autosaver;
    readonly journal: JournalController;
    readonly collab: CollabController;
    readonly pulls: PullReviewController;
    readonly contribute: ContributeController;
    readonly harness: HarnessController;
    readonly review: HarnessReviewController;
    readonly homePage: HomeController;
    readonly views: ViewController<E>;
    readonly notes: NoteLinks;
    readonly documents: DocumentController<E>;
    readonly assistant: AssistantController<E>;
    readonly history: HistoryController<E>;
    // The work folder and the Files tab; created first, since every other controller asks for the folder.
    readonly files: FilesController;
    readonly search: SearchController<E>;
    readonly outline: OutlineController<E>;
    readonly preferences: PreferencesController;
    readonly host: ControllerHost<E>;

    constructor(private readonly frontend: AppFrontend<E>) {
        this.settings = frontend.settings;
        // The frontend's members stay reachable through the prototype, so its getters keep working.
        this.host = Object.create(frontend.host, this.provided()) as ControllerHost<E>;
        const { host } = this;
        const { dialogs } = frontend;

        // Feature controllers: created before the first document, whose buffer already queues autosaves.
        this.files = new FilesController(host, dialogs.files);
        this.autosaver = new Autosaver(host);
        this.journal = new JournalController(host, dialogs.journal);
        this.collab = new CollabController(host, dialogs.collab);
        this.pulls = new PullReviewController(host, { provider: () => this.collab.provider(), changed: () => void this.collab.refresh(), session: () => this.collab.session() }, dialogs.pulls);
        this.collab.onOpenPull = pull => void this.pulls.open(pull);
        this.contribute = new ContributeController(host, { session: () => this.collab.session(), refresh: () => void this.collab.refresh() }, dialogs.contribute);
        this.collab.onSend = () => void this.contribute.start();
        this.harness = new HarnessController(host, dialogs.harness);
        this.review = new HarnessReviewController(host, dialogs.review);
        this.harness.onReview = (file, card, board) => {
            const error = this.review.open(file, card, board);
            if (error) host.toast(error);
        };
        this.homePage = new HomeController(host);
        this.views = new ViewController(host, dialogs.views);
        this.notes = new NoteLinks(host);
        this.assistant = new AssistantController(host, {
            nameOf: doc => this.documents.nameOf(doc),
            canInsert: () => !this.views.structuredMode && !this.views.homeMode,
        });
        // The commit message writer uses the Assistant's key and model, read each time it starts.
        this.history = new HistoryController(host, dialogs.history, () => {
            const { chat } = this.assistant;
            return { keyStore: chat.keyStore, makeProvider: key => chat.makeProvider(key), model: () => chat.model };
        });
        this.search = new SearchController(host, dialogs.search);
        this.outline = new OutlineController(host);
        this.preferences = new PreferencesController(host, dialogs.preferences);
        this.documents = new DocumentController(Object.create(frontend.documents, {
            autosaver: { get: () => this.autosaver },
            refreshHome: { value: () => this.refreshHome() },
            root: { value: () => this.files.root },
            settings: { value: this.settings },
            createEditor: { value: (id: number) => frontend.createEditor(id) },
            toast: { value: (message: string, action?: ToastAction) => this.toast(message, action) },
            activated: { value: (id: number) => this.activated(id) },
            contentChanged: { value: (id: number) => this.contentChanged(id) },
            refreshTitle: { value: (id: number) => this.refreshTitle(id) },
            openFolder: { value: (path: string) => void this.openFolder(path) },
            fileSaved: { value: (path: string) => this.fileSaved(path) },
        }) as DocumentsHost<E>);
        this.stops.push(this.settings.onChanged(['autosave', 'recent-files'], key => {
            if (key === 'recent-files') this.refreshRecent();
            else if (this.settings.autosave) for (const doc of this.documents.all) this.autosaver.queue(doc);
        }));
    }

    // The members of the host that come from the controllers; read lazily, as the controllers are built after the host.
    private provided(): PropertyDescriptorMap {
        const get = (read: () => unknown) => ({ get: read });
        const value = (v: unknown) => ({ value: v });
        return {
            harness: get(() => this.harness),
            journal: get(() => this.journal),
            chat: get(() => this.assistant),
            homePage: get(() => this.homePage),
            workspace: get(() => this.workspace),
            active: value((): Doc<E> => this.documents.active),
            docs: value((): readonly Doc<E>[] => this.documents.all),
            openInTab: value((path: string) => this.documents.openInTab(path)),
            write: value((path: string, text: string) => this.documents.write(path, text)),
            fileMoved: value((doc: Doc<E>, path: string) => this.documents.fileMoved(doc, path)),
            fileGone: value((doc: Doc<E>) => this.documents.fileGone(doc)),
            fileBack: value((doc: Doc<E>, path: string) => this.documents.fileBack(doc, path)),
            newDocument: value((text: string) => this.documents.reset(this.documents.blank(), text)),
            showDocument: value(() => this.views.sync()),
            saveAll: value(() => this.documents.saveOpenFiles()),
            showChat: value(() => { this.settings.chat = true; }),
            boardShown: value((file: string) => this.views.boardMode && this.documents.active.file === file),
            updateBoardFile: value((file: string, edit: Parameters<ViewController<E>['updateBoardFile']>[1]) => this.views.updateBoardFile(file, edit)),
            record: value((kind: Parameters<JournalController['record']>[0], text: string) => this.journal.record(kind, text)),
            agentHost: value(() => this.harness.hostStatus()),
            runs: value(() => this.harness.orchestrator.queue.runs),
            journalSummary: value((root: string, date: string) => this.journal.summary(root, date)),
            refreshHome: value(() => this.refreshHome()),
            root: value(() => this.files.root),
            settings: get(() => this.settings),
            boardNow: value(() => this.views.currentBoard()),
            commitBoard: value((board: Board) => this.views.commitBoard(board)),
            toast: value((message: string, action?: ToastAction) => this.toast(message, action)),
            // A file or folder moved, renamed, or trashed in the Files tab: the open documents follow, then the frontend
            // highlights the active file again and re-reads its history.
            entryMoved: value((from: string, to: string) => { this.documents.filesMoved(from, to); this.host.filesMoved(); }),
            entryDeleted: value((path: string) => { this.documents.fileDeleted(path); this.host.filesMoved(); }),
            // After a delete or move: highlight the active file again and re-read its history.
            filesMoved: value(() => { this.files.reveal(this.documents.active.file); this.syncHistory(true); }),
            refreshTree: value(() => { if (this.files.root) this.files.refresh(this.files.root); }),
            openFile: value((path: string) => this.openFile(path)),
            projectName: value((path: string | null) => this.projectName(path)),
            isActive: value(() => this.focused),
            // The page these show is not a view of the active document; the view controller keeps that record.
            showPull: value(() => { this.views.otherPage(); this.frontend.host.showPull(); }),
            showReview: value(() => { this.views.otherPage(); this.frontend.host.showReview(); }),
            showRuns: value((file: string | null) => this.frontend.host.board.setRuns(file ? this.harness.runsOf(file) : [])),
        };
    }

    // A toast for the frontend. A button's action stays here; the frontend gets a token for it. Only the latest few are kept:
    // a toast is gone from the screen in seconds.
    private readonly toastActions = new Map<number, () => void>();
    private lastToast = 0;

    private toast(message: string, action?: ToastAction): void {
        let button: ToastButton | undefined;
        if (action) {
            const token = ++this.lastToast;
            this.toastActions.set(token, action.run);
            for (const old of [...this.toastActions.keys()].slice(0, -8)) this.toastActions.delete(old);
            button = { label: action.label, token };
        }
        this.frontend.host.toast(message, button);
    }

    // The user pressed the button of a toast; a token that is gone or was used does nothing.
    toastActivated(token: number): void {
        const run = this.toastActions.get(token);
        this.toastActions.delete(token);
        run?.();
    }

    // Open the tabs of the last session (or the first document) and start the documents.
    start(): void {
        this.documents.start();
    }

    // The host the commands of app/commands.ts run on: the core's part here, the frontend's part (its editor, its own
    // windows) from the frontend.
    commands(frontend: FrontendCommands): CommandHost {
        const docs = this.documents, views = this.views;
        const choose = this.frontend.documents.dialogs.chooseFile;
        const core: CoreCommands = {
            newDocument: () => docs.reset(docs.blank()),
            newBoardDocument: () => views.newBoard(),
            newInboxDocument: () => views.newInbox(),
            newTableDocument: () => views.newTable(),
            editFields: () => views.editFields(),
            sendChanges: () => void this.contribute.start(),
            closeTab: () => docs.closeTab(),
            switchTab: step => docs.switchTab(step),
            openHome: () => docs.openHome(),
            journal: this.journal,
            open: async () => {
                const path = await choose({ title: _('Open Markdown'), filters: ['markdown', 'all'] });
                if (path) docs.openInTab(path);
            },
            load: path => docs.load(path),
            chooseFolder: async () => {
                const path = await choose({ title: _('Open Folder'), selectFolder: true, folder: this.files.root });
                if (path) await this.openFolder(path);
            },
            save: () => docs.save(),
            saveAs: () => docs.saveAs(),
            exportHtml: () => docs.exportHtml(),
            insertImage: () => docs.insertImage(),
            toggleBoardView: on => views.toggle(on),
            setLayout: layout => views.setLayout(layout),
            // The settings are the core's; the frontend follows them (the dark style, the panels, the editor modes).
            setOption: (key, value) => {
                if (key === 'dark') this.settings.dark = value;
                else this.settings[key] = value;
            },
            showPreferences: () => this.preferences.open(),
        };
        return { ...core, edit: frontend.edit, openFind: replace => frontend.openFind(replace), showSearch: replace => frontend.showSearch(replace),
            setSource: on => frontend.setSource(on), showPalette: () => frontend.showPalette(), showShortcuts: () => frontend.showShortcuts(),
            showAbout: () => frontend.showAbout(), quit: () => frontend.quit() };
    }

    // ---------- What the frontend reports ----------

    private focused = false;                       // the window has the focus, as the frontend last reported
    private sidebarPage: SidebarPage | null = null;  // the side panel's page while it is open, null while it is closed
    private readonly stops: (() => void)[] = [];

    // What the window opens with: the folder from the command line or the last folder, then the file from the command line,
    // the tabs of the last session, the welcome text the first time, Home, or an empty document. Called once, after start().
    open(path: string | null): void {
        const isFolder = (p: string | null): p is string => !!p && platform().fs.isDirectory(p);
        if (isFolder(path)) void this.openFolder(path);
        else if (isFolder(this.settings.folder)) void this.openFolder(this.settings.folder, false);
        const { editor } = this.documents.active;
        if (path && !isFolder(path)) {
            this.documents.load(path);
        } else if (!path && this.documents.restoreTabs()) {
            // the last tabs are restored
        } else if (!this.settings.welcomed) {
            editor.setText(WELCOME);
            this.settings.welcomed = true;
        } else if (this.settings.home) {
            this.documents.openHome();
        } else {
            editor.setText('');
        }
        this.views.sync();
        this.refreshTitle(this.documents.active.id);
        this.refreshRecent();
        this.syncHistory();
        // Agents that kept working while Markwork was closed are found again once the window is up.
        this.stops.push(platform().scheduler.idle(() => { this.harness.reconnect(); return false; }));
    }

    // The user asked to close the window. true = it may close: every changed document was asked about, the agents that
    // are still working were dealt with, and the tabs are remembered for the next launch.
    closeRequest(): Awaitable<boolean> {
        return after(this.documents.confirmDiscardAll(), yes => yes ? after(this.harness.confirmClose(), go => {
            if (go) this.documents.rememberTabs();
            return go;
        }) : false);
    }

    // Show a folder in the Files tab and remember it to open again next time. Switching to another folder closes the tabs
    // of files outside it first (false = the user kept one, and the folder is not switched). show = false when restoring
    // the last folder, so a side panel that was closed on purpose does not appear.
    openFolder(path: string, show = true): Awaitable<boolean> {
        const absolute = platform().paths.resolve(path);
        const root = this.files.root;
        if (root && root !== absolute) return after(this.documents.closeOutside(absolute), yes => yes && this.applyFolder(absolute, show));
        return this.applyFolder(absolute, show);
    }

    private applyFolder(absolute: string, show: boolean): true {
        this.files.setRoot(absolute);
        this.workspace.warm(absolute);
        this.files.reveal(this.documents.active.file);
        this.syncHistory();
        this.pulls.folderChanged();
        void this.collab.setFolder(absolute);
        this.settings.folder = absolute;
        if (this.documents.active.home) this.refreshTitle(this.documents.active.id);
        this.refreshHome();
        if (show) {
            this.settings.sidebar = true;
            this.frontend.host.showSidebar('files');
        }
        return true;
    }

    // The window got or lost the focus. Coming back re-reads the history and Home: commits are usually made outside the
    // app, and files change outside it too (git pull, an agent, another editor).
    windowFocused(focused: boolean): void {
        this.focused = focused;
        if (!focused) return;
        this.syncHistory(true);
        this.refreshHome();
    }

    // The side panel opened at a page, switched pages, or closed (null).
    sidebarShown(page: SidebarPage | null): void {
        this.sidebarPage = page;
        this.syncHistory();
    }

    // The editor of document `id` changed its text (typing, undo, a write from here that landed).
    edited(id: number): void {
        const doc = this.docById(id);
        if (!doc) return;
        this.views.queueReload(doc);
        this.autosaver.edited(doc);
    }

    // The editor of document `id` has read its headings again.
    headingsChanged(id: number): void {
        const doc = this.docById(id);
        if (doc && doc === this.documents.active) this.outline.changed(doc);
    }

    // A link in document `id` was followed: a Markdown file opens in a tab, anything else in the app the system picks.
    // A relative link is read from the document's folder.
    openLink(id: number, url: string): void {
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            this.frontend.host.openUri(url);
            return;
        }
        const { paths } = platform();
        const bare = url.replace(/[#?].*$/, '');
        const path = paths.isAbsolute(bare) ? bare : paths.join(this.folderOf(id) ?? paths.homeDir(), decodeURI(bare));
        if (/\.(md|markdown|mdown|mkd)$/i.test(path) && this.documents.openInTab(path)) return;
        this.frontend.host.openUri(fileUri(path));
    }

    // The folder relative links and images of document `id` are read from; null when it has no file.
    folderOf(id: number): string | null {
        const file = this.docById(id)?.file;
        return file ? platform().paths.dirname(file) : null;
    }

    // Send the title of document `id` to the frontend.
    refreshTitle(id: number): void {
        const doc = this.docById(id);
        if (doc) this.frontend.documents.setTitle(id, this.titleOf(doc));
    }

    // ---------- What follows the documents ----------

    private docById(id: number): Doc<E> | undefined {
        return this.documents.all.find(d => d.id === id);
    }

    // The history is read only while its tab is shown, so git is not run needlessly. force = read again for the same file.
    private syncHistory(force = false): void {
        if (this.sidebarPage === 'history') this.history.show(this.documents.active.file, this.files.root, force);
    }

    // A document became the active one: the frontend's tabs follow first, then everything that shows the active document.
    private activated(id: number): void {
        const doc = this.docById(id);
        if (!doc) return;
        this.frontend.documents.activated(id);
        this.outline.show(doc);
        this.views.sync();
        this.refreshTitle(id);
        this.files.reveal(doc.file);
        this.syncHistory();
    }

    // The contents or the file of a document changed: it is shown as what it is now.
    private contentChanged(id: number): void {
        const doc = this.docById(id);
        if (!doc) return;
        this.views.replaced(doc);
        this.refreshTitle(id);
        this.files.reveal(doc.file);
        if (!doc.home) this.syncHistory();
    }

    // A new file was written through Save As: the tree shows it without waiting for the folder's monitor.
    private fileSaved(path: string): void {
        this.files.refresh(platform().paths.dirname(path));
        this.files.reveal(path);
        this.syncHistory();
    }

    // A file chosen in the Files tab: an image goes to the viewer, anything else to a tab.
    private openFile(path: string): void {
        if (isImageFile(path)) {
            this.frontend.host.showImage(path);
            return;
        }
        const active = this.documents.active;
        if (path === active.file) return;
        if (!this.documents.openInTab(path)) this.files.reveal(active.file);   // the highlight goes back to the file that is still open
    }

    private titleOf(doc: Doc<E>): DocumentTitle {
        const { paths } = platform();
        const name = this.documents.nameOf(doc);
        const root = this.files.root;
        if (doc.home) return { name, file: null, home: true, place: root ? paths.basename(root) : null };
        if (!doc.file) return { name, file: null, home: false, place: null };
        const dir = paths.dirname(doc.file), home = paths.homeDir();
        const below = insideName(home, dir);
        const place = dir === home ? '~' : below !== null ? `~/${below}` : dir;
        return { name, file: doc.file, home: false, place };
    }

    // A file's name in the work folder (the same as the name in workspace.ts), or its base name outside it; null if not saved.
    private projectName(path: string | null): string | null {
        const root = this.files.root;
        return path && (root && insideName(root, path) || platform().paths.basename(path));
    }

    // The Recent list of the menus: the last files that still exist.
    private refreshRecent(): void {
        const { fs } = platform();
        this.frontend.host.setRecent(this.settings.recentFiles.filter(r => fileExists(r.path) && !fs.isDirectory(r.path)).slice(0, 5).map(r => r.path));
    }

    // Redraw Home if it is shown; the data is recomputed from the files every time.
    refreshHome(): void {
        if (this.documents.active.home && this.views.homeMode) this.frontend.host.screen.showHome(this.homePage.data());
    }

    // Stop the timers and background work of the controllers (the frontend destroys its editors and widgets).
    dispose(): void {
        for (const stop of this.stops.splice(0)) stop();
        for (const doc of this.documents.all) this.autosaver.cancel(doc);
        this.assistant.dispose();
        this.history.dispose();
        this.harness.dispose();
        this.collab.dispose();
        this.preferences.dispose();
        this.files.dispose();
        this.workspace.close();
    }
}
