// Kanban board model tests.

import { addCard, addColumn, cardMeta, countCards, deleteCard, deleteColumn as deleteList, dropIndex, dueStatus, isKanban, moveCard, moveColumn, newBoard, parseBoard, renameColumn, serializeBoard, splitCard, toggleDone, updateCard, withDueDate, type Board } from '../../src/markdown/kanban.js';
import { section, test, eq, ok } from '../framework.js';
import { BOARD } from '../fixtures.js';

export function kanbanModelTests(): void {
    section('Kanban (model)');
    const titles = (b: Board) => b.columns.map(c => c.title);
    const cardsOf = (b: Board, col: number) => b.columns[col].cards.map(c => c.text);

    test('isKanban: only if the frontmatter contains the board marker', () => {
        eq([isKanban(BOARD), isKanban('# Plain\n\ntext'), isKanban('---\ntitle: a\n---\n\ntext'),
            isKanban('text\n\nkanban: true'), isKanban('---\n\ntext\n\n---\nkanban: true')], [true, false, false, false, false]);
    });
    test('isKanban: kanban: true, the old kanban-plugin, and values that are not markers', () => {
        const doc = (line: string) => `---\n${line}\n---\n\n## A`;
        eq(['kanban: true', 'kanban: "true"', 'KANBAN: True', 'kanban-plugin: basic', 'kanban-plugin: board'].map(l => isKanban(doc(l))),
            [true, true, true, true, true], 'recognized markers');
        eq(['kanban: false', 'kanban: no', 'kanban:', 'kanban-plugin:', 'kanbans: true'].map(l => isKanban(doc(l))),
            [false, false, false, false, false], 'not a marker');
        eq(isKanban('---\ntitle: x\nkanban: true\ntag: y\n---'), true, 'a marker among other frontmatter keys');
    });
    test('a board with the old marker (kanban-plugin) is kept as is when written', () => {
        const legacy = BOARD.replace('---\nkanban: true\n---', '---\n\nkanban-plugin: basic\n\n---');
        ok(legacy !== BOARD && legacy.includes('kanban-plugin: basic'), 'test material');
        eq(serializeBoard(parseBoard(legacy)), legacy, 'old frontmatter intact');
        ok(isKanban(legacy), 'still recognized');
    });
    test('parseBoard: lists, cards, notes, intro, outro, and footer', () => {
        const b = parseBoard(BOARD);
        eq(titles(b), ['Plan', 'In Progress', 'Done'], 'lists');
        eq(b.head, ['---', 'kanban: true', '---'], 'head');
        eq(b.columns[0].cards[0], { done: false, text: 'Write report #important [due:: 2026-10-20]', notes: ['note one', '', 'note two'] }, 'card with notes');
        eq(b.columns[1].intro, ['**Active**'], 'intro');
        eq(b.columns[2].cards.map(c => c.done), [true, null], 'done and a plain item');
        eq(b.columns[2].outro, ['***'], 'outro');
        eq(b.footer.length, 5, 'footer kept');
    });
    test('serializeBoard(parseBoard(x)) = x for the standard board', () => eq(serializeBoard(parseBoard(BOARD)), BOARD));
    test('a messy board is tidied up and the result is stable', () => {
        const messy = '---\r\nkanban-plugin: board\r\n---\r\n# Board title\r\n\r\n\r\n##   A  \r\n* [X] one\r\n    note with four spaces\r\n\r\n\r\n- two\r\n## B\r\n';
        const once = serializeBoard(parseBoard(messy));
        eq(serializeBoard(parseBoard(once)), once, 'idempotent');
        const b = parseBoard(messy);
        eq([b.columns[0].title, b.columns[0].cards.map(c => c.done), b.columns[0].cards[0].notes, b.head[b.head.length - 1]],
            ['A', [true, null], ['  note with four spaces'], '# Board title']);
        eq(b.columns[1].cards, [], 'empty list');
    });
    test('a new board can be written and recognized again', () => {
        const text = serializeBoard(newBoard(['X', 'Y']));
        ok(text.startsWith('---\nkanban: true\n---\n\n## X\n'), 'new marker');
        ok(isKanban(text), 'not recognized');
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
