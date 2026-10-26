// The application session: builds the feature controllers of app/ and owns them, given one frontend. The frontend (the
// Electron window, over the app protocol) supplies what only it can: the views the controllers draw on, the dialogs they ask with, and the
// hooks for what must follow a document on screen. Everything that connects the controllers to each other lives here,
// so a frontend implements AppFrontend and gets the application, not a copy of the wiring.

import type { AppSettings, SidebarPage } from '../base/settings.js';
import { WorkspaceRepository } from '../base/workspace.js';
import { fileUri, insideName } from '../base/files.js';
import { platform } from '../platform/index.js';
import { WELCOME } from '../base/welcome.js';
import { Autosaver, type AutosaveHost } from './autosave.js';
import { CollabController, type CollabDialogs, type CollabHost } from './collab.js';
import { ContributeController, type ContributeDialogs, type ContributeHost } from './contribute.js';
import { PullReviewController, type PullDialogs, type PullHost } from './pulls.js';
import { JournalController, type JournalDialogs, type JournalHost } from './journal.js';
import { HarnessController, type HarnessDialogs, type HarnessHost } from './harness.js';
import type { Openers } from '../orchestrator/hub.js';
import { HarnessReviewController, type ReviewDialogs, type ReviewHost } from './harnessreview.js';
import { HomeController, existingRecent, type HomeHost } from './home.js';
import { ProgramsController } from './programs.js';
import { ViewController, type ViewDialogs, type ViewHost } from './views.js';
import { NoteLinks, type NoteHost } from './notes.js';
import { DocumentController, type DocumentsHost } from './documents.js';
import type { AgentWriteHost } from './agentwrites.js';
import { AssistantController, type AssistantHost } from './assistant.js';
import { HistoryController, type HistoryDialogs, type HistoryHost } from './history.js';
import { PreferencesController, type PreferencesDialogs, type PreferencesHost } from './preferences.js';
import { OutlineController, type OutlineHost } from './outline.js';
import { FilesController, isHtmlFile, isImageFile, type FilesDialogs, type FilesHost } from './files.js';
import { SearchController, type SearchDialogs, type SearchHost } from './search.js';
import type { Board } from '../markdown/kanban.js';
import type { Doc, Page, TextEditor, ToastAction, ToastButton } from './document.js';
import type { CommandHost, CoreCommands, FrontendCommands } from './commands.js';
import { _ } from '../base/i18n.js';

// The host the controllers see, put together: each controller is typed with only the part it needs.
export type ControllerHost<E extends TextEditor> = AutosaveHost & JournalHost & HarnessHost & HomeHost & AgentWriteHost<E> & ViewHost<E>
    & NoteHost & CollabHost & PullHost & ContributeHost & ReviewHost & AssistantHost<E> & HistoryHost<E> & FilesHost & SearchHost<E> & OutlineHost<E> & PreferencesHost;

// What the session answers itself, from the controllers it owns.
type SessionProvided = 'harness' | 'journal' | 'homePage' | 'programsPage' | 'setup' | 'workspace' | 'active' | 'page' | 'docs' | 'openInTab' | 'write' | 'fileMoved' | 'fileGone'
    | 'fileBack' | 'newDocument' | 'showDocument' | 'saveAll' | 'showChat' | 'boardShown' | 'updateBoardFile' | 'record' | 'agentHost' | 'runs'
    | 'journalSummary' | 'refreshHome' | 'chat' | 'root' | 'entryMoved' | 'entryDeleted' | 'settings' | 'toast' | 'boardNow' | 'commitBoard'
    | 'openFile' | 'projectName' | 'isActive' | 'refreshTree' | 'filesMoved' | 'showPull' | 'showReview' | 'showRuns';

// How a document's tab and the window are titled. The frontend adds its own mark for unsaved changes, since its editor
// knows them first.
export interface DocumentTitle {
    name: string;
    file: string | null;
    page: boolean;           // the tab is a page (Home, an HTML file), not a document: it has nothing to save
    place: string | null;    // Home: the work folder's name; a file or an HTML page: its folder, `~` for the home folder; null: the app's name
}

// The views, notices, and system services of the frontend: the host members that are not another controller. A toast
// button reaches it as a token, which it gives back to AppSession.toastActivated when the user presses the button.
export type FrontendHost<E extends TextEditor> = Omit<ControllerHost<E>, SessionProvided> & {
    toast(message: string, action?: ToastButton): void;
    showSidebar(page: SidebarPage): void;   // open the side panel at a page (a folder was opened: the Files tab)
    showImage(path: string): void;          // an image chosen in the Files tab: the frontend's viewer
    setRecent(paths: string[]): void;       // the Recent list of the menus: files that still exist, latest first
    setProgramsMissing(count: number): void;   // how many needed programs are missing: the mark on the sidebar's Programs
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
    // The editor of a new document. Over the protocol the core makes it itself: a replica of the frontend's text.
    createEditor(id: number): E;
    readonly dialogs: AppDialogs;
    // How links to the agents' daemons are made; tests give a stand-in so no ssh is ever started.
    readonly openers?: Openers;
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
    readonly programs: ProgramsController;
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
        this.harness = new HarnessController(host, dialogs.harness, frontend.openers);
        this.review = new HarnessReviewController(host, dialogs.review, this.collab.services);
        this.harness.onReview = (file, card, board) => {
            const error = this.review.open(file, card, board);
            if (error) host.toast(error);
        };
        this.homePage = new HomeController(host);
        this.programs = new ProgramsController({
            settings: this.settings,
            connection: machine => this.harness.hub.connection(machine),
            machineState: machine => this.harness.hub.state(machine),
            refresh: () => { this.refreshHome(); this.refreshPrograms(); frontend.host.setProgramsMissing(this.programs.missingCount); },
            openUri: uri => frontend.host.openUri(uri),
            toast: message => this.toast(message),
        });
        this.views = new ViewController(host, dialogs.views);
        this.notes = new NoteLinks(host);
        this.assistant = new AssistantController(host, {
            nameOf: doc => this.documents.nameOf(doc),
            canInsert: () => !this.views.structuredMode && !this.views.pageMode,
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
            pageActivated: { value: (id: number) => this.pageActivated(id) },
            contentChanged: { value: (id: number) => this.contentChanged(id) },
            refreshTitle: { value: (id: number) => this.refreshTitle(id) },
            openFolder: { value: (path: string) => void this.openFolder(path) },
            fileSaved: { value: (path: string) => this.fileSaved(path) },
        }) as DocumentsHost<E>);
        // Where agents run decides what is needed, and on an SSH machine where pi and git are looked for.
        this.stops.push(this.settings.onChanged(['harness-machine', 'machines', 'machine-projects'], () => {
            if (this.programs.wasChecked) void this.programs.check();
        }));
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
            programsPage: get(() => this.programs),
            setup: value(() => this.programs.setup()),
            workspace: get(() => this.workspace),
            active: value((): Doc<E> => this.documents.active),
            page: value((): Page | null => this.documents.page),
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
            filesMoved: value(() => { this.files.reveal(this.shownFile()); this.syncHistory(true); }),
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
            newCsvTable: () => {
                const root = this.files.root;
                if (root) void this.files.create('csv', root);
                else this.toast(_('Open a folder first: a CSV table is a file in the work folder'));
            },
            editFields: () => views.editFields(),
            sendChanges: () => void this.contribute.start(),
            closeTab: () => docs.closeTab(),
            closeAllTabs: () => docs.closeMany(),
            switchTab: step => docs.switchTab(step),
            openHome: () => docs.openHome(),
            openPrograms: () => docs.openPrograms(),
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
            setSource: on => frontend.setSource(on), splitPane: side => frontend.splitPane(side), closePane: () => frontend.closePane(), moveToNextPane: () => frontend.moveToNextPane(),
            showPalette: () => frontend.showPalette(), showShortcuts: () => frontend.showShortcuts(), showAbout: () => frontend.showAbout(), showReport: () => frontend.showReport(), quit: () => frontend.quit() };
    }

    // ---------- What the frontend reports ----------

    private focused = false;                       // the window has the focus, as the frontend last reported
    private sidebarPage: SidebarPage | null = null;  // the side panel's page while it is open, null while it is closed
    private timeline = false;                        // the Files view shows its Timeline section (the history of the open file)
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
        this.refreshTitle((this.documents.page ?? this.documents.active).id);
        this.refreshRecent();
        if (!this.programs.wasChecked) void this.programs.check();   // the sidebar's mark, before Home or the page asks
        this.syncHistory();
        // Agents that kept working while Markwork was closed are found again once the window is up.
        this.stops.push(platform().scheduler.idle(() => { this.harness.reconnect(); return false; }));
    }

    // The user asked to close the window. true = it may close: every changed document was asked about, the agents that
    // are still working were dealt with, and the tabs are remembered for the next launch.
    async closeRequest(): Promise<boolean> {
        if (!await this.documents.confirmDiscardAll()) return false;
        const go = await this.harness.confirmClose();
        if (go) this.documents.rememberTabs();
        return go;
    }

    // Show a folder in the Files tab and remember it to open again next time. Switching to another folder closes the tabs
    // of files outside it first (false = the user kept one, and the folder is not switched). show = false when restoring
    // the last folder, so a side panel that was closed on purpose does not appear.
    async openFolder(path: string, show = true): Promise<boolean> {
        const absolute = platform().paths.resolve(path);
        const root = this.files.root;
        if (root && root !== absolute && !await this.documents.closeOutside(absolute)) return false;
        return this.applyFolder(absolute, show);
    }

    private applyFolder(absolute: string, show: boolean): true {
        this.settings.useWorkspace(absolute);
        this.files.setRoot(absolute);
        this.refreshRecent();
        this.workspace.warm(absolute);
        this.files.reveal(this.shownFile());
        this.syncHistory();
        this.pulls.folderChanged();
        void this.collab.setFolder(absolute);
        this.settings.folder = absolute;
        this.harness.folderChanged();
        const page = this.documents.page;
        if (page?.kind === 'home') this.refreshTitle(page.id);
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
        this.programs.recheckMissing();
    }

    // The side panel opened at a page, switched pages, or closed (null); `timeline` says its Files view shows the Timeline.
    sidebarShown(page: SidebarPage | null, timeline = false): void {
        this.sidebarPage = page;
        this.timeline = timeline;
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
        if (doc) {
            this.frontend.documents.setTitle(id, this.titleOf(doc));
            return;
        }
        const page = this.documents.allPages.find(p => p.id === id);
        if (page) this.frontend.documents.setTitle(id, this.titleOfPage(page));
    }

    // ---------- What follows the documents ----------

    private docById(id: number): Doc<E> | undefined {
        return this.documents.all.find(d => d.id === id);
    }

    // The history is read only while it is shown (its page, or the Files view's Timeline), so git is not run needlessly.
    // force = read again for the same file.
    private syncHistory(force = false): void {
        if (this.sidebarPage === 'history' || (this.sidebarPage === 'files' && this.timeline)) this.history.show(this.shownFile(), this.files.root, force);
    }

    // The file the active tab is about: the document's, an HTML page's, none for Home. The tree and the history follow it.
    private shownFile(): string | null {
        const page = this.documents.page;
        return page ? page.file : this.documents.active.file;
    }

    // A page became the shown tab: the frontend's tabs and content follow, and what follows a document is cleared.
    private pageActivated(id: number): void {
        const page = this.documents.allPages.find(p => p.id === id);
        if (!page) return;
        this.frontend.documents.pageActivated(id);
        this.outline.clear();
        this.views.sync();
        this.refreshTitle(id);
        this.files.reveal(page.file);
        this.syncHistory();
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
        this.syncHistory();
    }

    // A new file was written through Save As: the tree shows it without waiting for the folder's monitor.
    private fileSaved(path: string): void {
        this.files.refresh(platform().paths.dirname(path));
        this.files.reveal(path);
        this.syncHistory();
    }

    // A file chosen in the Files tab: an image or an HTML page goes to its viewer, anything else to a tab.
    private openFile(path: string): void {
        if (isImageFile(path)) {
            this.frontend.host.showImage(path);
            return;
        }
        if (isHtmlFile(path)) {
            this.documents.openHtml(path, this.files.root);
            return;
        }
        const active = this.documents.active;
        if (active.file !== null && platform().paths.same(path, active.file)) return;
        if (!this.documents.openInTab(path)) this.files.reveal(active.file);   // the highlight goes back to the file that is still open
    }

    private titleOf(doc: Doc<E>): DocumentTitle {
        const name = this.documents.nameOf(doc);
        if (!doc.file) return { name, file: null, page: false, place: null };
        return { name, file: doc.file, page: false, place: this.placeOf(doc.file) };
    }

    private titleOfPage(page: Page): DocumentTitle {
        const name = this.documents.nameOfPage(page);
        if (!page.file) {
            const root = this.files.root;
            return { name, file: null, page: true, place: root ? platform().paths.basename(root) : null };
        }
        return { name, file: page.file, page: true, place: this.placeOf(page.file) };
    }

    // Where a file is, for a title: its folder, `~` for the home folder.
    private placeOf(file: string): string {
        const { paths } = platform();
        const dir = paths.dirname(file), home = paths.homeDir();
        const below = insideName(home, dir);
        return dir === home ? '~' : below !== null ? `~/${below}` : dir;
    }

    // A file's name in the work folder (the same as the name in base/workspace.ts), or its base name outside it; null if not saved.
    private projectName(path: string | null): string | null {
        const root = this.files.root;
        return path && (root && insideName(root, path) || platform().paths.basename(path));
    }

    // The Recent list of the menus: the last files that still exist.
    private refreshRecent(): void {
        this.frontend.host.setRecent(existingRecent(this.settings.recentFiles, this.files.root).slice(0, 5).map(r => r.path));
    }

    // Redraw Home if it is shown; the data is recomputed from the files every time.
    refreshHome(): void {
        if (this.documents.page?.kind === 'home' && this.views.homeMode) this.frontend.host.screen.showHome(this.homePage.data());
    }

    // Redraw the Programs page if it is shown.
    refreshPrograms(): void {
        if (this.documents.page?.kind === 'programs' && this.views.programsMode) this.frontend.host.screen.showPrograms(this.programs.data());
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
