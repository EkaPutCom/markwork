import { FolderDiskController } from './folderdisk';
import { AgentFoldersController } from './agentfolders';
import type { FolderAgentView } from './folderpanel';
// Builds and owns the feature controllers for one frontend. The Electron
// window supplies views, dialogs, and hooks through the app protocol.
// Controller wiring lives here, so each AppFrontend gets the application
// rather than a copy of its wiring.

import type { AppSettings, SidebarPage } from '../base/settings';
import { WorkspaceRepository } from '../base/workspace';
import { fileUri, insideName } from '../base/files';
import { platform } from '../platform/index';
import { WELCOME } from '../base/welcome';
import { Autosaver, type AutosaveHost } from './autosave';
import {
    CollabController,
    type CollabDialogs,
    type CollabHost,
} from './collab';
import {
    ContributeController,
    type ContributeDialogs,
    type ContributeHost,
} from './contribute';
import { PullReviewController, type PullDialogs, type PullHost } from './pulls';
import {
    JournalController,
    type JournalDialogs,
    type JournalHost,
} from './journal';
import {
    HarnessController,
    type HarnessDialogs,
    type HarnessHost,
} from './harness';
import type { Openers } from '../orchestrator/hub';
import {
    HarnessReviewController,
    type ReviewDialogs,
    type ReviewHost,
} from './harnessreview';
import { HomeController, existingRecent, type HomeHost } from './home';
import { ProgramsController } from './programs';
import { ViewController, type ViewDialogs, type ViewHost } from './views';
import { NoteLinks, type NoteHost } from './notes';
import { DocumentController, type DocumentsHost } from './documents';
import type { AgentWriteHost } from './agentwrites';
import type { AssistantHost } from './assistant';
import { PiAssistantController } from './assistantpi';
import { systemKeyStore } from '../agent/apikey';
import { DeepSeek } from '../agent/deepseek';
import type { WriterSources } from './history';
import {
    HistoryController,
    type HistoryDialogs,
    type HistoryHost,
} from './history';
import {
    PreferencesController,
    type PreferencesDialogs,
    type PreferencesHost,
} from './preferences';
import { OutlineController, type OutlineHost } from './outline';
import {
    FilesController,
    isHtmlFile,
    isImageFile,
    isMarkdownFile,
    isCsvFile,
    type FilesDialogs,
    type FilesHost,
} from './files';
import {
    SearchController,
    type SearchDialogs,
    type SearchHost,
} from './search';
import type { Board } from '../markdown/kanban';
import type {
    Doc,
    Page,
    TextEditor,
    ToastAction,
    ToastButton,
} from './document';
import type { CommandHost, CoreCommands, FrontendCommands } from './commands';
import { _ } from '../base/i18n';

// Each controller is typed with only the host members it needs.
export type ControllerHost<E extends TextEditor> = AutosaveHost &
    JournalHost &
    HarnessHost &
    HomeHost &
    AgentWriteHost<E> &
    ViewHost<E> &
    NoteHost &
    CollabHost &
    PullHost &
    ContributeHost &
    ReviewHost &
    AssistantHost<E> &
    HistoryHost<E> &
    FilesHost &
    SearchHost<E> &
    OutlineHost<E> &
    PreferencesHost;

// What the session answers itself, from the controllers it owns.
type SessionProvided =
    | 'harness'
    | 'journal'
    | 'homePage'
    | 'programsPage'
    | 'setup'
    | 'workspace'
    | 'active'
    | 'page'
    | 'docs'
    | 'openInTab'
    | 'write'
    | 'fileMoved'
    | 'fileGone'
    | 'fileBack'
    | 'newDocument'
    | 'showDocument'
    | 'saveAll'
    | 'showChat'
    | 'boardShown'
    | 'updateBoardFile'
    | 'record'
    | 'agentHost'
    | 'runs'
    | 'journalSummary'
    | 'refreshHome'
    | 'chat'
    | 'root'
    | 'entryMoved'
    | 'entryDeleted'
    | 'settings'
    | 'toast'
    | 'boardNow'
    | 'commitBoard'
    | 'canSaveDocument'
    | 'newAgent'
    | 'openFile'
    | 'projectName'
    | 'isActive'
    | 'refreshTree'
    | 'filesMoved'
    | 'showPull'
    | 'showReview'
    | 'showRuns';

// The frontend adds its own unsaved mark to tab and window titles: its editor
// knows them first.
export interface DocumentTitle {
    name: string;
    file: string | null;
    // Pages (Home, HTML) have nothing to save.
    page: boolean;
    // Home: workspace name. Files: folder, or `~`. Null: the app's name.
    place: string | null;
}

// Frontend views, notices, and system services, excluding other controllers.
// Toast buttons carry tokens returned to AppSession.toastActivated on a press.
export type FrontendHost<E extends TextEditor> = Omit<
    ControllerHost<E>,
    SessionProvided
> & {
    toast(message: string, action?: ToastButton): void;
    // Opening a folder selects the Files tab.
    showSidebar(page: SidebarPage): void;
    // Images chosen in Files use the frontend's viewer.
    showImage(path: string): void;
    // Existing files, latest first, for the Recent menus.
    setRecent(paths: string[]): void;
    // Missing programs count for the sidebar mark.
    setProgramsMissing(count: number): void;
    showPull(): void; // the content area shows the pull request page
    showReview(): void; // the content area shows the review page
};

// The frontend follows tab changes; the session owns other document effects.
export type FrontendDocuments<E extends TextEditor> = Omit<
    DocumentsHost<E>,
    | 'autosaver'
    | 'refreshHome'
    | 'root'
    | 'settings'
    | 'toast'
    | 'canSaveDocument'
    | 'createEditor'
    | 'contentChanged'
    | 'refreshTitle'
    | 'openFolder'
    | 'openConversation'
    | 'fileSaved'
> & {
    setTitle(id: number, title: DocumentTitle): void;
};

// Dialogs answer with values or Promises; tests replace them.
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
    readonly folderAgents?: FolderAgentView;
    // Core-owned settings: the frontend gets the store, not a view.
    // See docs/design/protocol.md 9.2.
    readonly settings: AppSettings;
    readonly host: FrontendHost<E>;
    readonly documents: FrontendDocuments<E>;
    // Over the protocol, the core creates a replica of the frontend's text.
    createEditor(id: number): E;
    readonly dialogs: AppDialogs;
    // Tests replace daemon links so no SSH process is started.
    readonly openers?: Openers;
}

export class AppSession<E extends TextEditor> {
    readonly settings: AppSettings;
    // Workspace Markdown files; unsaved documents are read from their editor.
    readonly workspace = new WorkspaceRepository(
        () =>
            new Map(
                this.documents.all
                    .filter((d) => d.file && d.editor.isModified())
                    .map((d) => [d.file!, d.editor.getText()])
            )
    );
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
    readonly assistant: PiAssistantController<E>;
    readonly commitWriter: WriterSources = {
        keyStore: systemKeyStore,
        makeProvider: (key) => new DeepSeek(key),
        model: () => this.settings.chatModel,
    };
    readonly agentFolders: AgentFoldersController<E>;
    readonly folderDisk: FolderDiskController<E>;
    private opened = false;
    readonly history: HistoryController<E>;
    // Created first: other controllers ask Files for the work folder.
    readonly files: FilesController;
    readonly search: SearchController<E>;
    readonly outline: OutlineController<E>;
    readonly preferences: PreferencesController;
    readonly host: ControllerHost<E>;

    constructor(private readonly frontend: AppFrontend<E>) {
        this.settings = frontend.settings;
        // The prototype preserves the frontend's getters.
        this.host = Object.create(
            frontend.host,
            this.provided()
        ) as ControllerHost<E>;
        const { host } = this;
        const { dialogs } = frontend;

        // Controllers precede documents, whose buffers queue autosaves.
        this.files = new FilesController(host, dialogs.files);
        this.autosaver = new Autosaver(host);
        this.folderDisk = new FolderDiskController(host, () => {
            this.agentFolders?.refresh();
            this.assistant?.refresh();
        });
        this.journal = new JournalController(host, dialogs.journal);
        this.collab = new CollabController(host, dialogs.collab);
        this.pulls = new PullReviewController(
            host,
            {
                provider: () => this.collab.provider(),
                changed: () => void this.collab.refresh(),
                session: () => this.collab.session(),
            },
            dialogs.pulls
        );
        this.collab.onOpenPull = (pull) => void this.pulls.open(pull);
        this.contribute = new ContributeController(
            host,
            {
                session: () => this.collab.session(),
                refresh: () => void this.collab.refresh(),
            },
            dialogs.contribute
        );
        this.collab.onSend = () => void this.contribute.start();
        this.harness = new HarnessController(
            host,
            dialogs.harness,
            frontend.openers
        );
        this.review = new HarnessReviewController(
            host,
            dialogs.review,
            this.collab.services
        );
        this.harness.onReview = (file, card, board) => {
            const error = this.review.open(file, card, board);
            if (error) host.toast(error);
        };
        this.homePage = new HomeController(host);
        this.programs = new ProgramsController({
            settings: this.settings,
            connection: (machine) => this.harness.hub.connection(machine),
            machineState: (machine) => this.harness.hub.state(machine),
            refresh: () => {
                this.refreshHome();
                this.refreshPrograms();
                frontend.host.setProgramsMissing(this.programs.missingCount);
            },
            openUri: (uri) => frontend.host.openUri(uri),
            toast: (message) => this.toast(message),
        });
        this.views = new ViewController(host, dialogs.views);
        this.notes = new NoteLinks(host);
        this.assistant = new PiAssistantController(host, dialogs.files, {
            changed: (root) => {
                this.folderDisk.start(root);
                this.files.refresh(root);
                this.files.refreshAgent(root, root);
            },
            conflicts: (root) => this.folderDisk.conflicts(root),
            resolve: (path, choice) => this.folderDisk.resolve(path, choice),
        });
        // The read-only DeepSeek commit writer is separate from chat.
        this.history = new HistoryController(
            host,
            dialogs.history,
            () => this.commitWriter
        );
        this.search = new SearchController(host, dialogs.search);
        this.outline = new OutlineController(host);
        this.preferences = new PreferencesController(host, dialogs.preferences);
        this.documents = new DocumentController(
            Object.create(frontend.documents, {
                autosaver: { get: () => this.autosaver },
                canSaveDocument: {
                    value: (doc: Doc<E>) => this.folderDisk.canSave(doc),
                },
                refreshHome: { value: () => this.refreshHome() },
                root: { value: () => this.files.root },
                settings: { value: this.settings },
                createEditor: {
                    value: (id: number) => frontend.createEditor(id),
                },
                toast: {
                    value: (message: string, action?: ToastAction) =>
                        this.toast(message, action),
                },
                activated: { value: (id: number) => this.activated(id) },
                pageActivated: {
                    value: (id: number) => this.pageActivated(id),
                },
                contentChanged: {
                    value: (id: number) => this.contentChanged(id),
                },
                refreshTitle: { value: (id: number) => this.refreshTitle(id) },
                openFolder: {
                    value: (path: string) => void this.openFolder(path),
                },
                openConversation: {
                    value: (path: string, text: string) =>
                        this.agentFolders.openFile(path, text),
                },
                fileSaved: { value: (path: string) => this.fileSaved(path) },
            }) as DocumentsHost<E>
        );
        this.agentFolders = new AgentFoldersController(
            host,
            frontend.folderAgents ?? {
                show: () => {},
                event: () => {},
                review: async () => ({ note: '' }),
                cancelReview: () => {},
            },
            {
                open: (root, id, title) =>
                    this.documents.openAgent(root, id, title),
                rename: (id, title) => this.documents.renameAgent(id, title),
                diskChanged: (root) => {
                    const workspace = this.files.root;
                    if (
                        !workspace ||
                        (!platform().paths.same(root, workspace) &&
                            insideName(workspace, root) === null)
                    )
                        return;
                    this.folderDisk.start(root);
                    this.files.refresh(workspace);
                    this.files.refreshAgent(root);
                },
                conflicts: (root) => this.folderDisk.conflicts(root),
                resolve: (path, choice) =>
                    this.folderDisk.resolve(path, choice),
                reset: () => this.folderDisk.dispose(),
            },
            dialogs.files,
            frontend.openers
        );
        // Agent locations decide requirements and where to find pi and git.
        this.stops.push(
            this.settings.onChanged(
                ['harness-machine', 'machines', 'machine-projects'],
                () => {
                    if (this.programs.wasChecked) void this.programs.check();
                }
            )
        );
        this.stops.push(
            this.settings.onChanged(['autosave', 'recent-files'], (key) => {
                if (key === 'recent-files') this.refreshRecent();
                else if (this.settings.autosave)
                    for (const doc of this.documents.all)
                        this.autosaver.queue(doc);
            })
        );
    }

    // Read lazily: controllers are created after the host.
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
            canSaveDocument: value((doc: Doc<E>) =>
                this.folderDisk.canSave(doc)
            ),
            openInTab: value((path: string) => this.documents.openInTab(path)),
            write: value((path: string, text: string) =>
                this.documents.write(path, text)
            ),
            fileMoved: value((doc: Doc<E>, path: string) =>
                this.documents.fileMoved(doc, path)
            ),
            fileGone: value((doc: Doc<E>) => this.documents.fileGone(doc)),
            fileBack: value((doc: Doc<E>, path: string) =>
                this.documents.fileBack(doc, path)
            ),
            newDocument: value((text: string) =>
                this.documents.reset(this.documents.blank(), text)
            ),
            showDocument: value(() => this.views.sync()),
            saveAll: value(() => this.documents.saveOpenFiles()),
            showChat: value(() => {
                this.settings.chat = true;
            }),
            boardShown: value(
                (file: string) =>
                    this.views.boardMode && this.documents.active.file === file
            ),
            updateBoardFile: value(
                (
                    file: string,
                    edit: Parameters<ViewController<E>['updateBoardFile']>[1]
                ) => this.views.updateBoardFile(file, edit)
            ),
            record: value(
                (
                    kind: Parameters<JournalController['record']>[0],
                    text: string
                ) => this.journal.record(kind, text)
            ),
            agentHost: value(() => this.harness.hostStatus()),
            runs: value(() => this.harness.orchestrator.queue.runs),
            journalSummary: value((root: string, date: string) =>
                this.journal.summary(root, date)
            ),
            refreshHome: value(() => this.refreshHome()),
            root: value(() => this.files.root),
            settings: get(() => this.settings),
            boardNow: value(() => this.views.currentBoard()),
            commitBoard: value((board: Board) => this.views.commitBoard(board)),
            toast: value((message: string, action?: ToastAction) =>
                this.toast(message, action)
            ),
            // Open documents follow Files moves, renames, and deletions.
            // Then the frontend restores the highlight and history.
            entryMoved: value((from: string, to: string) => {
                this.documents.filesMoved(from, to);
                this.host.filesMoved();
            }),
            entryDeleted: value((path: string) => {
                this.documents.fileDeleted(path);
                this.host.filesMoved();
            }),
            // Restore the active highlight and history after a delete/move.
            filesMoved: value(() => {
                this.files.reveal(this.shownFile());
                this.syncHistory(true);
            }),
            refreshTree: value(() => {
                if (this.files.root) this.files.refresh(this.files.root);
            }),
            newAgent: value((parent: string) =>
                this.agentFolders.create(parent, this.frontend.dialogs.files)
            ),
            openFile: value((path: string) => this.openFile(path)),
            projectName: value((path: string | null) => this.projectName(path)),
            isActive: value(() => this.focused),
            // Views tracks that these pages are not the active document.
            showPull: value(() => {
                this.views.otherPage();
                this.frontend.host.showPull();
            }),
            showReview: value(() => {
                this.views.otherPage();
                this.frontend.host.showReview();
            }),
            showRuns: value((file: string | null) =>
                this.frontend.host.board.setRuns(
                    file ? this.harness.runsOf(file) : []
                )
            ),
        };
    }

    // Toast actions stay here; the frontend receives tokens. Keep only a few:
    // a toast is gone from the screen in seconds.
    private readonly toastActions = new Map<number, () => void>();
    private lastToast = 0;

    private toast(message: string, action?: ToastAction): void {
        let button: ToastButton | undefined;
        if (action) {
            const token = ++this.lastToast;
            this.toastActions.set(token, action.run);
            for (const old of [...this.toastActions.keys()].slice(0, -8))
                this.toastActions.delete(old);
            button = { label: action.label, token };
        }
        this.frontend.host.toast(message, button);
    }

    // Expired or already-used toast tokens do nothing.
    toastActivated(token: number): void {
        const run = this.toastActions.get(token);
        this.toastActions.delete(token);
        run?.();
    }

    // Restore the last session's tabs (or start the first document).
    start(): void {
        this.documents.start();
    }

    // Commands combine core actions with frontend editor/window actions.
    commands(frontend: FrontendCommands): CommandHost {
        const docs = this.documents,
            views = this.views;
        const choose = this.frontend.documents.dialogs.chooseFile;
        const core: CoreCommands = {
            newDocument: () => docs.reset(docs.blank()),
            newBoardDocument: () => views.newBoard(),
            newAgent: () => {
                void this.newAgent();
            },
            newInboxDocument: () => views.newInbox(),
            newTableDocument: () => views.newTable(),
            newCsvTable: () => {
                const root = this.files.root;
                if (root) void this.files.create('csv', root);
                else
                    this.toast(
                        _(
                            'Open a folder first: a CSV table is a file ' +
                                'in the work folder'
                        )
                    );
            },
            editFields: () => views.editFields(),
            sendChanges: () => void this.contribute.start(),
            closeTab: () => docs.closeTab(),
            closeAllTabs: () => docs.closeMany(),
            switchTab: (step) => docs.switchTab(step),
            openHome: () => docs.openHome(),
            openPrograms: () => docs.openPrograms(),
            journal: this.journal,
            open: async () => {
                const path = await choose({
                    title: _('Open Markdown'),
                    filters: ['markdown', 'all'],
                });
                if (path) docs.openInTab(path);
            },
            load: (path) => docs.load(path),
            chooseFolder: async () => {
                const path = await choose({
                    title: _('Open Folder'),
                    selectFolder: true,
                    folder: this.files.root,
                });
                if (path) await this.openFolder(path);
            },
            save: () => docs.save(),
            saveAs: () => docs.saveAs(),
            exportHtml: () => docs.exportHtml(),
            insertImage: () => docs.insertImage(),
            toggleBoardView: (on) => views.toggle(on),
            setLayout: (layout) => views.setLayout(layout),
            // The frontend follows core-owned theme, panel, and mode settings.
            setOption: (key, value) => {
                if (key === 'dark') this.settings.dark = value;
                else this.settings[key] = value;
            },
            showPreferences: () => this.preferences.open(),
        };
        return {
            ...core,
            edit: frontend.edit,
            openFind: (replace) => frontend.openFind(replace),
            showSearch: (replace) => frontend.showSearch(replace),
            setSource: (on) => frontend.setSource(on),
            splitPane: (side) => frontend.splitPane(side),
            closePane: () => frontend.closePane(),
            moveToNextPane: () => frontend.moveToNextPane(),
            showPalette: () => frontend.showPalette(),
            showShortcuts: () => frontend.showShortcuts(),
            showAbout: () => frontend.showAbout(),
            showReport: () => frontend.showReport(),
            quit: () => frontend.quit(),
        };
    }

    // ---------- What the frontend reports ----------

    // Last focus state reported by the frontend.
    private focused = false;
    // Null while the side panel is closed.
    private sidebarPage: SidebarPage | null = null;
    // Files shows the open file's history in its Timeline section.
    private timeline = false;
    private readonly stops: (() => void)[] = [];

    // Open the command-line or last folder, then the command-line file,
    // restored tabs, first-run welcome, Home, or a blank document.
    // Called once, after start().
    open(path: string | null): void {
        const isFolder = (p: string | null): p is string =>
            !!p && platform().fs.isDirectory(p);
        if (isFolder(path)) void this.openFolder(path);
        else if (isFolder(this.settings.folder))
            void this.openFolder(this.settings.folder, false);
        const { editor } = this.documents.active;
        if (path && !isFolder(path)) {
            this.documents.load(path);
        } else if (!path && this.documents.restoreTabs()) {
            // the last tabs are restored
        } else if (this.agentFolders.state().root) {
            this.openAgentDefault();
        } else if (!this.settings.welcomed) {
            editor.setText(WELCOME);
            this.settings.welcomed = true;
        } else if (this.settings.home) {
            this.documents.openHome();
        } else {
            editor.setText('');
        }
        this.opened = true;
        this.views.sync();
        this.refreshTitle((this.documents.page ?? this.documents.active).id);
        this.refreshRecent();
        // Set the sidebar mark before Home or Programs asks for it.
        if (!this.programs.wasChecked) void this.programs.check();
        this.syncHistory();
        // Reconnect background agents once the window is up.
        this.stops.push(
            platform().scheduler.idle(() => {
                this.harness.reconnect();
                return false;
            })
        );
    }

    // Closing requires document confirmation and handling running agents.
    // Remember tabs for the next launch only when closing is allowed.
    async closeRequest(): Promise<boolean> {
        if (!(await this.documents.confirmDiscardAll())) return false;
        if (this.assistant.busy) {
            if (
                !(await this.frontend.dialogs.files.confirm(
                    'Stop pi Assistant and close?',
                    'Local pi work stops when Markwork closes. ' +
                        'Completed file and shell effects cannot be undone.',
                    'Stop Assistant and close',
                    false
                ))
            )
                return false;
            await this.assistant.shutdown();
        }
        let keepFolders = false;
        if (this.agentFolders.busy) {
            const choice = await this.frontend.dialogs.harness.closeAgents(
                this.agentFolders.activity()
            );
            if (choice === 'cancel') return false;
            keepFolders = choice !== 'stop';
        }
        const go = await this.harness.confirmClose();
        if (go) {
            this.documents.rememberTabs();
            await this.agentFolders.shutdown(keepFolders);
        }
        return go;
    }

    // Close tabs outside the new folder first; cancellation keeps the folder.
    // Remember the new folder for next time. Restoring uses show = false
    // so a deliberately closed side panel stays closed.
    async openFolder(path: string, show = true): Promise<boolean> {
        const absolute = platform().paths.resolve(path);
        const root = this.files.root;
        if (root && root !== absolute && this.assistant.busy) {
            if (
                !(await this.frontend.dialogs.files.confirm(
                    'Stop pi Assistant and switch workspace?',
                    'The Assistant must stop before switching workspace. ' +
                        'Completed tools cannot be undone.',
                    'Stop Assistant and switch',
                    false
                ))
            )
                return false;
            await this.assistant.shutdown();
        }
        if (root && root !== absolute && this.agentFolders.busy) {
            const choice = await this.frontend.dialogs.harness.closeAgents(
                this.agentFolders.activity()
            );
            if (choice === 'cancel') return false;
            await this.agentFolders.shutdown(choice !== 'stop');
        }
        if (
            root &&
            root !== absolute &&
            !(await this.documents.closeOutside(absolute))
        )
            return false;
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
        if (this.agentFolders.folderChanged(absolute) && this.opened)
            this.openAgentDefault();
        this.assistant.folderChanged(absolute);
        const page = this.documents.page;
        if (page?.kind === 'home') this.refreshTitle(page.id);
        this.refreshHome();
        if (show) {
            this.settings.sidebar = true;
            this.frontend.host.showSidebar('files');
        }
        return true;
    }

    private async newAgent(): Promise<void> {
        if (!this.files.root) {
            const parent = await this.frontend.documents.dialogs.chooseFile({
                title: _('New Agent — Choose Parent Folder'),
                selectFolder: true,
            });
            if (!parent || !(await this.openFolder(parent))) return;
        }
        if (this.files.root) await this.files.create('agent', this.files.root);
    }

    private openAgentDefault(): void {
        const state = this.agentFolders.state();
        if (state.error) {
            this.toast(state.error);
            return;
        }
        if (state.sessions.length) this.agentFolders.open(state.sessions[0].id);
        else this.agentFolders.newChat();
    }

    // Refocus refreshes Home and history: commits and file changes can happen
    // outside the app (git pull, an agent, another editor).
    windowFocused(focused: boolean): void {
        this.focused = focused;
        if (!focused) return;
        this.syncHistory(true);
        this.refreshHome();
        this.programs.recheckMissing();
    }

    // Null means closed; timeline indicates Files is showing file history.
    sidebarShown(page: SidebarPage | null, timeline = false): void {
        this.sidebarPage = page;
        this.timeline = timeline;
        this.syncHistory();
    }

    // Text changed through typing, undo, or a core write that landed.
    edited(id: number): void {
        const doc = this.docById(id);
        if (!doc) return;
        this.folderDisk.observe(doc);
        this.views.queueReload(doc);
        this.autosaver.edited(doc);
    }

    // The editor of document `id` has read its headings again.
    headingsChanged(id: number): void {
        const doc = this.docById(id);
        if (doc && doc === this.documents.active) this.outline.changed(doc);
    }

    // Markdown links open tabs; other links use the system's chosen app.
    // A relative link is read from the document's folder.
    openLink(id: number, url: string): void {
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            this.frontend.host.openUri(url);
            return;
        }
        const { paths } = platform();
        const bare = url.replace(/[#?].*$/, '');
        const path = paths.isAbsolute(bare)
            ? bare
            : paths.join(this.folderOf(id) ?? paths.homeDir(), decodeURI(bare));
        if (
            /\.(md|markdown|mdown|mkd)$/i.test(path) &&
            this.documents.openInTab(path)
        )
            return;
        this.frontend.host.openUri(fileUri(path));
    }

    // Base folder for relative links/images; null for unsaved documents.
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
        const page = this.documents.allPages.find((p) => p.id === id);
        if (page) this.frontend.documents.setTitle(id, this.titleOfPage(page));
    }

    // ---------- What follows the documents ----------

    private docById(id: number): Doc<E> | undefined {
        return this.documents.all.find((d) => d.id === id);
    }

    // Avoid needless git calls: read history only on its page or Timeline.
    // force = read again for the same file.
    private syncHistory(force = false): void {
        if (
            this.sidebarPage === 'history' ||
            (this.sidebarPage === 'files' && this.timeline)
        )
            this.history.show(this.shownFile(), this.files.root, force);
    }

    // Tree/history follow the tab's file: document, HTML, or null for Home.
    private shownFile(): string | null {
        const page = this.documents.page;
        return page ? page.file : this.documents.active.file;
    }

    // Page tabs clear document-specific views and update frontend content.
    private pageActivated(id: number): void {
        const page = this.documents.allPages.find((p) => p.id === id);
        if (!page) return;
        if (page.kind === 'agent' && page.root)
            this.agentFolders.activate(page.root);
        this.frontend.documents.pageActivated(id);
        this.outline.clear();
        this.views.sync();
        this.refreshTitle(id);
        this.files.reveal(page.file);
        this.syncHistory();
    }

    // Update frontend tabs first, then views following the active document.
    private activated(id: number): void {
        const doc = this.docById(id);
        if (!doc) return;
        this.folderDisk.observe(doc);
        this.frontend.documents.activated(id);
        this.outline.show(doc);
        this.views.sync();
        this.refreshTitle(id);
        this.files.reveal(doc.file);
        this.syncHistory();
    }

    // Refresh views after a document's content or file changes.
    private contentChanged(id: number): void {
        const doc = this.docById(id);
        if (!doc) return;
        this.views.replaced(doc);
        this.refreshTitle(id);
        this.files.reveal(doc.file);
        this.syncHistory();
    }

    // Show Save As files without waiting for the folder monitor.
    private fileSaved(path: string): void {
        this.files.refresh(platform().paths.dirname(path));
        this.files.reveal(path);
        this.syncHistory();
    }

    // Preserve document/media views; open other text read-only.
    private openFile(path: string): void {
        if (isImageFile(path)) {
            this.frontend.host.showImage(path);
            return;
        }
        if (isHtmlFile(path)) {
            this.documents.openHtml(path, this.files.root);
            return;
        }
        if (!isMarkdownFile(path) && !isCsvFile(path)) {
            this.documents.openCode(path);
            return;
        }
        const active = this.documents.active;
        // Restore the highlight if the original file remains open.
        if (!this.documents.openInTab(path)) this.files.reveal(active.file);
    }

    private titleOf(doc: Doc<E>): DocumentTitle {
        const name = this.documents.nameOf(doc);
        if (!doc.file) return { name, file: null, page: false, place: null };
        return {
            name,
            file: doc.file,
            page: false,
            place: this.placeOf(doc.file),
        };
    }

    private titleOfPage(page: Page): DocumentTitle {
        const name = this.documents.nameOfPage(page);
        if (!page.file) {
            const root = this.files.root;
            return {
                name,
                file: null,
                page: true,
                place: root ? platform().paths.basename(root) : null,
            };
        }
        return {
            name,
            file: page.file,
            page: true,
            place: this.placeOf(page.file),
        };
    }

    // Where a file is, for a title: its folder, `~` for the home folder.
    private placeOf(file: string): string {
        const { paths } = platform();
        const dir = paths.dirname(file),
            home = paths.homeDir();
        const below = insideName(home, dir);
        return dir === home ? '~' : below !== null ? `~/${below}` : dir;
    }

    // Use the workspace-relative name, or basename outside it; null if unsaved.
    private projectName(path: string | null): string | null {
        const root = this.files.root;
        return (
            path &&
            ((root && insideName(root, path)) ||
                platform().paths.basename(path))
        );
    }

    // The Recent list of the menus: the last files that still exist.
    private refreshRecent(): void {
        this.frontend.host.setRecent(
            existingRecent(this.settings.recentFiles, this.files.root)
                .slice(0, 5)
                .map((r) => r.path)
        );
    }

    // Recompute Home from files whenever it is shown.
    refreshHome(): void {
        if (this.documents.page?.kind === 'home' && this.views.homeMode)
            this.frontend.host.screen.showHome(this.homePage.data());
    }

    // Redraw the Programs page if it is shown.
    refreshPrograms(): void {
        if (this.documents.page?.kind === 'programs' && this.views.programsMode)
            this.frontend.host.screen.showPrograms(this.programs.data());
    }

    // Stop controller work; the frontend destroys its editors and widgets.
    dispose(): void {
        for (const stop of this.stops.splice(0)) stop();
        for (const doc of this.documents.all) this.autosaver.cancel(doc);
        this.assistant.dispose();
        this.agentFolders.dispose();
        this.history.dispose();
        this.harness.dispose();
        this.collab.dispose();
        this.preferences.dispose();
        this.files.dispose();
        this.workspace.close();
    }
}
