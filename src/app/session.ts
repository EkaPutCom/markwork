// The application session: builds the feature controllers of app/ and owns them, given one frontend. The frontend (the
// GTK window today) supplies what only it can: the views the controllers draw on, the dialogs they ask with, and the
// hooks for what must follow a document on screen. Everything that connects the controllers to each other lives here,
// so a second frontend implements AppFrontend and gets the same application, not a copy of the wiring.

import type { AppSettings } from '../settings.js';
import { WorkspaceRepository } from '../workspace.js';
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
import { FilesController, type FilesDialogs, type FilesHost } from './files.js';
import { SearchController, type SearchDialogs, type SearchHost } from './search.js';
import type { Doc, TextEditor, ToastAction, ToastButton } from './document.js';

// The host the controllers see, put together: each controller is typed with only the part it needs.
export type ControllerHost<E extends TextEditor> = AutosaveHost & JournalHost & HarnessHost & HomeHost & AgentWriteHost<E> & ViewHost<E>
    & NoteHost & CollabHost & PullHost & ContributeHost & ReviewHost & AssistantHost<E> & HistoryHost<E> & FilesHost & SearchHost<E> & OutlineHost<E> & PreferencesHost;

// What the session answers itself, from the controllers it owns.
type SessionProvided = 'harness' | 'journal' | 'homePage' | 'workspace' | 'active' | 'docs' | 'openInTab' | 'write' | 'fileMoved' | 'fileGone'
    | 'fileBack' | 'newDocument' | 'showDocument' | 'saveAll' | 'showChat' | 'boardShown' | 'updateBoardFile' | 'record' | 'agentHost' | 'runs'
    | 'journalSummary' | 'refreshHome' | 'chat' | 'root' | 'entryMoved' | 'entryDeleted' | 'settings' | 'toast';

// The views, notices, and system services of the frontend: the host members that are not another controller. A toast
// button reaches it as a token, which it gives back to AppSession.toastActivated when the user presses the button.
export type FrontendHost<E extends TextEditor> = Omit<ControllerHost<E>, SessionProvided> & {
    toast(message: string, action?: ToastButton): void;
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
    readonly documents: Omit<DocumentsHost<E>, 'autosaver' | 'refreshHome' | 'root' | 'settings' | 'toast' | 'createEditor'>;
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
        }) as DocumentsHost<E>);
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
            toast: value((message: string, action?: ToastAction) => this.toast(message, action)),
            // A file or folder moved, renamed, or trashed in the Files tab: the open documents follow, then the frontend
            // highlights the active file again and re-reads its history.
            entryMoved: value((from: string, to: string) => { this.documents.filesMoved(from, to); this.frontend.host.filesMoved(); }),
            entryDeleted: value((path: string) => { this.documents.fileDeleted(path); this.frontend.host.filesMoved(); }),
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

    // Redraw Home if it is shown; the data is recomputed from the files every time.
    refreshHome(): void {
        if (this.documents.active.home && this.views.homeMode) this.frontend.host.screen.showHome(this.homePage.data());
    }

    // Stop the timers and background work of the controllers (the frontend destroys its editors and widgets).
    dispose(): void {
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
