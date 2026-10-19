// AppFrontend for a frontend in another process: every view call becomes a notice, every question a request
// (docs/design/protocol.md, sections 5 to 7). This is the slice the first Electron window needs: documents and their
// tabs, the text/board screen, the board, toasts, and the questions about documents. Everything else is `unwired`.

import type { AppSettings } from '../../settings.js';
import type { Board } from '../../markdown/kanban.js';
import type { NoteEdit } from '../../markdown/noteedit.js';
import type { KanbanView, ViewScreen } from '../views.js';
import type { DocumentDialogs } from '../documents.js';
import type { ChooseFileOptions } from '../dialogs.js';
import type { AppDialogs, AppFrontend, DocumentTitle, FrontendDocuments, FrontendHost } from '../session.js';
import type { ToastButton } from '../document.js';
import { ProtocolEditor } from './replica.js';
import { Asks } from './asks.js';
import type { Wire } from './messages.js';
import { unwired } from './unwired.js';
import { ProtocolOutline } from './outline.js';
import { ProtocolSearch } from './search.js';
import { ProtocolTree } from './tree.js';
import { ProtocolScreen } from './screen.js';

class ProtocolBoard {
    onEdit: (edit: NoteEdit) => void = () => {};
    agentsEnabled = true;
    groupField: string | null = null;

    constructor(private readonly show: (board: Board, groupField: string | null, agents: boolean) => void) {}

    setBoard(board: Board): void { this.show(board, this.groupField, this.agentsEnabled); }
    replace(board: Board): void { this.show(board, this.groupField, this.agentsEnabled); }
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
    private readonly row: number[] = [];

    readonly host: FrontendHost<ProtocolEditor>;
    // The Outline panel's end of the wire: the handler for `act.outline.jump` calls its `onJump`.
    readonly outline: ProtocolOutline;
    // The Search panel's end of the wire.
    readonly search: ProtocolSearch;
    // The Files tab's end of the wire.
    readonly tree: ProtocolTree;
    readonly documents: FrontendDocuments<ProtocolEditor>;
    readonly dialogs: AppDialogs;
    // The questions the dialogs ask over the wire.
    readonly asks: Asks;

    constructor(readonly settings: AppSettings, private readonly wire: Wire) {
        this.asks = new Asks(wire);
        const board = new ProtocolBoard((b, groupField, agents) => this.showNotes(b, groupField, agents));
        this.outline = new ProtocolOutline(wire);
        this.search = new ProtocolSearch(wire);
        this.tree = new ProtocolTree(wire);
        this.host = unwired<FrontendHost<ProtocolEditor>>({
            screen: unwired<ViewScreen<ProtocolEditor>>(new ProtocolScreen(wire, () => this.active), 'host.screen'),
            board: unwired<KanbanView>(board, 'host.board'),
            outlineView: this.outline,
            searchView: this.search,
            fileTree: this.tree,
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
            detach: (id: number) => this.detach(id),
            listTab: (id: number, listed: boolean) => { if (!listed) this.drop(id); else if (!this.row.includes(id)) this.row.push(id); },
            activated: (id: number) => { this.active = id; wire.notify('doc.active', { doc: id }); },
            setTitle: (id: number, title: DocumentTitle) => wire.notify('doc.title', { doc: id, title }),
        }, 'documents');
        this.dialogs = unwired<AppDialogs>({
            files: {
                name: (title: string, label: string, value?: string) => this.asks.text('ask.files.name', { title, label, value }),
                confirm: (message: string, detail: string) => this.asks.question('ask.files.confirm', { message, detail, accept: 'Move to Trash', destructive: true }),
                error: (message: string) => { wire.notify('toast', { text: message, action: null }); },
            },
            search: { confirm: (message: string, detail: string, accept: string) => this.asks.question('ask.search.confirm', { message, detail, accept, destructive: true }) },
        }, 'dialogs');
    }

    createEditor(id: number): ProtocolEditor {
        const editor = new ProtocolEditor(id, this.wire);
        editor.onEdited = () => this.edited(id);
        editor.onHeadings = () => this.headingsChanged(id);
        editor.onFailed = message => this.wire.notify('toast', { text: message, action: null });
        this.editors.set(id, editor);
        return editor;
    }

    private showNotes(board: Board, groupField: string | null, agents: boolean): void {
        const doc = this.active;
        this.wire.notify('view.notes', { doc, version: this.editors.get(doc)?.version ?? 0, page: 'board', board, groupField, agents });
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

    private documentDialogs(): DocumentDialogs {
        const { asks, wire } = this;
        return {
            askSaveChanges: documentName => asks.choice('ask.saveChanges', { document: documentName }, ['save', 'discard', 'cancel'], 'cancel'),
            showError: message => wire.notify('error', { message }),
            chooseFile: (options: ChooseFileOptions) => asks.file(options),
        };
    }
}
