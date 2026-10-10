// What the content area shows for the active document: its text, a kanban board, an inbox, or Home. A board or
// inbox is a view of the document text: changes made in the view are written back to the text (one undo step), and
// text changes made otherwise (undo, typing in source) are read back into the view.

import type Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type Gtk from 'gi://Gtk?version=4.0';
import { readTextFile, writeTextFile, flushWrites } from '../files.js';
import { TEXT_ACTIONS } from '../actions.js';
import { isBoard, isList } from '../markdown/layout.js';
import { newInbox, parseInbox, serializeInbox, type Inbox } from '../markdown/inbox.js';
import { countCards, newBoard, parseBoard, serializeBoard, type Board } from '../markdown/kanban.js';
import type { KanbanBoard } from '../ui/kanban.js';
import type { InboxView } from '../ui/inbox.js';
import type { HomeView } from '../ui/home.js';
import type { StatusBar } from '../ui/statusbar.js';
import type { FindBar } from '../ui/findbar.js';
import { _ } from '../i18n.js';
import { errorMessage, type Doc, type DocumentHost } from './doc.js';
import type { HomeController } from './home.js';
import type { JournalController } from './journal.js';

// Actions that are meaningless on Home (there is no text to save or undo).
const DOCUMENT_ACTIONS = ['save', 'save-as', 'export-html', 'undo', 'redo', 'kanban-view'];

export type View = 'board' | 'inbox' | 'home' | 'text';

export interface ViewHost extends DocumentHost {
    readonly app: Adw.Application;
    readonly content: Gtk.Stack;   // one page per document editor, plus "board", "inbox", and "home"
    readonly board: KanbanBoard;
    readonly inbox: InboxView;
    readonly home: HomeView;
    readonly homePage: HomeController;
    readonly statusBar: StatusBar;
    readonly findBar: FindBar;
    readonly journal: JournalController;
    newDocument(text: string): void;   // fill the active empty document, or a new tab, with text
}

// How one document is shown, kept here rather than on the document record.
interface ViewState {
    textOverride: boolean;   // the user chose the text view for this board or inbox
    boardText: string;       // the text the board/inbox last wrote or read; to recognize outside changes (undo)
    reloadQueued: boolean;
}

export class ViewController {
    private readonly states = new WeakMap<Doc, ViewState>();

    private state(doc: Doc): ViewState {
        let state = this.states.get(doc);
        if (!state) this.states.set(doc, state = { textOverride: false, boardText: '', reloadQueued: false });
        return state;
    }

    constructor(private readonly host: ViewHost) {
        host.board.onChange = board => this.writeBoard(board);
        host.inbox.onChange = inbox => this.writeInbox(inbox);
    }

    get boardMode(): boolean { return this.host.content.visible_child_name === 'board'; }
    get inboxMode(): boolean { return this.host.content.visible_child_name === 'inbox'; }
    get homeMode(): boolean { return this.host.content.visible_child_name === 'home'; }

    // New contents were put into doc (opened, emptied, made Home): it is shown as what it is again, not as the
    // text view the user chose for the previous contents.
    replaced(doc: Doc): void {
        this.state(doc).textOverride = false;
        this.sync();
    }

    // A kanban document is shown as a board and an inbox document as an inbox, unless the user chose the text view.
    sync(): void {
        const doc = this.host.active();
        if (doc.home) {
            this.show('home');
            return;
        }
        const text = doc.editor.getText();
        const structured = !this.state(doc).textOverride;
        this.show(structured && isBoard(text) ? 'board' : structured && isList(text) ? 'inbox' : 'text');
    }

    show(view: View): void {
        const { host } = this;
        const doc = host.active();
        host.statusBar.set_visible(view !== 'home');
        if (view === 'home') {
            host.findBar.close();
            host.content.visible_child_name = 'home';
            host.home.render(host.homePage.data());
        } else if (view === 'text') {
            host.content.visible_child_name = `doc-${doc.id}`;
            host.statusBar.setCounts(doc.editor.getText());
            doc.editor.updateCursor(true);
            doc.editor.view.grab_focus();
        } else {
            // The view gets its contents before it is shown.
            const text = doc.editor.getText();
            if (view === 'board') host.board.setBoard(parseBoard(text));
            else host.inbox.setInbox(parseInbox(text));
            this.state(doc).boardText = text;
            host.findBar.close();
            host.content.visible_child_name = view;
            this.showCounts(view);
        }
        const action = host.app.lookup_action('kanban-view');
        if (action instanceof Gio.SimpleAction) action.set_state(GLib.Variant.new_boolean(view === 'board' || view === 'inbox'));
        this.syncActionsEnabled();
    }

    private showCounts(view: 'board' | 'inbox'): void {
        if (view === 'board') this.showBoardCounts(this.host.board.getBoard());
        else this.host.statusBar.setInboxCounts(this.host.inbox.getInbox().items.length);
    }

    // A new document containing an empty kanban board.
    newBoard(): void {
        this.host.newDocument(serializeBoard(newBoard()));
    }

    // A new document containing an empty inbox, ready to capture.
    newInbox(): void {
        this.host.newDocument(serializeInbox(newInbox()));
        this.host.inbox.focusCapture();
    }

    // Text editor actions are disabled while a board, inbox, or Home is shown (its text is hidden).
    syncActionsEnabled(): void {
        const home = this.homeMode;
        const structured = this.boardMode || this.inboxMode || home;
        const enable = (names: Iterable<string>, enabled: boolean) => {
            for (const name of names) {
                const action = this.host.app.lookup_action(name);
                if (action instanceof Gio.SimpleAction) action.set_enabled(enabled);
            }
        };
        enable(TEXT_ACTIONS, !structured);
        enable(DOCUMENT_ACTIONS, !home);
    }

    // The "Board View" menu/shortcut: toggles between board/inbox and text for a kanban or inbox document.
    toggle(on: boolean): void {
        const doc = this.host.active();
        const text = doc.editor.getText();
        if (on && !isBoard(text) && !isList(text)) {
            this.host.toast(_('This document is not a board or list (it needs "layout: board" or "layout: list" in the frontmatter)'));
            this.show('text');
            return;
        }
        this.state(doc).textOverride = !on;
        this.sync();
    }

    private showBoardCounts(board: Board): void {
        this.host.statusBar.setBoardCounts(board.columns.length, countCards(board));
    }

    // Changes from the inbox → document text (one undo step).
    private writeInbox(inbox: Inbox): void {
        const doc = this.host.active();
        const text = serializeInbox(inbox);
        this.state(doc).boardText = text;
        doc.editor.replaceText(text);
        this.host.statusBar.setInboxCounts(inbox.items.length);
    }

    // Changes from the board → document text (one undo step).
    private writeBoard(board: Board): void {
        const doc = this.host.active();
        const state = this.state(doc);
        if (state.boardText) this.host.journal.recordBoard(doc.file, parseBoard(state.boardText), board);
        const text = serializeBoard(board);
        state.boardText = text;   // recognize this change as the board's own
        doc.editor.replaceText(text);
        this.showBoardCounts(board);
    }

    // Change the board in `file` for the orchestrator: through its editor if open (one undo step), otherwise directly on disk.
    updateBoardFile(file: string, edit: (board: Board) => Board): string | null {
        const doc = this.host.docs().find(d => d.file === file);
        try {
            if (!doc) flushWrites(file);
            const text = doc ? doc.editor.getText() : readTextFile(file);
            if (!isBoard(text)) return 'the board file is no longer a board (its frontmatter has no "layout: board")';
            const board = parseBoard(text);
            const next = edit(board);
            if (next === board) return null;
            if (doc === this.host.active() && this.boardMode) {
                this.host.board.setBoard(next);
                this.writeBoard(next);   // records its own activity
                return null;
            }
            if (doc) doc.editor.replaceText(serializeBoard(next));
            else writeTextFile(file, serializeBoard(next));
            this.host.journal.recordBoard(file, board, next);
            return null;
        } catch (e) {
            return errorMessage(e);
        }
    }

    // The text of a document shown as a board or inbox changed (undo, for example): read it back into the view.
    queueReload(doc: Doc): void {
        const state = this.state(doc);
        if (doc !== this.host.active() || !(this.boardMode || this.inboxMode) || state.reloadQueued) return;
        state.reloadQueued = true;
        // Deferred: undo changes the text in several steps, and what is read must be the final result.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            state.reloadQueued = false;
            if (doc === this.host.active() && this.host.docs().includes(doc)) this.reload(doc);
            return GLib.SOURCE_REMOVE;
        });
    }

    private reload(doc: Doc): void {
        const state = this.state(doc);
        const text = doc.editor.getText();
        if (!(this.boardMode || this.inboxMode) || text === state.boardText) return;
        if (!(this.boardMode ? isBoard(text) : isList(text))) {
            state.textOverride = true;   // no longer a board/inbox (for example the frontmatter was removed)
            this.show('text');
            return;
        }
        state.boardText = text;
        if (this.boardMode) this.host.board.setBoard(parseBoard(text));
        else this.host.inbox.setInbox(parseInbox(text));
        this.showCounts(this.boardMode ? 'board' : 'inbox');
    }
}
