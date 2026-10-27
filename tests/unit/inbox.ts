// List model tests: the notes of a `layout: list` document, on the same model as a board.

import { addTarget, ageOf, captureItem, composeItem, itemFields, itemMeta, newList } from '../../src/markdown/inbox';
import { addColumn, boardSchema, deleteCard, moveColumn, parseBoard, serializeBoard, setCardField, updateCard, withFieldOption } from '../../src/markdown/kanban';
import { isList } from '../../src/markdown/layout';
import { section, test, eq, ok } from '../core/framework';
import { BOARD, INBOX } from '../core/fixtures';

export function inboxModelTests(): void {
    section('List (model)');
    const items = (text: string) => parseBoard(text).columns.flatMap(c => c.cards);

    test('parseBoard on a flat list: one unnamed group with the head, notes, and outro', () => {
        const list = parseBoard(INBOX);
        eq(list.head, ['---', 'layout: list', 'fields:', '  created: date = now', '---', '', '# Inbox', '', 'A place to capture ideas.'], 'head');
        eq(list.columns.map(c => c.title), [''], 'one group without a name');
        eq(list.columns[0].cards.map(i => i.text), ['SQLite idea #idea [created:: 2026-10-07 14:22]', 'Read HIG article #read #gnome [created:: 2026-10-07 13:32]', 'Item without time']);
        eq(list.columns[0].cards[0].notes, ['note one', '', 'note two'], 'item notes');
        eq(list.columns[0].outro, ['Plain closing'], 'outro');
    });
    test('serializeBoard(parseBoard(x)) = x for the standard list', () => eq(serializeBoard(parseBoard(INBOX)), INBOX));
    test('list bullets in the frontmatter are not items', () => {
        const text = '---\nlayout: list\ntags:\n- a\n- b\n---\n\n- one\n';
        eq(items(text).map(i => i.text), ['one']);
        eq(serializeBoard(parseBoard(text)), text, 'frontmatter intact');
    });
    test('a new list is written and recognized again, without items', () => {
        const text = serializeBoard(newList());
        ok(isList(text), 'not recognized');
        eq(parseBoard(text).columns, []);
        eq(serializeBoard(parseBoard(text)), text, 'stable');
    });

    test('a list with headings: the notes before the first heading are an unnamed group, each heading is a group', () => {
        const text = '---\nlayout: list\n---\n\n# Reading\n\n- loose\n\n## Now\n\n- one\n- two\n\n## Later\n\n- three\n';
        const doc = parseBoard(text);
        eq(doc.columns.map(c => [c.title, c.cards.map(i => i.text)]), [['', ['loose']], ['Now', ['one', 'two']], ['Later', ['three']]]);
        eq(serializeBoard(doc), text, 'stable');
    });
    test('the same text is a board and a list: switching the layout line changes nothing else', () => {
        const asList = BOARD.replace('layout: board', 'layout: list');
        const [a, b] = [parseBoard(asList), parseBoard(BOARD)];
        eq([a.columns, a.footer, a.head.filter(l => !l.startsWith('layout:'))], [b.columns, b.footer, b.head.filter(l => !l.startsWith('layout:'))], 'the model does not depend on the layout');
        const flat = INBOX.replace('layout: list', 'layout: board');
        eq(parseBoard(flat).columns[0].cards.length, 3, 'a flat file shown as a board has its notes in the first column');
        eq(serializeBoard(parseBoard(flat)), flat, 'and is written back as it was');
    });
    test('the unnamed group stays first: nothing is added or moved before it, and it cannot be moved', () => {
        const doc = parseBoard('---\nlayout: list\n---\n\n- loose\n\n## Now\n\n- one\n');
        eq(addColumn(doc, 'New', 0).columns.map(c => c.title), ['', 'New', 'Now'], 'a new group goes after it');
        eq(moveColumn(doc, 1, 0).columns.map(c => c.title), ['', 'Now'], 'a group cannot go before it');
        ok(moveColumn(doc, 0, 1) === doc, 'it cannot be moved');
    });

    test('captureItem inserts at the top of the first group with a capture time, unless the text already has one', () => {
        let list = parseBoard(INBOX);
        list = captureItem(list, '  New idea #x  ', new Date(2026, 9, 8, 9, 5));
        eq(list.columns[0].cards[0].text, 'New idea #x [created:: 2026-10-08 09:05]', 'local time formatted with two digits');
        eq(list.columns[0].cards.length, 4);
        eq(captureItem(list, 'already [created:: 2026-01-01 10:00]', new Date()).columns[0].cards[0].text, 'already [created:: 2026-01-01 10:00]', 'not overwritten');
        ok(captureItem(list, '   ', new Date()) === list, 'empty text is ignored');
    });
    test('captureItem on an empty list makes the unnamed group; with headings it goes into the first group', () => {
        const empty = captureItem(newList(), 'First', new Date(2026, 9, 8, 9, 5));
        eq(empty.columns.map(c => [c.title, c.cards.map(i => i.text)]), [['', ['First [created:: 2026-10-08 09:05]']]]);
        eq(isList(serializeBoard(empty)) && serializeBoard(empty).endsWith('- First [created:: 2026-10-08 09:05]\n'), true, 'written without a heading');
        const withHeadings = parseBoard('---\nlayout: list\n---\n\n## Now\n\n- one\n\n## Later\n');
        eq(captureItem(withHeadings, 'Top', new Date()).columns[0].cards.map(i => i.text), ['Top', 'one']);
    });
    test('add: says where a new note goes: top (default) or bottom, and add-to: names the group', () => {
        const head = (extra: string) => `---\nlayout: list\n${extra}---\n\n- loose\n\n## Now\n\n- one\n\n## Later\n\n- two\n`;
        const at = (text: string) => parseBoard(text).columns.map(c => c.cards.map(i => i.text));
        const add = (extra: string) => at(serializeBoard(captureItem(parseBoard(head(extra)), 'NEW', new Date())));
        eq(add(''), [['NEW', 'loose'], ['one'], ['two']], 'no option: the top of the first group');
        eq(add('add: top\n'), [['NEW', 'loose'], ['one'], ['two']]);
        eq(add('add: bottom\n'), [['loose'], ['one'], ['two', 'NEW']], 'bottom: the end of the last group');
        eq(add('add-to: Now\n'), [['loose'], ['NEW', 'one'], ['two']], 'a named group, at its top');
        eq(add('add: bottom\nadd-to: now\n'), [['loose'], ['one', 'NEW'], ['two']], 'a named group, at its end, any case');
        eq(add('add-to: Missing\nadd: bottom\n'), [['loose'], ['one'], ['two', 'NEW']], 'an unknown group falls back to the position');
        eq([addTarget(parseBoard(head('add: BOTTOM\n'))).position, addTarget(parseBoard(head('add: sideways\n'))).position], ['bottom', 'top'], 'case is ignored, anything else is top');
    });
    test('updateCard and deleteCard do not change the original list', () => {
        const a = parseBoard(INBOX);
        const b = updateCard(a, { column: 0, index: 2 }, { text: 'Changed' });
        eq([a.columns[0].cards[2].text, b.columns[0].cards[2].text], ['Item without time', 'Changed']);
        const c = deleteCard(a, { column: 0, index: 0 });
        eq([a.columns[0].cards.length, c.columns[0].cards.length, c.columns[0].cards[0].text.startsWith('Read')], [3, 2, true]);
    });
    test('itemMeta: title, tags, and capture time', () => {
        const m = itemMeta('Read HIG article #read #gnome [created:: 2026-10-07 13:32]');
        eq([m.title, m.tags], ['Read HIG article', ['read', 'gnome']]);
        eq(m.captured?.getTime(), new Date(2026, 9, 7, 13, 32).getTime(), 'time');
        eq(itemMeta('Date only [created:: 2026-10-07]').captured?.getTime(), new Date(2026, 9, 7, 0, 0).getTime(), 'without a time of day');
        eq(itemMeta('Without time').captured, null);
    });
    test('composeItem keeps the old capture time', () => {
        eq(composeItem(' Title ', ['#a', 'b', ''], 'old [created:: 2026-10-07 13:32]'), 'Title #a #b [created:: 2026-10-07 13:32]');
        eq(composeItem('Title', []), 'Title');
    });
    test('ageOf: minutes, hours, days, then a date', () => {
        const now = new Date(2026, 9, 7, 15, 0);
        const ago = (min: number) => ageOf(new Date(now.getTime() - min * 60000), now);
        eq([ago(0), ago(10), ago(60), ago(150), ago(60 * 24 * 3), ago(60 * 24 * 8)],
            [{ unit: 'now', n: 0 }, { unit: 'minutes', n: 10 }, { unit: 'hours', n: 1 }, { unit: 'hours', n: 2 }, { unit: 'days', n: 3 }, { unit: 'date', n: 0 }]);
    });

    test('captureItem gives a new item the default of every field it does not set; without defaults it adds nothing', () => {
        const withDefaults = parseBoard('---\nlayout: list\nfields:\n  created: date = now\n  status: select(antre, dibaca) = antre\n---\n\n- old\n');
        const first = (b: ReturnType<typeof parseBoard>) => b.columns[0].cards[0].text;
        eq(first(captureItem(withDefaults, 'New #x', new Date(2026, 9, 8, 9, 5))), 'New #x [created:: 2026-10-08 09:05] [status:: antre]');
        eq(first(captureItem(withDefaults, 'Set [status:: dibaca]', new Date(2026, 9, 8, 9, 5))), 'Set [status:: dibaca] [created:: 2026-10-08 09:05]', 'a field the text sets is left alone');
        eq(first(captureItem(parseBoard('---\nlayout: list\n---\n\n- old\n'), 'Plain', new Date())), 'Plain', 'no declared default, no stamp');
        eq(parseBoard(serializeBoard(newList())).head.slice(0, 6), ['---', 'layout: list', 'add: top', 'fields:', '  created: date = now', '---'], 'New Inbox declares where notes go and the capture time');
    });
    test('list fields: chips without the capture time, missing fields, setting one, and adding an option', () => {
        const list = parseBoard('---\nlayout: list\nfields:\n  tipe: select(ide, bacaan)\n  created: text\n  url: link\n---\n\n# Inbox\n\n- Satu #x [created:: 2026-10-07 14:22] [tipe:: ide]\n- Dua\n');
        const schema = boardSchema(list);
        eq(schema.map(f => `${f.key}:${f.type}`), ['tipe:select', 'created:text', 'url:link'], 'a list has only the fields it declares');
        eq(boardSchema(parseBoard(list.head.join('\n').replace('layout: list', 'layout: board'))).map(f => f.key).slice(0, 2), ['due', 'agent'], 'a board has the built-in ones too');
        const cards = list.columns[0].cards;
        eq(itemFields(cards[0].text, schema).map(c => [c.text, c.option]), [['ide', 0]], 'the capture time is shown as its age, not as a chip');
        const tipe = schema.find(f => f.key === 'tipe')!;
        eq(setCardField(list, { column: 0, index: 1 }, tipe, 'BACAAN').columns[0].cards[1].text, 'Dua [tipe:: bacaan]');
        eq(setCardField(list, { column: 0, index: 0 }, tipe, '').columns[0].cards[0].text, 'Satu #x [created:: 2026-10-07 14:22]');
        ok(setCardField(list, { column: 0, index: 1 }, tipe, 'urgent') === list && setCardField(list, { column: 3, index: 0 }, tipe, 'ide') === list, 'a value that does not fit, or no such note, changes nothing');
        const next = withFieldOption(list, 'tipe', 'urgent');
        eq(boardSchema(next).find(f => f.key === 'tipe')?.options, ['ide', 'bacaan', 'urgent']);
        eq(next.columns, list.columns, 'notes untouched');
    });
}
