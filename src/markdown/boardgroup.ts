// A board whose columns are the values of a select field instead of `##` headings:
//
//   ---
//   layout: board
//   group: status                    ← the select field whose values are the columns
//   fields:
//     status: select(todo, doing, done)
//   ---
//
// The board view shows a derived board (`groupBoard`): a column per option in the order the field lists them, then the
// values the notes have when the field lists no options, and first a column without a title for the notes that have no value (only
// when there are any). A change made on the derived board is written back to the notes (`ungroupBoard`): moving a note
// to another column sets its field, an edited note keeps its edit, a new note gets the value of its column, a deleted
// note is removed, and a new column adds an option. The order of the notes inside a column is the order of the
// document, so dragging within a column does not change anything. Pure TypeScript.

import type { FieldDef } from './fields.js';
import { OPTION_TEXT, readItem, writeField } from './fields.js';
import { optionOf } from './layout.js';
import { boardSchema, withFieldOption, type Board, type Card, type Column, type Position } from './kanban.js';

// The select field the board is grouped by, or null for an ordinary board.
export function groupFieldOf(board: Board, schema: FieldDef[] = boardSchema(board)): FieldDef | null {
    const key = optionOf(board.head.join('\n'), 'group');
    return schema.find(f => f.key === key && f.type === 'select' && !f.multiple) ?? null;
}

export interface Grouped {
    board: Board;
    origin: Position[][];   // where each card of `board` is in the source, by column and index
}

const valueOf = (card: Card, def: FieldDef): string | null => {
    const parsed = readItem(card.text, [def]).fields[def.key];
    return parsed?.ok && !Array.isArray(parsed.value) && typeof parsed.value === 'string' ? parsed.value : null;
};

export function groupBoard(source: Board, def: FieldDef): Grouped {
    const names: (string | null)[] = [...def.options];
    const members = new Map<string | null, { card: Card; at: Position }[]>();
    source.columns.forEach((column, c) => column.cards.forEach((card, index) => {
        const value = valueOf(card, def);
        if (value !== null && !names.includes(value)) names.push(value);
        members.set(value, [...(members.get(value) ?? []), { card, at: { column: c, index } }]);
    }));
    if (members.has(null)) names.unshift(null);
    const columns: Column[] = names.map(name => ({ title: name ?? '', intro: [], outro: [], cards: (members.get(name) ?? []).map(m => m.card) }));
    return { board: { ...source, columns }, origin: names.map(name => (members.get(name) ?? []).map(m => m.at)) };
}

const same = (a: Card, b: Card): boolean => a.text === b.text && a.done === b.done && a.notes.join('\n') === b.notes.join('\n');

interface Was { card: Card; column: string; at: Position; used: boolean }
interface Now { card: Card; column: string; match: Was | null }

const usable = (title: string, known: Set<string>): boolean => title === '' || known.has(title) || OPTION_TEXT.test(title);

// The cards of the derived board before the change, with where each came from in the source.
function cardsBefore(before: Grouped): Was[] {
    return before.board.columns.flatMap((column, c) => column.cards.map((card, i): Was => ({ card, column: column.title, at: before.origin[c][i], used: false })));
}

// The cards after the change, each matched to a card before it if it did not change (a move changes only the column).
function cardsAfter(after: Board, was: Was[], known: Set<string>): Now[] {
    return after.columns.filter(column => usable(column.title, known)).flatMap(column => column.cards.map((card): Now => {
        const match = was.find(w => !w.used && same(w.card, card)) ?? null;
        if (match) match.used = true;
        return { card, column: column.title, match };
    }));
}

const withValue = (card: Card, def: FieldDef, title: string): Card => ({ ...card, text: writeField(card.text, def, title === '' ? null : title) });

// The source with the changes made on the derived board `after` (which started as `before`) written back to the notes.
export function ungroupBoard(source: Board, before: Grouped, after: Board, def: FieldDef): Board {
    const known = new Set(before.board.columns.map(c => c.title));
    // A new column is a new option of the field (a title the field cannot hold is left out).
    const result = after.columns.reduce((board, column) =>
        column.title && !known.has(column.title) && OPTION_TEXT.test(column.title) && !def.options.includes(column.title) ? withFieldOption(board, def.key, column.title) : board, source);
    const was = cardsBefore(before);
    const now = cardsAfter(after, was, known);

    const cards = result.columns.map(c => c.cards.slice());
    for (const n of now) if (n.match && n.match.column !== n.column) cards[n.match.at.column][n.match.at.index] = withValue(n.match.card, def, n.column);

    // What is left over is paired in order: an edit (the card keeps its edit, and takes the column if it changed), then
    // new cards, or deleted ones.
    const changed = now.filter(n => !n.match);
    const left = was.filter(w => !w.used);
    changed.forEach((n, i) => {
        if (left[i]) cards[left[i].at.column][left[i].at.index] = n.column === left[i].column ? n.card : withValue(n.card, def, n.column);
    });
    const gone = new Set(left.slice(changed.length).map(w => `${w.at.column}.${w.at.index}`));
    const added = changed.slice(left.length).map(n => withValue(n.card, def, n.column));

    const columns: Column[] = result.columns.map((column, c) => ({ ...column, cards: cards[c].filter((_, i) => !gone.has(`${c}.${i}`)) }));
    if (added.length && !columns.length) columns.push({ title: '', intro: [], outro: [], cards: [] });
    if (added.length) columns[0] = { ...columns[0], cards: [...columns[0].cards, ...added] };
    return { ...result, columns };
}
