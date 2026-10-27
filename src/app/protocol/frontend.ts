// AppFrontend for a frontend in another process: every view call becomes a notice, every question a request
// (docs/design/protocol.md, sections 5 to 7). This is the slice the first Electron window needs: documents and their
// tabs, the text/board screen, the board, toasts, and the questions about documents. Everything else is `unwired`.

import type { AppSettings } from '../../base/settings.js';
import type { Board } from '../../markdown/kanban.js';
import type { NoteEdit } from '../../markdown/noteedit.js';
import type { CaptureView, CsvPage, KanbanView, LayoutPage, NotesView, SchemaDialogOptions, ViewDialogs, ViewScreen } from '../views.js';
import type { FieldDef } from '../../markdown/fields.js';
import type { ConflictComparison, DocumentDialogs } from '../documents.js';
import type { ChooseFileOptions, Prompt } from '../dialogs.js';
import type { AppDialogs, AppFrontend, DocumentTitle, FrontendDocuments, FrontendHost } from '../session.js';
import type { Page, ToastButton } from '../document.js';
import type { Card, Position } from '../../markdown/kanban.js';
import type { CardRun, HarnessBoard, HarnessMenuEntry } from '../harness.js';
import { ProtocolEditor } from './replica.js';
import { Asks } from './asks.js';
import type { Wire } from './messages.js';
import { unwired } from './unwired.js';
import { ProtocolOutline } from './outline.js';
import { ProtocolSearch } from './search.js';
import { ProtocolTree } from './tree.js';
import { ProtocolPreferences, ProtocolPreferencesDialogs } from './preferences.js';
import { ProtocolScreen } from './screen.js';
import { ProtocolChatPanel } from './chat.js';
import { ProtocolHistoryDialogs, ProtocolHistoryTab, ProtocolHistoryViewers } from './history.js';
import { ProtocolHarnessDialogs, ProtocolHarnessLogs, ProtocolReviewDialogs, ProtocolReviewView, ProtocolRuns } from './harness.js';
import { ProtocolCollabDialogs, ProtocolCollabPanel, ProtocolContributeDialogs, ProtocolPullDialogs, ProtocolPullView } from './collab.js';

// A page that shows the notes of the document (board, list, table, calendar, …): it sends the board as it is, and the
// frontend answers with the operations the user makes (`act.notes.edit`). Only the board has groups and agents.
class ProtocolNotes implements KanbanView, CaptureView {
    onEdit: (edit: NoteEdit) => void = () => {};
    agentsEnabled = true;
    groupField: string | null = null;

    constructor(private readonly page: string, private readonly show: (page: string, board: Board, groupField: string | null, agents: boolean) => void,
        private readonly focus: (page: string) => void) {}

    setBoard(board: Board): void { this.show(this.page, board, this.groupField, this.agentsEnabled); }
    replace(board: Board): void { this.show(this.page, board, this.groupField, this.agentsEnabled); }
    focusCapture(): void { this.focus(this.page); }
}

// The board also carries the agents: the runs of its cards come as data, and a card's menu is asked for when it opens (the
// frontend asks with `act.card.menu`, the harness controller answers with entries that name their action by a token).
class ProtocolBoard extends ProtocolNotes implements HarnessBoard {
    onCardMenu: (card: Card, at: Position) => Promise<HarnessMenuEntry[]> = async () => [];
    onRunMenu: (token: number) => void = () => {};

    constructor(page: string, show: ConstructorParameters<typeof ProtocolNotes>[1], focus: ConstructorParameters<typeof ProtocolNotes>[2],
        private readonly runs: ProtocolRuns) { super(page, show, focus); }

    setRuns(runs: readonly CardRun[]): void { this.runs.setRuns(runs); }
}

// The CSV tab: the frontend holds the table it draws and sends the whole text after each change (`act.csv.change`); the
// core sends the text when the tab is shown or the text changed outside the table (`view.csv`).
class ProtocolCsv implements CsvPage {
    onChange: (text: string) => void = () => {};
    onShape: (rows: number, columns: number) => void = () => {};

    constructor(private readonly wire: Wire, private readonly active: () => number) {}

    setText(text: string): void { this.wire.notify('view.csv', { doc: this.active(), text }); }
}

export class ProtocolFrontend implements AppFrontend<ProtocolEditor> {
    readonly editors = new Map<number, ProtocolEditor>();
    // The server sets it: a document's text changed (the session's `edited`).
    edited: (id: number) => void = () => {};
    // The server sets it: a document's headings changed (the session's `headingsChanged`).
    headingsChanged: (id: number) => void = () => {};
    // The server sets it: a folder was opened (by a command or by restoring the last one), so the file list changed.
    folderOpened: () => void = () => {};
    private active = 0;
    // The pages of the document's notes, by name, and the one the core last gave its notes to: it is the one the user edits.
    private readonly notesViews = new Map<string, ProtocolNotes>();
    private notesPage = 'board';
    private readonly row: number[] = [];

    readonly host: FrontendHost<ProtocolEditor>;
    // The Outline panel's end of the wire: the handler for `act.outline.jump` calls its `onJump`.
    readonly outline: ProtocolOutline;
    // The Search panel's end of the wire.
    readonly search: ProtocolSearch;
    // The Files tab's end of the wire.
    readonly tree: ProtocolTree;
    // The Preferences dialog's end of the wire.
    readonly preferences: ProtocolPreferences;
    // The Assistant panel's end of the wire: `chat.*` notices out, the controller's `on*` actions in (handlers/chat.ts).
    readonly chat: ProtocolChatPanel;
    // The CSV tab's end of the wire: `act.csv.*` call its `onChange` and `onShape`.
    readonly csv: ProtocolCsv;
    // The History tab and the viewer windows' end of the wire (`act.history.*`, `act.historyViewer.*`).
    readonly historyTab: ProtocolHistoryTab;
    readonly historyViewers: ProtocolHistoryViewers;
    // The pull request tab, the review page, and the token dialog (`act.collab.*`, `act.pull.*`).
    readonly collabPanel: ProtocolCollabPanel;
    readonly pullView: ProtocolPullView;
    readonly collabDialogs: ProtocolCollabDialogs;
    // The board with its agents, the run log windows, and the review of a card's worktree (`act.card.*`, `act.runlog.*`, `act.review.*`).
    readonly agentBoard: ProtocolBoard;
    readonly runLogs: ProtocolHarnessLogs;
    readonly reviewView: ProtocolReviewView;
    readonly documents: FrontendDocuments<ProtocolEditor>;
    readonly dialogs: AppDialogs;
    // The questions the dialogs ask over the wire.
    readonly asks: Asks;

    constructor(readonly settings: AppSettings, private readonly wire: Wire) {
        this.asks = new Asks(wire);
        const show = (page: string, b: Board, groupField: string | null, agents: boolean) => this.showNotes(page, b, groupField, agents);
        const notes = (page: string) => { const view = new ProtocolNotes(page, show, focus); this.notesViews.set(page, view); return view; };
        const focus = (page: string) => wire.notify('view.focusCapture', { doc: this.active, page });
        this.agentBoard = new ProtocolBoard('board', show, focus, new ProtocolRuns(wire, () => this.active));
        this.notesViews.set('board', this.agentBoard);
        const board = this.agentBoard;
        const layouts: Record<LayoutPage, NotesView> = {
            calendar: notes('calendar'), timeline: notes('timeline'), gallery: notes('gallery'), chart: notes('chart'),
        };
        this.csv = new ProtocolCsv(wire, () => this.active);
        this.outline = new ProtocolOutline(wire);
        this.search = new ProtocolSearch(wire);
        this.tree = new ProtocolTree(wire);
        this.preferences = new ProtocolPreferences(wire);
        this.chat = new ProtocolChatPanel(wire, this.asks);
        this.historyTab = new ProtocolHistoryTab(wire);
        this.historyViewers = new ProtocolHistoryViewers(wire);
        this.collabPanel = new ProtocolCollabPanel(wire);
        this.pullView = new ProtocolPullView(wire);
        this.collabDialogs = new ProtocolCollabDialogs(this.asks);
        this.runLogs = new ProtocolHarnessLogs(wire);
        this.reviewView = new ProtocolReviewView(wire);
        this.host = unwired<FrontendHost<ProtocolEditor>>({
            screen: unwired<ViewScreen<ProtocolEditor>>(new ProtocolScreen(wire, () => this.active), 'host.screen'),
            board,
            inbox: notes('inbox'),
            table: notes('table'),
            layouts,
            csv: this.csv,
            outlineView: this.outline,
            searchView: this.search,
            fileTree: this.tree,
            preferencesView: this.preferences,
            chatPanel: this.chat,
            historyTab: this.historyTab,
            historyViewers: this.historyViewers,
            collabPanel: this.collabPanel,
            pullView: this.pullView,
            logs: this.runLogs,
            reviewView: this.reviewView,
            // The content area shows the review page until the next page the core shows (`view.page`, `doc.active`).
            showPull: () => wire.notify('view.pull.show'),
            showReview: () => wire.notify('view.review.show'),
            // The Recent list of the menus: the frontend draws it.
            setRecent: (paths: string[]) => wire.notify('recent', { paths }),
            setProgramsMissing: (count: number) => wire.notify('programs.missing', { count }),
            toast: (message: string, action?: ToastButton) => wire.notify('toast', { text: message, action: action ?? null }),
            openUri: (uri: string) => wire.notify('open.uri', { uri }),
            // The frontend decides whether a desktop notification is right (protocol.md 9.1): it knows its window.
            notify: (id: string, title: string, body: string) => wire.notify('notify', { id, title, body }),
            // A folder in the file manager (a card's worktree); the frontend opens it with the system's handler.
            openFolder: (path: string) => wire.notify('reveal.folder', { path }),
            // An image chosen in the Files tab: the frontend's viewer.
            showImage: (path: string) => wire.notify('view.image', { path }),
            showSidebar: () => this.folderOpened(),
        }, 'host');
        this.documents = unwired<FrontendDocuments<ProtocolEditor>>({
            dialogs: this.documentDialogs(),
            tabOrder: () => [...this.row],
            attach: (id: number) => {
                this.row.push(id);
                const editor = this.editors.get(id)!;
                wire.notify('doc.open', { doc: id, text: editor.getText(), version: editor.version, modified: false, title: null });
                // The first document is active without the activation hooks (DocumentController.start).
                if (this.active === 0) { this.active = id; wire.notify('doc.active', { doc: id }); }
            },
            attachPage: (page: Page) => {
                this.row.push(page.id);
                wire.notify('page.open', { page: page.id, kind: page.kind, file: page.file, root: page.root });
            },
            detachPage: (id: number) => { this.drop(id); wire.notify('page.close', { page: id }); },
            pageActivated: (id: number) => { wire.notify('page.active', { page: id }); },
            detach: (id: number) => this.detach(id),
            // A parked document loses its tab but stays open; it comes back with `doc.active`.
            listTab: (id: number, listed: boolean) => {
                if (listed) { if (!this.row.includes(id)) this.row.push(id); return; }
                this.drop(id);
                wire.notify('doc.park', { doc: id });
            },
            activated: (id: number) => { this.active = id; wire.notify('doc.active', { doc: id }); },
            setTitle: (id: number, title: DocumentTitle) => wire.notify('doc.title', { doc: id, title }),
            showConflictComparison: (comparison: ConflictComparison) => wire.notify('view.conflictComparison', { comparison }),
        }, 'documents');
        this.dialogs = {
            files: {
                name: (title: string, label: string, value?: string) => this.asks.text('ask.files.name', { title, label, value }),
                confirm: (message: string, detail: string) => this.asks.question('ask.files.confirm', { message, detail, accept: 'Move to Trash', destructive: true }),
                error: (message: string) => { wire.notify('toast', { text: message, action: null }); },
            },
            views: this.viewDialogs(),
            // "Add to Journal": one line of text, recorded with the time.
            journal: { capture: (prompt: Prompt) => this.asks.text('ask.capture', prompt) },
            history: new ProtocolHistoryDialogs(this.asks),
            collab: this.collabDialogs,
            pulls: new ProtocolPullDialogs(this.asks),
            contribute: new ProtocolContributeDialogs(this.asks),
            search: { confirm: (message: string, detail: string, accept: string) => this.asks.question('ask.search.confirm', { message, detail, accept, destructive: true }) },
            harness: new ProtocolHarnessDialogs(this.asks),
            review: new ProtocolReviewDialogs(this.asks),
            preferences: new ProtocolPreferencesDialogs(this.asks),
        };
    }

    // An edit the user made on the page that shows the notes (`act.notes.edit`).
    editNotes(edit: NoteEdit): void {
        this.notesViews.get(this.notesPage)?.onEdit(edit);
    }

    createEditor(id: number): ProtocolEditor {
        const editor = new ProtocolEditor(id, this.wire);
        editor.onEdited = () => this.edited(id);
        editor.onHeadings = () => this.headingsChanged(id);
        editor.onFailed = message => this.wire.notify('toast', { text: message, action: null });
        this.editors.set(id, editor);
        return editor;
    }

    private showNotes(page: string, board: Board, groupField: string | null, agents: boolean): void {
        const doc = this.active;
        this.notesPage = page;
        this.wire.notify('view.notes', { doc, version: this.editors.get(doc)?.version ?? 0, page, board, groupField, agents });
    }

    private drop(id: number): void {
        const at = this.row.indexOf(id);
        if (at >= 0) this.row.splice(at, 1);
    }

    // Closing is a request that carries the version the core decided on (5.2.1). The reply is not acted on yet: the
    // frontend holds a conflicting tab open on its own, and the core asks nothing more.
    private detach(id: number): void {
        const version = this.editors.get(id)?.version ?? 0;
        this.drop(id);
        this.editors.delete(id);
        void this.wire.request('doc.close', { doc: id, version });
    }

    // The Fields… dialog: the fields as the document declares them, answered with the fields as they should be, or nothing.
    private viewDialogs(): ViewDialogs {
        return {
            editSchema: (options: SchemaDialogOptions) => this.asks.ask<FieldDef[] | null>('ask.schema', { ...options },
                r => Array.isArray(r.fields) ? r.fields as FieldDef[] : undefined, null),
        };
    }

    private documentDialogs(): DocumentDialogs {
        const { asks, wire } = this;
        return {
            askSaveChanges: documentName => asks.choice('ask.saveChanges', { document: documentName }, ['save', 'discard', 'cancel'], 'cancel'),
            showError: message => wire.notify('error', { message }),
            chooseFile: (options: ChooseFileOptions) => asks.file(options),
        };
    }
}
