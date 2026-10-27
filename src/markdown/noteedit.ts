// One change a view of a document's notes makes (a board, a list, a table, a calendar, a timeline, a chart): what the
// user did, not the board that resulted. A whole board is a picture of one moment, so an edit that arrives after the
// text changed (an undo, a harness run that moved another card) could only overwrite that change or be dropped; an
// operation is applied again to the board as it is now (docs/design/protocol.md, section 6.3). The view applies the
// same operation to its own board at once, so a drag does not wait for the core.
//
// A card is named by its position and its text. When the card at the position is no longer that text, it is looked for
// by its text, in its column first; found once, the edit applies there; found never or more than once, the edit is
// stale (null) and the view is drawn again from the board as it is.

import { addCard, addColumn, boardSchema, composeCard, deleteCard, deleteColumn, deleteColumnKeepCards, moveCard, moveColumn, placeMove,
    renameColumn, setCardField, toggleDone, updateCard, withFieldOption, type Board, type Position } from './kanban';
import { captureItem, composeItem } from './inbox';
import { moveToDate, textForDate } from './calendar';
import { resizeRow, shiftRow } from './timeline';
import { withCharts, type ChartItem } from './chart';
import { setField, type FieldDef } from './fields';

// A card as an edit names it: where it was and what its first line said.
export interface CardRef {
    at: Position;
    card: string;
}

// A group (a list of a board, a section of an inbox) as an edit names it.
export interface ColumnRef {
    column: number;
    title: string;
}

// What the card or note dialog answers: the parts the user filled in, not the text they make. The text is composed when
// the edit is applied, from the card as it is then, so the fields the dialog does not show are kept.
export interface CardForm {
    kind: 'card' | 'note';   // a board's card (with its due date and agent), or a note of a list, a table, or a layout
    title: string;
    tags: string[];
    due: string;             // a card's; '' for a note
    agent: string;           // a card's; '' = not assigned
    fields: { field: FieldDef; text: string }[];   // the document's fields as the dialog showed them; an empty text removes one
}

// A card's first line: typed as is (a quick capture), or a dialog's parts.
export type CardText = string | CardForm;

// The first line `value` makes for a card whose first line was `previous`.
export function cardText(value: CardText, previous = ''): string {
    if (typeof value === 'string') return value;
    const base = value.kind === 'card'
        ? composeCard({ title: value.title, tags: value.tags, due: value.due, agent: value.agent }, previous)
        : composeItem(value.title, value.tags, previous);
    return value.fields.reduce((text, f) => setField(text, f.field, f.text), base);
}

export type NoteEdit =
    | { kind: 'add'; column: number; text: CardText; notes: string[]; now: number }        // a card at the end of a list
    | { kind: 'capture'; text: CardText; notes: string[]; now: number; date?: string }      // a note captured into a list or table (on a day of the calendar)
    | (CardRef & { kind: 'update'; text?: CardText; notes?: string[] })
    | (CardRef & { kind: 'delete' })
    | (CardRef & { kind: 'move'; to: Position })
    | (CardRef & { kind: 'place'; point: Position })                                        // dropped between notes (inbox)
    | (CardRef & { kind: 'toggle' })                                                         // done / not done
    | (CardRef & { kind: 'field'; key: string; raw: string; field: FieldDef; option: string | null })   // option: a new select option, written with it
    | (CardRef & { kind: 'section'; title: string })                                        // into a new (or the same-named) section
    | (CardRef & { kind: 'date'; date: string })                                            // dropped on a day of the calendar
    | (CardRef & { kind: 'shift'; days: number })                                           // a timeline bar moved
    | (CardRef & { kind: 'resize'; edge: 'start' | 'end'; days: number })                   // a timeline bar's edge moved
    | { kind: 'addColumn'; title: string }
    | (ColumnRef & { kind: 'renameColumn'; to: string })
    | (ColumnRef & { kind: 'deleteColumn'; keepCards: boolean })
    | (ColumnRef & { kind: 'moveColumn'; to: number })
    | { kind: 'charts'; items: ChartItem[] | null };                                        // the panels of a chart

// Where the card an edit names is now, or null when it cannot be told.
export function findCard(board: Board, ref: CardRef): Position | null {
    const { at, card } = ref;
    if (board.columns[at.column]?.cards[at.index]?.text === card) return at;
    const own = board.columns[at.column]?.cards.flatMap((c, index) => c.text === card ? [index] : []) ?? [];
    if (own.length === 1) return { column: at.column, index: own[0] };
    if (own.length > 1) return null;
    const all = board.columns.flatMap((col, column) => col.cards.flatMap((c, index) => c.text === card ? [{ column, index }] : []));
    return all.length === 1 ? all[0] : null;
}

function findColumn(board: Board, ref: ColumnRef): number | null {
    if (board.columns[ref.column]?.title === ref.title) return ref.column;
    const found = board.columns.flatMap((c, i) => c.title === ref.title ? [i] : []);
    return found.length === 1 ? found[0] : null;
}

// The board after `edit`, or null when the card or group it names cannot be found any more.
export function applyNoteEdit(board: Board, edit: NoteEdit): Board | null {
    switch (edit.kind) {
        case 'add': {
            if (!board.columns[edit.column]) return null;
            const index = board.columns[edit.column].cards.length;
            const added = addCard(board, edit.column, cardText(edit.text), Infinity, new Date(edit.now));
            return edit.notes.length && added !== board ? updateCard(added, { column: edit.column, index }, { notes: edit.notes }) : added;
        }
        case 'capture': {
            const text = cardText(edit.text);
            if (!text.trim()) return board;
            return captureItem(board, edit.date ? textForDate(text, edit.date, board) : text, new Date(edit.now), edit.notes);
        }
        case 'addColumn': return addColumn(board, edit.title);
        case 'charts': return withCharts(board, edit.items);
        case 'renameColumn': case 'deleteColumn': case 'moveColumn': return columnEdit(board, edit);
        default: {
            const at = findCard(board, edit);
            return at && cardEdit(board, at, edit);
        }
    }
}

function columnEdit(board: Board, edit: Extract<NoteEdit, ColumnRef>): Board | null {
    const column = findColumn(board, edit);
    if (column === null) return null;
    switch (edit.kind) {
        case 'renameColumn': return renameColumn(board, column, edit.to);
        case 'deleteColumn': return edit.keepCards ? deleteColumnKeepCards(board, column) : deleteColumn(board, column);
        case 'moveColumn': return moveColumn(board, column, edit.to + (column - edit.column));
    }
}

function cardEdit(board: Board, at: Position, edit: Extract<NoteEdit, CardRef>): Board {
    switch (edit.kind) {
        case 'update': return updated(board, at, edit);
        case 'delete': return deleteCard(board, at);
        case 'move': return moveCard(board, at, edit.to);
        case 'place': return placeMove(board, at, edit.point);
        case 'toggle': return toggleDone(board, at);
        case 'field': return withField(board, at, edit);
        case 'section': return intoSection(board, at, edit.title);
        case 'date': return moveToDate(board, at, edit.date);
        case 'shift': return shiftRow(board, at, edit.days);
        case 'resize': return resizeRow(board, at, edit.edge, edit.days);
    }
}

function updated(board: Board, at: Position, edit: Extract<NoteEdit, { kind: 'update' }>): Board {
    const text = edit.text === undefined ? undefined : cardText(edit.text, board.columns[at.column].cards[at.index].text);
    if (text !== undefined && !text.trim()) return board;   // a dialog that left nothing changes nothing
    return updateCard(board, at, { ...(text !== undefined && { text }), ...(edit.notes && { notes: edit.notes }) });
}

// A new option is written first, and the value is checked against the list that now includes it.
function withField(board: Board, at: Position, edit: Extract<NoteEdit, { kind: 'field' }>): Board {
    const next = edit.option ? withFieldOption(board, edit.key, edit.option) : board;
    return setCardField(next, at, boardSchema(next).find(f => f.key === edit.key) ?? edit.field, edit.raw);
}

// A new section at the end with the note moved into it; a name that is already a section (ignoring case) moves the
// note into that one instead of making a second.
function intoSection(board: Board, at: Position, title: string): Board {
    const existing = board.columns.findIndex(c => c.title.toLowerCase() === title.toLowerCase());
    const next = existing >= 0 ? board : addColumn(board, title);
    const into = existing >= 0 ? existing : next.columns.length - 1;
    return into === at.column ? next : moveCard(next, at, { column: into, index: Infinity });
}
