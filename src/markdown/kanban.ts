// Kanban board in a Markdown file. Frontmatter marks the document as a board (see layout.ts):
//
//   ---
//   layout: board
//   ---
//
// Existing frontmatter is kept as is when saved. Contents:
//
//   ## Plan                         ← heading level 2 = list (column)
//
//   - [ ] Write the report #important  ← list item = card; [x] = done
//     card note (indented)          ← an indented line = card note
//   - [ ] Send invitations [due:: 2026-10-20]
//   - [ ] Fix checkout [agent:: pi]  ← the harness assigned to work on the card
//
// `[key:: value]` is a typed field (see fields.ts); a card has the fields in CARD_SCHEMA.
//
//   ## Done
//
//   - [x] Book the venue
//
//   %% kanban:settings
//   ...                             ← the rest is kept as is
//
// Pure TypeScript without GTK. All operations return a new board; the original board
// is not changed, so it is easy to test.

import { addOption, applyDefaults, fieldChips, fieldInputText, findSegments, missingFields, parseSchema, readItem, setField, writeField, type DateValue, type FieldChip, type FieldDef } from './fields.js';

export interface Card {
    done: boolean | null;   // null = plain item without a checkbox ("- text")
    text: string;           // first line of the card, raw Markdown (including #tag and [key:: value] fields)
    notes: string[];        // notes: continuation lines of the card, without indentation
}

export interface Column {
    title: string;
    intro: string[];        // plain lines before the first card (e.g. "**Complete**")
    cards: Card[];
    outro: string[];        // plain lines after the last card (e.g. "***")
}

export interface Board {
    head: string[];         // all lines before the first list: frontmatter and title
    columns: Column[];
    footer: string[];       // from "%% kanban:settings" to the end of the file
}

export interface Position {
    column: number;
    index: number;
}

export const DEFAULT_HEAD = ['---', 'layout: board', '---'];

const COLUMN = /^##\s+(.*?)\s*$/;
const CARD = /^[-*+]\s+(?:\[([ xX])\]\s?)?(.*)$/;
const FOOTER = /^%%\s*kanban:settings/;
const INDENTED = /^( {2,}|\t)/;

// ---------- Recognizing and reading ----------

export const trimBlankEnds = (lines: string[]): string[] => {
    let a = 0, b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b);
};

const nextNonBlank = (lines: string[], from: number): string | undefined => {
    for (let i = from; i < lines.length; i++) if (lines[i].trim()) return lines[i];
    return undefined;
};

export function parseColumn(title: string, lines: string[]): Column {
    const column: Column = { title, intro: [], cards: [], outro: [] };
    let current: Card | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = CARD.exec(line);
        if (m && !INDENTED.test(line)) {
            current = { done: m[1] === undefined ? null : m[1] !== ' ', text: m[2], notes: [] };
            column.cards.push(current);
        } else if (current && INDENTED.test(line)) {
            current.notes.push(line.replace(/^( {2}|\t)/, ''));
        } else if (!line.trim()) {
            // A blank line in the middle of a card's notes is kept; otherwise it is only a separator.
            if (current && INDENTED.test(nextNonBlank(lines, i + 1) ?? '')) current.notes.push('');
        } else {
            current = null;
            (column.cards.length ? column.outro : column.intro).push(line);
        }
    }
    return column;
}

export function parseBoard(text: string): Board {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const footerAt = lines.findIndex(l => FOOTER.test(l));
    const body = footerAt >= 0 ? lines.slice(0, footerAt) : lines;
    const footer = footerAt >= 0 ? trimBlankEnds(lines.slice(footerAt)) : [];

    const firstColumn = body.findIndex(l => COLUMN.test(l));
    const head = trimBlankEnds(firstColumn >= 0 ? body.slice(0, firstColumn) : body);
    const columns: Column[] = [];
    if (firstColumn >= 0) {
        let start = firstColumn;
        for (let i = firstColumn + 1; i <= body.length; i++) {
            if (i < body.length && !COLUMN.test(body[i])) continue;
            columns.push(parseColumn(COLUMN.exec(body[start])![1], body.slice(start + 1, i)));
            start = i;
        }
    }
    return { head, columns, footer };
}

// ---------- Writing ----------

export function serializeBoard(board: Board): string {
    const out: string[] = [...(board.head.length ? board.head : DEFAULT_HEAD), ''];
    for (const column of board.columns) {
        out.push(`## ${column.title}`, '');
        if (column.intro.length) out.push(...column.intro, '');
        for (const card of column.cards) {
            const box = card.done === null ? '' : card.done ? '[x] ' : '[ ] ';
            out.push(`- ${box}${card.text}`, ...card.notes.map(n => (n ? `  ${n}` : '')));
        }
        if (column.cards.length) out.push('');
        if (column.outro.length) out.push(...column.outro, '');
    }
    if (board.footer.length) out.push(...board.footer, '');
    return `${trimBlankEnds(out).join('\n')}\n`;
}

// New board with empty lists.
export function newBoard(titles: string[] = ['Plan', 'In Progress', 'Done']): Board {
    return { head: [...DEFAULT_HEAD], columns: titles.map(title => ({ title, intro: [], cards: [], outro: [] })), footer: [] };
}

export const countCards = (board: Board): number => board.columns.reduce((n, c) => n + c.cards.length, 0);

// ---------- Operations ----------

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

function withColumn(board: Board, column: number, change: (c: Column) => Column): Board {
    return { ...board, columns: board.columns.map((c, i) => (i === column ? change(c) : c)) };
}

// Insert a card at `index` (default: at the bottom). With `now`, the card also gets the default of every field the
// board declares that its text does not set.
export function addCard(board: Board, column: number, text: string, index = Infinity, now: Date | null = null): Board {
    const title = text.trim();
    if (!title) return board;
    const full = now ? applyDefaults(title, boardSchema(board), now) : title;
    return withColumn(board, column, c => {
        const cards = [...c.cards];
        cards.splice(clamp(index, 0, cards.length), 0, { done: false, text: full, notes: [] });
        return { ...c, cards };
    });
}

export function updateCard(board: Board, at: Position, patch: Partial<Card>): Board {
    return withColumn(board, at.column, c => ({ ...c, cards: c.cards.map((card, i) => (i === at.index ? { ...card, ...patch } : card)) }));
}

// A plain card ("- text") becomes done on the first toggle.
export const toggleDone = (board: Board, at: Position): Board =>
    updateCard(board, at, { done: board.columns[at.column]?.cards[at.index]?.done !== true });

export function deleteCard(board: Board, at: Position): Board {
    return withColumn(board, at.column, c => ({ ...c, cards: c.cards.filter((_, i) => i !== at.index) }));
}

// Move a card. to.index is the final position of the card in the destination list (after the card
// is taken out of the source list), so moving down within the same list needs
// no special adjustment.
export function moveCard(board: Board, from: Position, to: Position): Board {
    const card = board.columns[from.column]?.cards[from.index];
    if (!card || !board.columns[to.column]) return board;
    const removed = deleteCard(board, from);
    return withColumn(removed, to.column, c => {
        const cards = [...c.cards];
        cards.splice(clamp(to.index, 0, cards.length), 0, card);
        return { ...c, cards };
    });
}

export function addColumn(board: Board, title: string, index = Infinity): Board {
    const name = title.trim();
    if (!name) return board;
    const columns = [...board.columns];
    columns.splice(clamp(index, 0, columns.length), 0, { title: name, intro: [], cards: [], outro: [] });
    return { ...board, columns };
}

export function renameColumn(board: Board, column: number, title: string): Board {
    const name = title.trim();
    return name ? withColumn(board, column, c => ({ ...c, title: name })) : board;
}

export const deleteColumn = (board: Board, column: number): Board =>
    ({ ...board, columns: board.columns.filter((_, i) => i !== column) });

export function moveColumn(board: Board, from: number, to: number): Board {
    const column = board.columns[from];
    if (!column) return board;
    const columns = board.columns.filter((_, i) => i !== from);
    columns.splice(clamp(to, 0, columns.length), 0, column);
    return { ...board, columns };
}

// ---------- Card content ----------

// The typed fields every card understands. A document-specific schema (fields.ts `parseSchema`) can add more.
export const DUE_FIELD: FieldDef = { key: 'due', type: 'date', multiple: false, options: [] };
export const AGENT_FIELD: FieldDef = { key: 'agent', type: 'agent', multiple: false, options: [] };
export const CARD_SCHEMA: FieldDef[] = [DUE_FIELD, AGENT_FIELD];

export interface CardMeta {
    title: string;         // text without #tag and [key:: value] fields, for display
    tags: string[];
    due: string | null;    // "YYYY-MM-DD"
    agent: string | null;  // the assigned harness ("[agent:: pi]" → "pi")
}

export function cardMeta(text: string): CardMeta {
    const item = readItem(text, CARD_SCHEMA);
    const due = item.fields.due, agent = item.fields.agent;
    return {
        title: item.title,
        tags: item.tags,
        due: due?.ok ? (due.value as DateValue).date : null,
        agent: agent?.ok ? agent.value as string : null,
    };
}

// Split card text into title, tags, and due date (date with time if present) for the
// edit form; composeCard puts them back together.
export interface CardParts {
    title: string;
    tags: string[];
    due: string;
    agent?: string;   // empty = not assigned
}

export const DUE_INPUT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?$/;

// The fields every card understands plus those the board declares in its frontmatter `fields:` block.
export function boardSchema(board: Board): FieldDef[] {
    const declared = parseSchema(board.head.join('\n')).fields;
    return [...CARD_SCHEMA, ...declared.filter(f => !CARD_SCHEMA.some(c => c.key === f.key))];
}

// The fields a card has no value for yet, which can be filled in from the card. The agent has its own menu.
export function cardMissingFields(text: string, schema: FieldDef[]): FieldDef[] {
    return missingFields(readItem(text, schema), schema, [AGENT_FIELD.key]);
}

// The card at `at` with its field `def` set from `raw` (empty removes it; a value that does not fit changes nothing).
export function setCardField(board: Board, at: Position, def: FieldDef, raw: string): Board {
    const card = board.columns[at.column]?.cards[at.index];
    if (!card) return board;
    const text = setField(card.text, def, raw);
    return text === card.text ? board : updateCard(board, at, { text });
}

// The board with `option` added to the select field `key` in its frontmatter; unchanged if it cannot be added.
export function withFieldOption(board: Board, key: string, option: string): Board {
    const head = board.head.join('\n');
    const next = addOption(head, key, option);
    return next === head ? board : { ...board, head: next.split('\n') };
}

// The chips for a card's fields other than due and agent, which have their own badges.
export function cardFields(text: string, schema: FieldDef[]): FieldChip[] {
    return fieldChips(readItem(text, schema), schema, CARD_SCHEMA.map(f => f.key));
}

// Replace the due date part with `date` (YYYY-MM-DD) from the date picker; a time already typed is kept.
export function withDueDate(due: string, date: string): string {
    const trimmed = due.trim();
    return DUE_INPUT.test(trimmed) ? date + trimmed.slice(10) : date;
}

export function splitCard(text: string): CardParts {
    return { title: cardMeta(text).title, tags: cardMeta(text).tags, due: fieldInputText(text, DUE_FIELD), agent: fieldInputText(text, AGENT_FIELD) };
}

// Put the parts back into card text. Fields that are not due or agent are taken over from `old`, so
// editing the title does not lose them.
export function composeCard({ title, tags, due, agent = '' }: CardParts, old = ''): string {
    const tagText = tags.map(t => t.replace(/^#+/, '')).filter(Boolean).map(t => `#${t}`);
    const kept = findSegments(old).filter(s => !CARD_SCHEMA.some(f => f.key === s.key)).map(s => old.slice(s.start, s.end));
    const name = agent.trim().replace(/^@+/, '').toLowerCase();
    const text = [title.trim(), ...tagText, ...kept].filter(Boolean).join(' ');
    return setField(setField(text, DUE_FIELD, due), AGENT_FIELD, AGENT_NAME.test(name) ? name : '');
}

export const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;

// Assign the card to harness `agent` (replaces the old assignment, or removes it if null) without touching the rest of its text.
export function assignCard(text: string, agent: string | null): string {
    return writeField(text, AGENT_FIELD, agent);
}

export type DueStatus = 'overdue' | 'today' | 'soon' | 'later';

const DAY = 24 * 60 * 60 * 1000;

// today: "YYYY-MM-DD". 'soon' = within the next two days.
export function dueStatus(due: string, today: string): DueStatus {
    const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
    return days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 2 ? 'soon' : 'later';
}

// ---------- Dragging ----------

// Insertion position of the dragged card: the number of other cards whose midpoint is above the pointer.
export const dropIndex = (centers: number[], y: number): number => centers.filter(c => c < y).length;
