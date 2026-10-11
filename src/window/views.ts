// What the content area shows for the active document: its text, a kanban board, an inbox, or Home. A board or
// inbox is a view of the document text: changes made in the view are written back to the text (one undo step), and
// text changes made otherwise (undo, typing in source) are read back into the view.

import type Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type Gtk from 'gi://Gtk?version=4.0';
import { readTextFile, writeTextFile, flushWrites } from '../files.js';
import { TEXT_ACTIONS } from '../actions.js';
import { isStructured, layoutOf, withLayout, LAYOUTS, type Layout } from '../markdown/layout.js';
import { groupBoard, groupFieldOf, ungroupBoard, type Grouped } from '../markdown/boardgroup.js';
import { newList } from '../markdown/inbox.js';
import { newTable } from '../markdown/tablelayout.js';
import { boardSchema, countCards, declaredFields, fieldUses, newBoard, parseBoard, reservedFields, serializeBoard, withSchema, type Board } from '../markdown/kanban.js';
import type { FieldDef } from '../markdown/fields.js';
import { editSchemaDialog, type SchemaDialogOptions } from '../ui/schemadialog.js';
import { after, type Awaitable } from '../gtkutil.js';
import type { KanbanBoard } from '../ui/kanban.js';
import type { InboxView } from '../ui/inbox.js';
import type { TableView } from '../ui/table.js';
import type { StructuredView } from '../ui/structured.js';
import type { HomeView } from '../ui/home.js';
import type { StatusBar } from '../ui/statusbar.js';
import type { FindBar } from '../ui/findbar.js';
import { _ } from '../i18n.js';
import { missingField, withField } from '../markdown/layouthint.js';
import type { HeaderBar } from '../ui/headerbar.js';
import { errorMessage, type Doc, type DocumentHost } from './doc.js';
import type { HomeController } from './home.js';
import type { JournalController } from './journal.js';

// Actions that are meaningless on Home (there is no text to save or undo).
const DOCUMENT_ACTIONS = ['save', 'save-as', 'export-html', 'undo', 'redo', 'kanban-view', 'layout'];
// Actions that need a board or a list to act on.
const STRUCTURED_ACTIONS = ['fields-edit'];

// The dialogs of this controller; tests replace them.
export interface ViewDialogs {
    editSchema(parent: Gtk.Window | null, options: SchemaDialogOptions): Awaitable<FieldDef[] | null>;
}

export type LayoutPage = 'calendar' | 'timeline' | 'gallery' | 'chart';
export type View = 'board' | 'inbox' | 'table' | LayoutPage | 'home' | 'text';

// The page that shows each layout.
const LAYOUT_LABEL: Record<Layout, () => string> = {
    board: () => _('Board'), list: () => _('List'), table: () => _('Table'), calendar: () => _('Calendar'),
    timeline: () => _('Timeline'), gallery: () => _('Gallery'), chart: () => _('Chart'),
};

const PAGE_OF: Record<Layout, View> = { board: 'board', list: 'inbox', table: 'table', calendar: 'calendar', timeline: 'timeline', gallery: 'gallery', chart: 'chart' };
const STRUCTURED_PAGES: readonly View[] = Object.values(PAGE_OF);
const isStructuredPage = (name: string | null): name is Exclude<View, 'home' | 'text'> => STRUCTURED_PAGES.includes(name as View);

export interface ViewHost extends DocumentHost {
    readonly app: Adw.Application;
    readonly content: Gtk.Stack;   // one page per document editor, plus "board", "inbox", "table", and "home"
    readonly board: KanbanBoard;
    readonly inbox: InboxView;
    readonly table: TableView;
    readonly layouts: Record<LayoutPage, StructuredView>;   // the calendar, timeline, gallery, and chart pages
    readonly home: HomeView;
    readonly header: HeaderBar;
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
    // While the board is grouped by a field (`group:`): the document's own board and the one the board view shows.
    private grouped: { source: Board; view: Grouped; field: FieldDef } | null = null;
    dialogs: ViewDialogs = { editSchema: editSchemaDialog };

    private state(doc: Doc): ViewState {
        let state = this.states.get(doc);
        if (!state) this.states.set(doc, state = { textOverride: false, boardText: '', reloadQueued: false });
        return state;
    }

    constructor(private readonly host: ViewHost) {
        host.board.onChange = board => this.boardChanged(board);
        host.inbox.onChange = inbox => this.writeInbox(inbox);
        host.table.onChange = table => this.writeInbox(table);
        for (const view of Object.values(host.layouts)) view.onChange = board => this.writeInbox(board);
    }

    get boardMode(): boolean { return this.host.content.visible_child_name === 'board'; }
    get inboxMode(): boolean { return this.host.content.visible_child_name === 'inbox'; }
    get tableMode(): boolean { return this.host.content.visible_child_name === 'table'; }
    get homeMode(): boolean { return this.host.content.visible_child_name === 'home'; }
    // A board, inbox, table, calendar, timeline, gallery, or chart is shown (a view of the text, not the text itself).
    get structuredMode(): boolean { return isStructuredPage(this.host.content.visible_child_name); }

    // The name of the page that is shown.
    private currentView(): View | null {
        const name = this.host.content.visible_child_name;
        return name === 'home' || isStructuredPage(name) ? name : name ? 'text' : null;
    }

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
        const layout = layoutOf(text);
        this.show(!this.state(doc).textOverride && layout ? PAGE_OF[layout] : 'text');
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
            this.viewOf(view)?.setBoard(parseBoard(text));
            this.state(doc).boardText = text;
            host.findBar.close();
            host.content.visible_child_name = view;
            this.showCounts(view);
        }
        const action = host.app.lookup_action('kanban-view');
        if (action instanceof Gio.SimpleAction) action.set_state(GLib.Variant.new_boolean(isStructuredPage(view)));
        this.syncLayoutMenu(view);
        this.syncActionsEnabled();
    }

    // The header bar's layout button and menu show the layout the document is in (Text for the text view, hidden for Home).
    private syncLayoutMenu(view: View): void {
        const layout = view === 'home' || view === 'text' ? null : layoutOf(this.host.active().editor.getText());
        const action = this.host.app.lookup_action('layout');
        if (action instanceof Gio.SimpleAction) action.set_state(GLib.Variant.new_string(layout ?? ''));
        this.host.header.setLayoutLabel(view === 'home' ? null : layout ? LAYOUT_LABEL[layout]() : _('Text'));
    }

    // The layout menu: write the layout into the frontmatter (one undo step) and show the document as that layout.
    // An empty name is the text view.
    setLayout(name: string): void {
        const doc = this.host.active();
        const layout = LAYOUTS.find(l => l === name);
        if (layout) {
            const text = doc.editor.getText();
            if (layoutOf(text) !== layout) doc.editor.replaceText(withLayout(text, layout));
        }
        this.state(doc).textOverride = !layout;
        this.sync();
        if (layout) this.offerField(doc, layout);
    }

    // A layout that needs a field the document lacks (a date for the calendar, a select for the chart) offers to add it.
    private offerField(doc: Doc, layout: Layout): void {
        const board = parseBoard(doc.editor.getText());
        const def = missingField(board, layout);
        if (!def) return;
        const message = def.type === 'date'
            ? _('This layout places notes by a date field, and the document has none')
            : _('This layout groups notes by a select field, and the document has none');
        this.host.toast(message, {
            label: _('Add “%s”').format(def.key),
            run: () => {
                if (!this.host.docs().includes(doc)) return;
                const next = withField(parseBoard(doc.editor.getText()), def);
                doc.editor.replaceText(serializeBoard(next));
                if (doc === this.host.active()) this.reload(doc);
            },
        });
    }

    // The view that shows a board, a list, a table, or one of the other layouts (they all read the same model); null for the others.
    private viewOf(view: View | null): { setBoard(board: Board): void; getBoard(): Board; commit(board: Board): void } | null {
        if (view === 'board') return { setBoard: b => this.setBoardView(b), getBoard: () => this.grouped?.source ?? this.host.board.getBoard(), commit: b => this.commitBoardView(b) };
        if (view === 'inbox') return this.host.inbox;
        if (view === 'table') return this.host.table;
        return view === 'calendar' || view === 'timeline' || view === 'gallery' || view === 'chart' ? this.host.layouts[view] : null;
    }

    // The board view gets the document's board, or the board made from the values of a field when the document says `group:`.
    private setBoardView(source: Board): void {
        const field = groupFieldOf(source, boardSchema(source));
        this.grouped = field ? { source, view: groupBoard(source, field), field } : null;
        this.host.board.agentsEnabled = !field;
        this.host.board.groupField = field?.key ?? null;
        this.host.board.setBoard(this.grouped?.view.board ?? source);
    }

    // A change from the board view; for a grouped board it is written back to the notes first.
    private boardChanged(board: Board): void {
        const grouped = this.grouped;
        if (!grouped) { this.writeBoard(board); return; }
        const source = ungroupBoard(grouped.source, grouped.view, board, grouped.field);
        this.grouped = { ...grouped, source, view: groupBoard(source, grouped.field) };
        this.host.board.replace(this.grouped.view.board);
        this.writeBoard(source);
    }

    // A change made outside the board view (the Fields… dialog): shown and written.
    private commitBoardView(board: Board): void {
        this.setBoardView(board);
        this.writeBoard(board);
    }

    private showCounts(view: Exclude<View, 'home' | 'text'>): void {
        if (view === 'board') this.showBoardCounts(this.viewOf('board')!.getBoard());
        else this.host.statusBar.setInboxCounts(countCards(this.viewOf(view)!.getBoard()));
    }

    // A new document containing an empty kanban board.
    newBoard(): void {
        this.host.newDocument(serializeBoard(newBoard()));
    }

    // A new document containing an empty table, ready to add rows.
    newTable(): void {
        this.host.newDocument(serializeBoard(newTable()));
        this.host.table.focusCapture();
    }

    // A new document containing an empty inbox, ready to capture.
    newInbox(): void {
        this.host.newDocument(serializeBoard(newList()));
        this.host.inbox.focusCapture();
    }

    // Text editor actions are disabled while a board, inbox, or Home is shown (its text is hidden).
    syncActionsEnabled(): void {
        const home = this.homeMode;
        const structured = this.structuredMode || home;
        const enable = (names: Iterable<string>, enabled: boolean) => {
            for (const name of names) {
                const action = this.host.app.lookup_action(name);
                if (action instanceof Gio.SimpleAction) action.set_enabled(enabled);
            }
        };
        enable(TEXT_ACTIONS, !structured);
        enable(DOCUMENT_ACTIONS, !home);
        enable(STRUCTURED_ACTIONS, this.structuredMode);
    }

    // The "Fields…" menu: change the fields the board or list declares, written back into its frontmatter (one undo step).
    editFields(): void {
        const view = this.viewOf(this.currentView());
        if (!view) return;
        const board = view.getBoard();
        const options: SchemaDialogOptions = { fields: declaredFields(board), reserved: reservedFields(board), uses: (key, option) => fieldUses(board, key, option) };
        void after(this.dialogs.editSchema(this.host.app.get_active_window(), options), fields => {
            if (fields) view.commit(withSchema(view.getBoard(), fields));
        });
    }

    // The "Board View" menu/shortcut: toggles between board/inbox and text for a kanban or inbox document.
    toggle(on: boolean): void {
        const doc = this.host.active();
        const text = doc.editor.getText();
        if (on && !isStructured(text)) {
            this.host.toast(_('This document has no layout (it needs "layout: board", "list", "table", "calendar", "timeline", "gallery", or "chart" in the frontmatter)'));
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
    private writeInbox(board: Board): void {
        const doc = this.host.active();
        const text = serializeBoard(board);
        this.state(doc).boardText = text;
        doc.editor.replaceText(text);
        this.host.statusBar.setInboxCounts(countCards(board));
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
            if (!isStructured(text)) return 'the board file is no longer a board (its frontmatter has no "layout:")';
            const board = parseBoard(text);
            const next = edit(board);
            if (next === board) return null;
            if (doc === this.host.active() && this.boardMode) {
                this.setBoardView(next);
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
        if (doc !== this.host.active() || !this.structuredMode || state.reloadQueued) return;
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
        const view = this.currentView();
        if (!isStructuredPage(view) || text === state.boardText) return;
        const layout = layoutOf(text);
        if (!layout) {
            state.textOverride = true;   // no longer a layout (the frontmatter was removed)
            this.show('text');
            return;
        }
        if (PAGE_OF[layout] !== view) {
            this.show(PAGE_OF[layout]);   // the layout was changed in the text (by an undo, or the assistant): follow it
            return;
        }
        state.boardText = text;
        this.viewOf(view)?.setBoard(parseBoard(text));
        this.showCounts(view);
    }
}
