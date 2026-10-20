// Kanban board model tests.

import { addCard, addColumn, deleteColumnKeepCards, dropSpot, placeMove, type DropRow, boardSchema, declaredFields, fieldUses, reservedFields, withSchema, cardFields, cardMeta, setCardField, withFieldOption, countCards, deleteCard, deleteColumn as deleteList, dropIndex, dueStatus, moveCard, moveColumn, newBoard, parseBoard, renameColumn, serializeBoard, splitCard, toggleDone, updateCard, withDueDate, type Board } from '../../src/markdown/kanban.js';
import { isBoard } from '../../src/markdown/layout.js';
import { section, test, eq, ok } from '../core/framework.js';
import { BOARD } from '../core/fixtures.js';

export function kanbanModelTests(): void {
    section('Kanban (model)');
    const titles = (b: Board) => b.columns.map(c => c.title);
    const cardsOf = (b: Board, col: number) => b.columns[col].cards.map(c => c.text);

    test('parseBoard: lists, cards, notes, intro, outro, and footer', () => {
        const b = parseBoard(BOARD);
        eq(titles(b), ['Plan', 'In Progress', 'Done'], 'lists');
        eq(b.head, ['---', 'layout: board', '---'], 'head');
        eq(b.columns[0].cards[0], { done: false, text: 'Write report #important [due:: 2026-10-20]', notes: ['note one', '', 'note two'] }, 'card with notes');
        eq(b.columns[1].intro, ['**Active**'], 'intro');
        eq(b.columns[2].cards.map(c => c.done), [true, null], 'done and a plain item');
        eq(b.columns[2].outro, ['***'], 'outro');
        eq(b.footer.length, 5, 'footer kept');
    });
    test('serializeBoard(parseBoard(x)) = x for the standard board', () => eq(serializeBoard(parseBoard(BOARD)), BOARD));
    test('a messy board is tidied up and the result is stable', () => {
        const messy = '---\r\nlayout: board\r\n---\r\n# Board title\r\n\r\n\r\n##   A  \r\n* [X] one\r\n    note with four spaces\r\n\r\n\r\n- two\r\n## B\r\n';
        const once = serializeBoard(parseBoard(messy));
        eq(serializeBoard(parseBoard(once)), once, 'idempotent');
        const b = parseBoard(messy);
        eq([b.columns[0].title, b.columns[0].cards.map(c => c.done), b.columns[0].cards[0].notes, b.head[b.head.length - 1]],
            ['A', [true, null], ['  note with four spaces'], '# Board title']);
        eq(b.columns[1].cards, [], 'empty list');
    });
    test('a new board can be written and recognized again', () => {
        const text = serializeBoard(newBoard(['X', 'Y']));
        ok(text.startsWith('---\nlayout: board\n---\n\n## X\n'), 'new marker');
        ok(isBoard(text), 'not recognized');
        eq(titles(parseBoard(text)), ['X', 'Y']);
    });
    test('addCard / updateCard / toggleDone / deleteCard', () => {
        let b = parseBoard(BOARD);
        b = addCard(b, 1, '  New card  ');
        eq(cardsOf(b, 1), ['Design logo', 'New card'], 'add at the bottom, text trimmed');
        b = addCard(b, 1, 'First', 0);
        eq(cardsOf(b, 1)[0], 'First', 'add at the top');
        eq(addCard(b, 1, '   '), b, 'empty card rejected');
        b = updateCard(b, { column: 1, index: 0 }, { text: 'Changed', notes: ['content'] });
        eq([b.columns[1].cards[0].text, b.columns[1].cards[0].notes], ['Changed', ['content']]);
        b = toggleDone(b, { column: 2, index: 1 });
        eq(b.columns[2].cards[1].done, true, 'a plain item becomes done');
        b = toggleDone(b, { column: 2, index: 1 });
        eq(b.columns[2].cards[1].done, false, 'then not done');
        b = deleteCard(b, { column: 1, index: 0 });
        eq(cardsOf(b, 1), ['Design logo', 'New card']);
    });
    test('moveCard: between lists and within the same list', () => {
        const b = parseBoard(BOARD);
        const across = moveCard(b, { column: 0, index: 0 }, { column: 2, index: 1 });
        eq([cardsOf(across, 0), cardsOf(across, 2)], [['Send invitations'], ['Book venue', 'Write report #important [due:: 2026-10-20]', 'Plain item']], 'between lists');
        eq(across.columns[2].cards[1].notes, ['note one', '', 'note two'], 'notes move along');
        const down = moveCard(b, { column: 0, index: 0 }, { column: 0, index: 1 });
        eq(cardsOf(down, 0), ['Send invitations', 'Write report #important [due:: 2026-10-20]'], 'downward: index = final position');
        eq(cardsOf(moveCard(down, { column: 0, index: 1 }, { column: 0, index: 0 }), 0), cardsOf(b, 0), 'back up');
        eq(moveCard(b, { column: 0, index: 9 }, { column: 1, index: 0 }), b, 'a card that does not exist');
        eq(cardsOf(moveCard(b, { column: 0, index: 0 }, { column: 1, index: 99 }), 1).length, 2, 'index clamped');
        eq(countCards(across), countCards(b), 'card count unchanged');
    });
    test('list operations: add, rename, move, delete', () => {
        let b = parseBoard(BOARD);
        b = addColumn(b, 'Idea', 0);
        eq(titles(b), ['Idea', 'Plan', 'In Progress', 'Done']);
        b = renameColumn(b, 0, '  New Idea ');
        b = moveColumn(b, 0, 3);
        eq(titles(b), ['Plan', 'In Progress', 'Done', 'New Idea'], 'move to the end');
        eq(renameColumn(b, 0, '  '), b, 'empty name rejected');
        b = deleteList(b, 1);
        eq(titles(b), ['Plan', 'Done', 'New Idea']);
        eq(b.footer, parseBoard(BOARD).footer, 'footer unchanged');
    });
    test('cardMeta: #tag and [due:: date] are separated from the title', () => {
        eq(cardMeta('Write report #important #work/big [due:: 2026-10-20]'), { title: 'Write report', tags: ['important', 'work/big'], due: '2026-10-20', agent: null });
        eq(cardMeta('No meta'), { title: 'No meta', tags: [], due: null, agent: null });
        eq(cardMeta('http://x.y/#section').tags, [], 'a # inside a URL is not a tag');
        eq(cardMeta('#only').title, '#only', 'text that is only a tag is still shown');
    });
    test('splitCard keeps a due text that is not a date, so editing a card does not lose it', () => {
        eq(splitCard('Send [due:: besok]').due, 'besok');
        eq(cardMeta('Send [due:: besok]').due, null, 'it is not a due date');
    });
    test('boardSchema: the built-in fields plus the frontmatter fields; cardFields leaves due and agent to their badges', () => {
        const board = parseBoard('---\nlayout: board\nfields:\n  prioritas: select(tinggi, rendah)\n  due: text\n---\n\n## Plan\n\n- [ ] A [prioritas:: tinggi] [due:: 2026-10-20] [agent:: pi] [x:: 1]\n');
        const schema = boardSchema(board);
        eq(schema.map(f => `${f.key}:${f.type}`), ['due:date', 'agent:agent', 'prioritas:select'], 'a built-in key cannot be redeclared');
        eq(cardFields(board.columns[0].cards[0].text, schema).map(c => c.text), ['tinggi', 'x: 1']);
        eq(boardSchema(newBoard()).length, 2, 'a board without a fields block');
    });
    test('setCardField sets, replaces, and clears one field; a value that does not fit changes nothing', () => {
        const board = parseBoard('---\nlayout: board\nfields:\n  prioritas: select(tinggi, rendah)\n---\n\n## Plan\n\n- [ ] A #x [prioritas:: rendah] [owner:: Eka]\n');
        const prio = boardSchema(board).find(f => f.key === 'prioritas')!;
        const text = (b: Board) => b.columns[0].cards[0].text;
        eq(text(setCardField(board, { column: 0, index: 0 }, prio, 'TINGGI')), 'A #x [prioritas:: tinggi] [owner:: Eka]');
        eq(text(setCardField(board, { column: 0, index: 0 }, prio, '')), 'A #x [owner:: Eka]');
        ok(setCardField(board, { column: 0, index: 0 }, prio, 'urgent') === board, 'an option that is not listed is rejected');
        ok(setCardField(board, { column: 3, index: 0 }, prio, 'tinggi') === board, 'no such card');
    });
    test('withFieldOption adds an option to the frontmatter line only', () => {
        const board = parseBoard('---\nlayout: board\nfields:\n  prioritas: select(tinggi, rendah)\n  due2: date\n---\n\n# Sprint\n\n## Plan\n\n- [ ] A\n');
        const next = withFieldOption(board, 'prioritas', 'urgent');
        eq(next.head.length, board.head.length, 'same lines');
        eq(boardSchema(next).find(f => f.key === 'prioritas')?.options, ['tinggi', 'rendah', 'urgent']);
        eq(next.columns, board.columns, 'cards untouched');
        ok(withFieldOption(board, 'prioritas', 'tinggi') === board && withFieldOption(board, 'due2', 'x') === board && withFieldOption(board, 'nope', 'x') === board, 'nothing to add');
    });
    test('addCard with a time gives the card the defaults the board declares; without one it adds nothing', () => {
        const board = parseBoard('---\nlayout: board\nfields:\n  prioritas: select(tinggi, rendah) = rendah\n  dibuat: date = today\n---\n\n## Plan\n');
        const now = new Date(2026, 9, 8, 9, 5);
        eq(addCard(board, 0, 'A [prioritas:: tinggi]', Infinity, now).columns[0].cards[0].text, 'A [prioritas:: tinggi] [dibuat:: 2026-10-08]');
        eq(addCard(board, 0, 'B').columns[0].cards[0].text, 'B');
    });
    test('declaredFields, reservedFields, withSchema, and fieldUses on a board and on a list', () => {
        const board = parseBoard('---\nlayout: board\nfields:\n  prio: select(a, b)\n---\n\n## Plan\n\n- [ ] X [prio:: a]\n- [ ] Y [prio:: b]\n\n## Done\n\n- [x] Z [prio:: a]\n');
        eq(declaredFields(board).map(f => f.key), ['prio'], 'without the built-in ones');
        eq([reservedFields(board), reservedFields(parseBoard('---\nlayout: list\n---\n'))], [['due', 'agent'], []]);
        eq([fieldUses(board, 'prio'), fieldUses(board, 'prio', 'a'), fieldUses(board, 'prio', 'c')], [3, 2, 0], 'counted over every group');
        const next = withSchema(board, [...declaredFields(board), { key: 'n', type: 'number', multiple: false, options: [] }]);
        eq(declaredFields(next).map(f => f.key), ['prio', 'n']);
        eq(next.columns, board.columns, 'cards untouched');
        ok(withSchema(board, declaredFields(board)) === board, 'no difference, no new board');
    });
    test('deleteColumnKeepCards: the notes go to the group above; the first group only loses its heading', () => {
        const doc = parseBoard('---\nlayout: list\n---\n\n- loose\n\n## Now\n\n- one\n\n## Later\n\n- two\n- three\n');
        const shape = (b: Board) => b.columns.map(c => [c.title, c.cards.map(i => i.text)]);
        eq(shape(deleteColumnKeepCards(doc, 2)), [['', ['loose']], ['Now', ['one', 'two', 'three']]], 'to the end of the group above');
        eq(shape(deleteColumnKeepCards(doc, 1)), [['', ['loose', 'one']], ['Later', ['two', 'three']]], 'into the unnamed group above');
        const first = parseBoard('---\nlayout: list\n---\n\n## Now\n\n- one\n\n## Later\n\n- two\n');
        eq(shape(deleteColumnKeepCards(first, 0)), [['', ['one']], ['Later', ['two']]], 'the first titled group becomes the unnamed one');
        ok(deleteColumnKeepCards(doc, 0) === doc && deleteColumnKeepCards(doc, 7) === doc, 'the unnamed group, or no such group: unchanged');
        eq(doc.columns[2].cards.length, 2, 'the original is not changed');
    });
    test('dropSpot: halves of a note, halves of a section title, the gaps, and below the last row', () => {
        // unnamed group: a, b | section 1: (title) c | section 2: (title, empty)
        const rows: DropRow[] = [
            { top: 0, bottom: 40, note: { column: 0, index: 0 }, section: -1 }, { top: 48, bottom: 88, note: { column: 0, index: 1 }, section: -1 },
            { top: 96, bottom: 120, note: null, section: 1 }, { top: 128, bottom: 168, note: { column: 1, index: 0 }, section: -1 },
            { top: 176, bottom: 200, note: null, section: 2 },
        ];
        const at = (y: number) => { const s = dropSpot(rows, y)!; return [s.point.column, s.point.index, s.row, s.side]; };
        eq(at(5), [0, 0, 0, 'above'], 'top half of a note: before it');
        eq(at(35), [0, 1, 0, 'below'], 'bottom half: after it');
        eq(at(44), [0, 1, 1, 'above'], 'in the gap: before the next note');
        eq(at(100), [0, 2, 1, 'below'], 'top half of a section title: the end of the group above');
        eq(at(115), [1, 0, 2, 'below'], 'bottom half: the top of that section');
        eq(at(190), [2, 0, 4, 'below'], 'bottom half of the title of an empty section');
        eq(at(180), [1, 1, 3, 'below'], 'top half of a title: after the last note above it');
        eq(at(500), [2, 0, 4, 'below'], 'below everything: after the last row');
        eq(at(-20), [0, 0, 0, 'above'], 'above everything: before the first row');
        eq(dropSpot([], 5), null, 'no rows');
        eq(dropSpot([{ top: 0, bottom: 30, note: null, section: 0 }], 3)?.side, 'above', 'the first row is a title: the top of it');
    });
    test('placeMove: within a group the final position counts, across groups the note goes in front of the point, and no change is no board', () => {
        const doc = parseBoard('---\nlayout: list\n---\n\n- a\n- b\n- c\n\n## Later\n\n- d\n- e\n');
        const shape = (b: Board) => b.columns.map(c => c.cards.map(i => i.text).join(''));
        eq(shape(placeMove(doc, { column: 0, index: 0 }, { column: 0, index: 3 })), ['bca', 'de'], 'after c: to the end');
        eq(shape(placeMove(doc, { column: 0, index: 2 }, { column: 0, index: 0 })), ['cab', 'de'], 'before a');
        eq(shape(placeMove(doc, { column: 0, index: 1 }, { column: 1, index: 1 })), ['ac', 'dbe'], 'into another group, between d and e');
        eq(shape(placeMove(doc, { column: 1, index: 0 }, { column: 0, index: 0 })), ['dabc', 'e'], 'to the top of the first group');
        ok(placeMove(doc, { column: 0, index: 1 }, { column: 0, index: 1 }) === doc && placeMove(doc, { column: 0, index: 1 }, { column: 0, index: 2 }) === doc, 'before or after itself: nothing');
    });
    test('dueStatus and dropIndex', () => {
        eq(['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-09'].map(d => dueStatus(d, '2026-10-03')), ['overdue', 'today', 'soon', 'later']);
        eq([dropIndex([10, 50, 90], 0), dropIndex([10, 50, 90], 60), dropIndex([10, 50, 90], 200), dropIndex([], 5)], [0, 2, 3, 0]);
    });
    test('withDueDate replaces the due date and keeps the time', () => {
        eq(withDueDate('', '2026-10-20'), '2026-10-20');
        eq(withDueDate('2026-10-01', '2026-10-20'), '2026-10-20');
        eq(withDueDate(' 2026-10-01 09:30 ', '2026-10-20'), '2026-10-20 09:30', 'time kept');
        eq(withDueDate('tomorrow', '2026-10-20'), '2026-10-20', 'invalid text replaced');
    });
}
