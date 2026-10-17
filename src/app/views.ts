// What the content area shows for the active document: its text, a kanban board, an inbox, or Home. A board or
// inbox is a view of the document text: changes made in the view are written back to the text (one undo step), and
// text changes made otherwise (undo, typing in source) are read back into the view.

import { readTextFile, writeTextFile, flushWrites } from '../files.js';
import { platform } from '../platform/index.js';
import { isStructured, layoutOf, withLayout, LAYOUTS, type Layout } from '../markdown/layout.js';
import { groupBoard, groupFieldOf, ungroupBoard, type Grouped } from '../markdown/boardgroup.js';
import { newList } from '../markdown/inbox.js';
import { newTable } from '../markdown/tablelayout.js';
import { boardSchema, countCards, declaredFields, fieldUses, newBoard, parseBoard, reservedFields, serializeBoard, withSchema, type Board } from '../markdown/kanban.js';
import type { FieldDef } from '../markdown/fields.js';
import { after, type Awaitable } from '../awaitable.js';
import { _, fmt } from '../i18n.js';
import { missingField, withField } from '../markdown/layouthint.js';
import { errorMessage, type Doc, type DocumentHost, type TextEditor } from './document.js';
import type { HomeData } from './home.js';
import { commandIds } from './commands.js';

// Which commands apply to which view is part of the registry (app/commands.ts).
// Text editing commands: off while a board, a list, or Home hides the text.
const TEXT_ACTIONS = commandIds('text');
// Actions that are meaningless on Home (there is no text to save or undo).
const DOCUMENT_ACTIONS = commandIds('document');
// Actions that need a board or a list to act on.
const STRUCTURED_ACTIONS = commandIds('structured');

// What the Fields… dialog is shown.
export interface SchemaDialogOptions {
    fields: FieldDef[];                              // the fields the document declares, in order
    reserved: readonly string[];                     // names the document uses itself (due, agent)
    uses(key: string, option?: string): number;      // how many notes have a value for the field (or that option)
}

// The dialogs of this controller; tests replace them.
export interface ViewDialogs {
    editSchema(options: SchemaDialogOptions): Awaitable<FieldDef[] | null>;
}

export type LayoutPage = 'calendar' | 'timeline' | 'gallery' | 'chart';
export type View = 'board' | 'inbox' | 'table' | LayoutPage | 'home' | 'text';
export type StructuredPage = Exclude<View, 'home' | 'text'>;

// The page that shows each layout.
const PAGE_OF: Record<Layout, View> = { board: 'board', list: 'inbox', table: 'table', calendar: 'calendar', timeline: 'timeline', gallery: 'gallery', chart: 'chart' };
const STRUCTURED_PAGES: readonly View[] = Object.values(PAGE_OF);
const isStructuredPage = (name: string | null): name is StructuredPage => STRUCTURED_PAGES.includes(name as View);

// A view that shows a document's notes (board, list, table, calendar, …): it is given the board and reports changes.
export interface NotesView {
    onChange: (board: Board) => void;
    setBoard(board: Board): void;
    getBoard(): Board;
    commit(board: Board): void;      // a change made outside the view (the Fields… dialog): shown and reported
}
export interface KanbanView extends NotesView {
    agentsEnabled: boolean;          // agents can be assigned to cards (not while grouped by a field)
    groupField: string | null;
    replace(board: Board): void;     // show a new board without reporting it
}
export interface CaptureView extends NotesView {
    focusCapture(): void;            // put the cursor where a new item is typed
}

// The content area and what is around it, as this controller drives them.
export interface ViewScreen<E extends TextEditor> {
    page(): string | null;           // 'home', a structured page name, or another page (a document's text, a review)
    showHome(data: HomeData): void;
    showText(doc: Doc<E>): void;     // the document's own editor page, with the cursor shown and focused
    showPage(page: StructuredPage): void;
    closeFind(): void;
    setStatusVisible(visible: boolean): void;
    setCounts(text: string): void;
    setBoardCounts(lists: number, cards: number): void;
    setInboxCounts(items: number): void;
    showLayout(layout: Layout | '' | null): void;   // the layout button and menu: '' = the text view, null = hidden (Home)
    setStructuredState(on: boolean): void;          // the Board View toggle
    enableActions(names: readonly string[], enabled: boolean): void;
}

export interface ViewHost<E extends TextEditor> extends DocumentHost<E> {
    readonly screen: ViewScreen<E>;
    readonly board: KanbanView;
    readonly inbox: CaptureView;
    readonly table: CaptureView;
    readonly layouts: Record<LayoutPage, NotesView>;   // the calendar, timeline, gallery, and chart pages
    readonly homePage: { data(): HomeData };
    readonly journal: { recordBoard(file: string | null, before: Board, after: Board): void };
    newDocument(text: string): void;   // fill the active empty document, or a new tab, with text
}

// How one document is shown, kept here rather than on the document record.
interface ViewState {
    textOverride: boolean;   // the user chose the text view for this board or inbox
    boardText: string;       // the text the board/inbox last wrote or read; to recognize outside changes (undo)
    reloadQueued: boolean;
}

export class ViewController<E extends TextEditor> {
    private readonly states = new WeakMap<Doc<E>, ViewState>();
    // While the board is grouped by a field (`group:`): the document's own board and the one the board view shows.
    private grouped: { source: Board; view: Grouped; field: FieldDef } | null = null;

    private state(doc: Doc<E>): ViewState {
        let state = this.states.get(doc);
        if (!state) this.states.set(doc, state = { textOverride: false, boardText: '', reloadQueued: false });
        return state;
    }

    // dialogs: the frontend's Fields… dialog; tests replace it.
    constructor(private readonly host: ViewHost<E>, public dialogs: ViewDialogs) {
        host.board.onChange = board => this.boardChanged(board);
        host.inbox.onChange = inbox => this.writeInbox(inbox);
        host.table.onChange = table => this.writeInbox(table);
        for (const view of Object.values(host.layouts)) view.onChange = board => this.writeInbox(board);
    }

    get boardMode(): boolean { return this.host.screen.page() === 'board'; }
    get inboxMode(): boolean { return this.host.screen.page() === 'inbox'; }
    get tableMode(): boolean { return this.host.screen.page() === 'table'; }
    get homeMode(): boolean { return this.host.screen.page() === 'home'; }
    // A board, inbox, table, calendar, timeline, gallery, or chart is shown (a view of the text, not the text itself).
    get structuredMode(): boolean { return isStructuredPage(this.host.screen.page()); }

    // The name of the page that is shown.
    private currentView(): View | null {
        const name = this.host.screen.page();
        return name === 'home' || isStructuredPage(name) ? name : name ? 'text' : null;
    }

    // New contents were put into doc (opened, emptied, made Home): it is shown as what it is again, not as the
    // text view the user chose for the previous contents.
    replaced(doc: Doc<E>): void {
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
        const { screen } = this.host;
        const doc = this.host.active();
        screen.setStatusVisible(view !== 'home');
        if (view === 'home') {
            screen.closeFind();
            screen.showHome(this.host.homePage.data());
        } else if (view === 'text') {
            screen.showText(doc);
            screen.setCounts(doc.editor.getText());
        } else {
            // The view gets its contents before it is shown.
            const text = doc.editor.getText();
            this.viewOf(view)?.setBoard(parseBoard(text));
            this.state(doc).boardText = text;
            screen.closeFind();
            screen.showPage(view);
            this.showCounts(view);
        }
        screen.setStructuredState(isStructuredPage(view));
        // The layout button and menu show the layout the document is in (Text for the text view, hidden for Home).
        screen.showLayout(view === 'home' ? null : view === 'text' ? '' : layoutOf(doc.editor.getText()) ?? '');
        this.syncActionsEnabled();
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
    private offerField(doc: Doc<E>, layout: Layout): void {
        const board = parseBoard(doc.editor.getText());
        const def = missingField(board, layout);
        if (!def) return;
        const message = def.type === 'date'
            ? _('This layout places notes by a date field, and the document has none')
            : _('This layout groups notes by a select field, and the document has none');
        this.host.toast(message, {
            label: fmt(_('Add “{field}”'), { field: def.key }),
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
        else this.host.screen.setInboxCounts(countCards(this.viewOf(view)!.getBoard()));
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
        const { screen } = this.host;
        screen.enableActions(TEXT_ACTIONS, !structured);
        screen.enableActions(DOCUMENT_ACTIONS, !home);
        screen.enableActions(STRUCTURED_ACTIONS, this.structuredMode);
    }

    // The "Fields…" menu: change the fields the board or list declares, written back into its frontmatter (one undo step).
    editFields(): void {
        const view = this.viewOf(this.currentView());
        if (!view) return;
        const board = view.getBoard();
        const options: SchemaDialogOptions = { fields: declaredFields(board), reserved: reservedFields(board), uses: (key, option) => fieldUses(board, key, option) };
        void after(this.dialogs.editSchema(options), fields => {
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
        this.host.screen.setBoardCounts(board.columns.length, countCards(board));
    }

    // Changes from the inbox → document text (one undo step).
    private writeInbox(board: Board): void {
        const doc = this.host.active();
        const text = serializeBoard(board);
        this.state(doc).boardText = text;
        doc.editor.replaceText(text);
        this.host.screen.setInboxCounts(countCards(board));
    }

    // Changes from the board → document text (one undo step).
    private writeBoard(board: Board): void {
        this.host.active().editor.replaceText(this.boardWritten(board));
    }

    // What writing `board` to the active document involves besides the text itself: the journal records the change, the
    // board recognizes the text as its own, and the counts follow. Returns the text.
    private boardWritten(board: Board): string {
        const doc = this.host.active();
        const state = this.state(doc);
        if (state.boardText) this.host.journal.recordBoard(doc.file, parseBoard(state.boardText), board);
        const text = serializeBoard(board);
        state.boardText = text;   // recognize this change as the board's own
        this.showBoardCounts(board);
        return text;
    }

    // Change the board in `file` for the orchestrator: through its editor if open (one undo step), otherwise directly on
    // disk. The error, if any; an open document whose editor applies the change later (over the app protocol) reports
    // its error as a toast instead.
    updateBoardFile(file: string, edit: (board: Board) => Board): string | null {
        const doc = this.host.docs().find(d => d.file === file);
        if (!doc) return this.updateBoardOnDisk(file, edit);
        let returned = false, error: string | null = null;
        doc.editor.update(text => {
            const result = this.editedBoard(doc, file, text, edit);
            if (typeof result === 'string' || result === null) {
                error = result;
                if (error && returned) this.host.toast(error);   // applied later: the caller has its answer already
                return null;
            }
            return result.text;
        });
        returned = true;
        return error;
    }

    // The board of an open document after `edit`: its text, null when nothing changed, or an error. Applied as the editor
    // runs it, so it reads the text as it is then, including earlier writes of the same turn.
    private editedBoard(doc: Doc<E>, file: string, text: string, edit: (board: Board) => Board): { text: string } | string | null {
        try {
            if (!isStructured(text)) return 'the board file is no longer a board (its frontmatter has no "layout:")';
            const board = parseBoard(text);
            const next = edit(board);
            if (next === board) return null;
            if (doc === this.host.active() && this.boardMode) {
                this.setBoardView(next);
                return { text: this.boardWritten(next) };   // records its own activity
            }
            this.host.journal.recordBoard(file, board, next);
            return { text: serializeBoard(next) };
        } catch (e) {
            return errorMessage(e);
        }
    }

    private updateBoardOnDisk(file: string, edit: (board: Board) => Board): string | null {
        try {
            flushWrites(file);
            const text = readTextFile(file);
            if (!isStructured(text)) return 'the board file is no longer a board (its frontmatter has no "layout:")';
            const board = parseBoard(text);
            const next = edit(board);
            if (next === board) return null;
            writeTextFile(file, serializeBoard(next));
            this.host.journal.recordBoard(file, board, next);
            return null;
        } catch (e) {
            return errorMessage(e);
        }
    }

    // The text of a document shown as a board or inbox changed (undo, for example): read it back into the view.
    queueReload(doc: Doc<E>): void {
        const state = this.state(doc);
        if (doc !== this.host.active() || !this.structuredMode || state.reloadQueued) return;
        state.reloadQueued = true;
        // Deferred: undo changes the text in several steps, and what is read must be the final result.
        platform().scheduler.idleAfter(0, () => {
            state.reloadQueued = false;
            if (doc === this.host.active() && this.host.docs().includes(doc)) this.reload(doc);
        });
    }

    private reload(doc: Doc<E>): void {
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
