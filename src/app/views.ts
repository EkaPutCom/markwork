// What the content area shows for the active document: its text, a kanban board, an inbox, or Home. A board or
// inbox is a view of the document text: changes made in the view are written back to the text (one undo step), and
// text changes made otherwise (undo, typing in source) are read back into the view.

import { readTextFile, writeTextFile, flushWrites } from '../base/files.js';
import { platform } from '../platform/index.js';
import { isStructured, layoutOf, withLayout, LAYOUTS, type Layout } from '../markdown/layout.js';
import { groupBoard, groupFieldOf, ungroupBoard, type Grouped } from '../markdown/boardgroup.js';
import { newList } from '../markdown/inbox.js';
import { newTable } from '../markdown/tablelayout.js';
import { columnCount, fitsTableView, isCsvFile, parseCsv } from '../markdown/csv.js';
import { boardSchema, countCards, declaredFields, fieldUses, newBoard, parseBoard, reservedFields, serializeBoard, withSchema, type Board } from '../markdown/kanban.js';
import type { FieldDef } from '../markdown/fields.js';
import { applyNoteEdit, type NoteEdit } from '../markdown/noteedit.js';
import { _, fmt } from '../base/i18n.js';
import { missingField, withField } from '../markdown/layouthint.js';
import { errorMessage, type Doc, type DocumentHost, type TextEditor } from './document.js';
import type { HomeData } from './home.js';
import type { ProgramsData } from './programs.js';
import { commandIds } from './commands.js';

// Which commands apply to which view is part of the registry (app/commands.ts).
// Text editing commands: off while a board, a list, or Home hides the text.
const TEXT_ACTIONS = commandIds('text');
// Actions that are meaningless on Home (there is no text to save or undo).
const DOCUMENT_ACTIONS = commandIds('document');
// Text actions that the CSV table does as well, in its own way: its find bar searches and replaces in its cells.
const CSV_ACTIONS = ['find', 'replace'];
// Actions that need a board or a list to act on.
const STRUCTURED_ACTIONS = commandIds('structured');

// What the Fields… dialog is shown.
export interface SchemaDialogOptions {
    fields: FieldDef[];                              // the fields the document declares, in order
    reserved: readonly string[];                     // names the document uses itself (due, agent)
    uses: readonly FieldUse[];                       // how many notes have a value for each declared field and option
}

// How many notes have a value for a field (option = null), or for one of its options.
export interface FieldUse {
    key: string;
    option: string | null;
    count: number;
}

// The dialogs of this controller; tests replace them.
export interface ViewDialogs {
    editSchema(options: SchemaDialogOptions): Promise<FieldDef[] | null>;
}

export type LayoutPage = 'calendar' | 'timeline' | 'gallery' | 'chart';
export type View = 'board' | 'inbox' | 'table' | LayoutPage | 'csv' | 'home' | 'programs' | 'html' | 'text';
export type StructuredPage = Exclude<View, 'csv' | 'home' | 'programs' | 'html' | 'text'>;

// The page that shows each layout.
const PAGE_OF: Record<Layout, View> = { board: 'board', list: 'inbox', table: 'table', calendar: 'calendar', timeline: 'timeline', gallery: 'gallery', chart: 'chart' };
const STRUCTURED_PAGES: readonly View[] = Object.values(PAGE_OF);
const isStructuredPage = (name: string | null): name is StructuredPage => STRUCTURED_PAGES.includes(name as View);

// A view that shows a document's notes (board, list, table, calendar, …): it is given the board and reports what the
// user did as an operation (markdown/noteedit.ts), which it has already applied to what it shows.
export interface NotesView {
    onEdit: (edit: NoteEdit) => void;
    setBoard(board: Board): void;
}
export interface KanbanView extends NotesView {
    agentsEnabled: boolean;          // agents can be assigned to cards (not while grouped by a field)
    groupField: string | null;
    replace(board: Board): void;     // show a new board without reporting it
}
// The CSV tab: given the file's text, it reports the text after every change the user makes.
export interface CsvPage {
    onChange: (text: string) => void;
    onShape: (rows: number, columns: number) => void;
    setText(text: string): void;
}
export interface CaptureView extends NotesView {
    focusCapture(): void;            // put the cursor where a new item is typed
}

// The content area and what is around it, as this controller drives them. Which page is shown is this controller's
// record of what it last showed, not something it asks the screen.
export interface ViewScreen<E extends TextEditor> {
    showHome(data: HomeData): void;
    showPrograms(data: ProgramsData): void;
    showPageTab(id: number): void;   // the content of an HTML page tab
    showText(id: number): void;      // the document's own editor page, with the cursor shown and focused
    showPage(page: StructuredPage | 'csv'): void;
    closeFind(): void;
    setStatusVisible(visible: boolean): void;
    setCounts(text: string): void;
    setBoardCounts(lists: number, cards: number): void;
    setInboxCounts(items: number): void;
    setCsvCounts(rows: number, columns: number): void;
    showLayout(layout: Layout | '' | null): void;   // the layout button and menu: '' = the text view, null = hidden (a page)
    setStructuredState(on: boolean): void;          // the Board View toggle
    enableActions(names: readonly string[], enabled: boolean): void;
}

export interface ViewHost<E extends TextEditor> extends DocumentHost<E> {
    readonly screen: ViewScreen<E>;
    readonly board: KanbanView;
    readonly inbox: CaptureView;
    readonly table: CaptureView;
    readonly csv: CsvPage;
    readonly layouts: Record<LayoutPage, NotesView>;   // the calendar, timeline, gallery, and chart pages
    readonly homePage: { data(): HomeData };
    readonly programsPage: { data(): ProgramsData };
    readonly journal: { recordBoard(file: string | null, before: Board, after: Board): void };
    newDocument(text: string): void;   // fill the active empty document, or a new tab, with text
    showRuns(file: string | null): void;   // the board view gets the runs of the cards of board `file` (none for null)
}

// A view's change made again on the board the text holds when the write is made; null = it no longer applies.
type Again = ((current: Board) => Board | null) | null;

// How one document is shown, kept here rather than on the document record.
interface ViewState {
    textOverride: boolean;   // the user chose the text view for this board or inbox
    boardText: string;       // the text the board/inbox last wrote or read; to recognize outside changes (undo)
    csvWritten: string[];    // the last texts the CSV table wrote: over the app protocol the text of an earlier write lands after a later one was made
    reloadQueued: boolean;
}

export class ViewController<E extends TextEditor> {
    private readonly states = new WeakMap<Doc<E>, ViewState>();
    // While the board is grouped by a field (`group:`): the document's own board and the one the board view shows.
    private grouped: { source: Board; view: Grouped; field: FieldDef } | null = null;
    // The document's board as the board view last got it or reported it: the core holds the board, it does not ask the view.
    private board: Board | null = null;
    // The same for the list, table, calendar, timeline, gallery, or chart page that is shown.
    private shown: Board | null = null;
    // The page the content area shows, as this controller last showed it; 'text' also for a page that is not a view of
    // the active document (a pull request, a review). null before the first.
    private page: View | null = null;

    private state(doc: Doc<E>): ViewState {
        let state = this.states.get(doc);
        if (!state) this.states.set(doc, state = { textOverride: false, boardText: '', csvWritten: [], reloadQueued: false });
        return state;
    }

    // dialogs: the frontend's Fields… dialog; tests replace it.
    constructor(private readonly host: ViewHost<E>, public dialogs: ViewDialogs) {
        host.board.onEdit = edit => this.boardEdited(edit);
        host.inbox.onEdit = edit => this.notesEdited(edit);
        host.table.onEdit = edit => this.notesEdited(edit);
        host.csv.onChange = text => this.csvEdited(text);
        host.csv.onShape = (rows, columns) => { if (this.page === 'csv') host.screen.setCsvCounts(rows, columns); };
        for (const view of Object.values(host.layouts)) view.onEdit = edit => this.notesEdited(edit);
    }

    get boardMode(): boolean { return this.page === 'board'; }
    get inboxMode(): boolean { return this.page === 'inbox'; }
    get tableMode(): boolean { return this.page === 'table'; }
    get csvMode(): boolean { return this.page === 'csv'; }
    get homeMode(): boolean { return this.page === 'home'; }
    get programsMode(): boolean { return this.page === 'programs'; }
    // A page that is not a view of a document is shown (Home, Programs, an HTML file): no text, nothing to save.
    get pageMode(): boolean { return this.page === 'home' || this.page === 'programs' || this.page === 'html'; }
    // A board, inbox, table, calendar, timeline, gallery, or chart is shown (a view of the text, not the text itself).
    get structuredMode(): boolean { return isStructuredPage(this.page); }

    // The name of the page that is shown.
    private currentView(): View | null {
        return this.page;
    }

    // The content area shows a page that is not a view of the active document (a pull request, a review).
    otherPage(): void {
        this.page = 'text';
    }

    // New contents were put into doc (opened, emptied, made Home): it is shown as what it is again, not as the
    // text view the user chose for the previous contents.
    replaced(doc: Doc<E>): void {
        this.state(doc).textOverride = false;
        this.sync();
    }

    // A kanban document is shown as a board and an inbox document as an inbox, unless the user chose the text view.
    sync(): void {
        const page = this.host.page();
        if (page) {
            this.show(page.kind);
            return;
        }
        const doc = this.host.active();
        const text = doc.editor.getText();
        const layout = layoutOf(text);
        this.show(!this.state(doc).textOverride && layout ? PAGE_OF[layout] : this.csvOrText(doc));
    }

    // A CSV file is shown as a table unless the user chose the text view, or the table is too big to draw (it is then
    // shown as text, and the toggle says why when asked for the table).
    private csvOrText(doc: Doc<E>): View {
        const state = this.state(doc);
        if (!isCsvFile(doc.file) || layoutOf(doc.editor.getText()) || state.textOverride) return 'text';
        if (csvFits(doc.editor.getText())) return 'csv';
        state.textOverride = true;
        this.host.toast(_('This CSV file is too big for the table view, so it is shown as text'));
        return 'text';
    }

    show(view: View): void {
        const { screen } = this.host;
        const doc = this.host.active();
        this.page = view;
        screen.setStatusVisible(view !== 'home' && view !== 'programs' && view !== 'html');
        if (view === 'home') {
            screen.closeFind();
            screen.showHome(this.host.homePage.data());
        } else if (view === 'programs') {
            screen.closeFind();
            screen.showPrograms(this.host.programsPage.data());
        } else if (view === 'html') {
            screen.closeFind();
            screen.showPageTab(this.host.page()!.id);
        } else if (view === 'text') {
            screen.showText(doc.id);
            screen.setCounts(doc.editor.getText());
        } else if (view === 'csv') {
            const text = doc.editor.getText();
            this.host.csv.setText(text);
            this.state(doc).boardText = text;
            this.state(doc).csvWritten = [];
            screen.closeFind();
            screen.showPage('csv');
            const table = parseCsv(text);
            screen.setCsvCounts(table.rows.length - 1, columnCount(table));
        } else {
            // The view gets its contents before it is shown.
            const text = doc.editor.getText();
            this.viewOf(view)?.setBoard(parseBoard(text));
            this.state(doc).boardText = text;
            screen.closeFind();
            screen.showPage(view);
            this.showCounts(view);
        }
        screen.setStructuredState(isStructuredPage(view) || view === 'csv');
        // The layout button and menu show the layout the document is in (Text for the text view, hidden for Home and a CSV table).
        screen.showLayout(view === 'home' || view === 'programs' || view === 'html' || view === 'csv' ? null : view === 'text' ? '' : layoutOf(doc.editor.getText()) ?? '');
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

    // The view that shows a board, a list, a table, or one of the other layouts (they all read the same model); null for the
    // others. `current` is the board as this controller last sent it or applied an edit to it; `write` shows and writes one.
    private viewOf(view: View | null): { setBoard(board: Board): void; current(): Board; write(board: Board): void } | null {
        if (view === 'board') return { setBoard: b => this.setBoardView(b), current: () => this.currentBoard(), write: b => this.commitBoard(b) };
        const notes = this.notesView(view);
        if (!notes) return null;
        const setBoard = (b: Board) => { this.shown = b; notes.setBoard(b); };
        return { setBoard, current: () => this.shown ?? parseBoard(this.host.active().editor.getText()), write: b => { setBoard(b); this.writeInbox(b); } };
    }

    private notesView(view: View | null): NotesView | null {
        if (view === 'inbox') return this.host.inbox;
        if (view === 'table') return this.host.table;
        return view === 'calendar' || view === 'timeline' || view === 'gallery' || view === 'chart' ? this.host.layouts[view] : null;
    }

    // An edit from the list, table, or a layout, applied to the board this controller holds. One that names a note that is
    // gone (the text changed in between) redraws the view from the board as it is.
    private notesEdited(edit: NoteEdit): void {
        const view = this.viewOf(this.currentView());
        if (!view || this.currentView() === 'board') return;
        const board = view.current();
        const next = applyNoteEdit(board, edit);
        if (!next) view.setBoard(board);
        else if (next !== board) {
            this.shown = next;
            this.writeInbox(next, current => applyNoteEdit(current, edit));
        }
    }

    // The board view gets the document's board, or the board made from the values of a field when the document says `group:`.
    private setBoardView(source: Board): void {
        this.board = source;
        const field = groupFieldOf(source, boardSchema(source));
        this.grouped = field ? { source, view: groupBoard(source, field), field } : null;
        this.host.board.agentsEnabled = !field;
        this.host.board.groupField = field?.key ?? null;
        this.host.showRuns(this.host.active().file);
        this.host.board.setBoard(this.grouped?.view.board ?? source);
    }

    // An edit from the board view. A grouped board's edit is applied to the board the view shows, and written back to
    // the notes; one that names a card that is gone redraws the board from the one this controller holds.
    private boardEdited(edit: NoteEdit): void {
        const grouped = this.grouped;
        const shown = grouped?.view.board ?? this.currentBoard();
        const board = applyNoteEdit(shown, edit);
        if (!board) { this.setBoardView(this.currentBoard()); return; }
        if (board === shown) return;
        if (!grouped) { this.board = board; this.writeBoard(board, current => applyNoteEdit(current, edit)); return; }
        const { field } = grouped;
        const source = ungroupBoard(grouped.source, grouped.view, board, field);
        this.board = source;
        this.grouped = { ...grouped, source, view: groupBoard(source, field) };
        this.host.board.replace(this.grouped.view.board);
        this.writeBoard(source, current => {
            const view = groupBoard(current, field);
            const next = applyNoteEdit(view.board, edit);
            return next && ungroupBoard(current, view, next, field);
        });
    }

    // The document's board: the one the view shows (the source of a grouped one), or the document's text when none was shown.
    currentBoard(): Board {
        return this.grouped?.source ?? this.board ?? parseBoard(this.host.active().editor.getText());
    }

    // A change made outside the board view (the Fields… dialog, a card's menu): shown and written.
    commitBoard(board: Board): void {
        this.setBoardView(board);
        this.writeBoard(board);
    }

    private showCounts(view: StructuredPage): void {
        if (view === 'board') this.showBoardCounts(this.currentBoard());
        else this.host.screen.setInboxCounts(countCards(this.viewOf(view)!.current()));
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

    // Text editor actions are disabled while a board, inbox, or a page (Home, an HTML file) is shown (its text is hidden).
    syncActionsEnabled(): void {
        const page = this.pageMode;
        const structured = this.structuredMode || this.csvMode || page;
        const { screen } = this.host;
        screen.enableActions(TEXT_ACTIONS, !structured);
        screen.enableActions(DOCUMENT_ACTIONS, !page);
        if (this.csvMode) screen.enableActions(CSV_ACTIONS, true);   // the table has its own find
        screen.enableActions(STRUCTURED_ACTIONS, this.structuredMode);
    }

    // The "Fields…" menu: change the fields the board or list declares, written back into its frontmatter (one undo step).
    editFields(): void {
        const view = this.viewOf(this.currentView());
        if (!view) return;
        const board = view.current();
        const fields = declaredFields(board);
        const uses = fields.flatMap((f): FieldUse[] => [
            { key: f.key, option: null, count: fieldUses(board, f.key) },
            ...f.options.map(option => ({ key: f.key, option, count: fieldUses(board, f.key, option) })),
        ]);
        const options: SchemaDialogOptions = { fields, reserved: reservedFields(board), uses };
        void this.dialogs.editSchema(options).then(fields => {
            if (fields) view.write(withSchema(view.current(), fields));
        });
    }

    // The "Board View" menu/shortcut: toggles between board/inbox and text for a kanban or inbox document.
    toggle(on: boolean): void {
        const doc = this.host.active();
        const text = doc.editor.getText();
        if (isCsvFile(doc.file) && !layoutOf(text)) {
            if (on && !csvFits(text)) {
                this.host.toast(_('This CSV file is too big for the table view'));
                this.show('text');
                return;
            }
            this.state(doc).textOverride = !on;
            this.sync();
            return;
        }
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
    private writeInbox(board: Board, again: Again = null): void {
        const state = this.state(this.host.active());
        const base = state.boardText, text = serializeBoard(board);
        state.boardText = text;
        this.writeThrough(base, text, again);
        this.host.screen.setInboxCounts(countCards(board));
    }

    // Changes from the CSV table → document text (one undo step).
    private csvEdited(text: string): void {
        const doc = this.host.active();
        const state = this.state(doc);
        state.boardText = text;   // recognize this change as the table's own
        state.csvWritten = [...state.csvWritten.slice(-7), text];
        doc.editor.replaceText(text);
    }

    // Changes from the board → document text (one undo step).
    private writeBoard(board: Board, again: Again = null): void {
        const base = this.state(this.host.active()).boardText;
        this.writeThrough(base, this.boardWritten(board), again);
    }

    // Write the text of a view's change. With `again` (the user's operation, applied to whatever board the text holds then)
    // it goes through update(): over the app protocol the write may reach the editor after more typing, and is then made
    // again from that text, so neither the typing nor the change is lost. base = the text the view's board was read from:
    // while the editor still holds it, `text` is written as it is. A change that no longer applies (its
    // card was edited away) is told, and the view reads the text.
    private writeThrough(base: string, text: string, again: Again): void {
        const doc = this.host.active();
        if (!again) { doc.editor.replaceText(text); return; }
        doc.editor.update(current => {
            if (current === base) return text;
            const next = isStructured(current) ? again(parseBoard(current)) : null;
            if (!next) {
                this.host.toast(_('The notes changed before the change could be written'));
                return null;
            }
            const redone = serializeBoard(next);
            this.state(doc).boardText = redone;   // recognize this change as the view's own
            return redone;
        });
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
        const doc = this.host.docs().find(d => d.file !== null && platform().paths.same(d.file, file));
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
        if (doc !== this.host.active() || !(this.structuredMode || this.csvMode) || state.reloadQueued) return;
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
        if (view === 'csv') {
            if (text === state.boardText || state.csvWritten.includes(text)) return;
            state.boardText = text;
            this.host.csv.setText(text);
            const table = parseCsv(text);
            this.host.screen.setCsvCounts(table.rows.length - 1, columnCount(table));
            return;
        }
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

// Whether a CSV file is small enough for the table view.
function csvFits(text: string): boolean {
    return fitsTableView(parseCsv(text));
}
