// Inbox model tests.

import { ageOf, captureItem, composeItem, deleteItem, inboxSchema, isInbox, itemFields, itemMeta, itemMissingFields, newInbox, parseInbox, serializeInbox, setItemField, updateItem, withInboxOption } from '../../src/markdown/inbox.js';
import { isKanban } from '../../src/markdown/kanban.js';
import { section, test, eq, ok } from '../framework.js';
import { INBOX } from '../fixtures.js';

export function inboxModelTests(): void {
    section('Inbox (model)');

    test('isInbox: only if the frontmatter contains the inbox marker', () => {
        eq([isInbox(INBOX), isInbox('# Plain\n\n- a'), isInbox('---\ntitle: a\n---\n\n- a'), isInbox('- a\n\ninbox: true'),
            isInbox('---\nINBOX: "True"\n---'), isInbox('---\ninbox: false\n---'), isInbox('---\ninboxes: true\n---')],
            [true, false, false, false, true, false, false]);
        ok(!isKanban(INBOX), 'an inbox is not kanban');
    });
    test('parseInbox: head, items, notes, and outro', () => {
        const inbox = parseInbox(INBOX);
        eq(inbox.head, ['---', 'inbox: true', '---', '', '# Inbox', '', 'A place to capture ideas.'], 'head');
        eq(inbox.items.map(i => i.text), ['SQLite idea #idea [created:: 2026-10-07 14:22]', 'Read HIG article #read #gnome [created:: 2026-10-07 13:32]', 'Item without time']);
        eq(inbox.items[0].notes, ['note one', '', 'note two'], 'item notes');
        eq(inbox.outro, ['Plain closing'], 'outro');
    });
    test('serializeInbox(parseInbox(x)) = x for the standard inbox', () => eq(serializeInbox(parseInbox(INBOX)), INBOX));
    test('list bullets in the frontmatter are not items', () => {
        const text = '---\ninbox: true\ntags:\n- a\n- b\n---\n\n- one\n';
        const inbox = parseInbox(text);
        eq(inbox.items.map(i => i.text), ['one']);
        eq(serializeInbox(inbox), text, 'frontmatter intact');
    });
    test('a new inbox is written and recognized again, without items', () => {
        const text = serializeInbox(newInbox());
        ok(isInbox(text), 'not recognized');
        eq(parseInbox(text).items, []);
        eq(serializeInbox(parseInbox(text)), text, 'stable');
    });
    test('captureItem inserts at the top with a capture time, unless the text already has one', () => {
        let inbox = parseInbox(INBOX);
        inbox = captureItem(inbox, '  New idea #x  ', new Date(2026, 9, 8, 9, 5));
        eq(inbox.items[0].text, 'New idea #x [created:: 2026-10-08 09:05]', 'local time formatted with two digits');
        eq(inbox.items.length, 4);
        eq(captureItem(inbox, 'already [created:: 2026-01-01 10:00]', new Date()).items[0].text, 'already [created:: 2026-01-01 10:00]', 'not overwritten');
        ok(captureItem(inbox, '   ', new Date()) === inbox, 'empty text is ignored');
    });
    test('updateItem and deleteItem do not change the original inbox', () => {
        const a = parseInbox(INBOX);
        const b = updateItem(a, 2, { text: 'Changed' });
        eq([a.items[2].text, b.items[2].text], ['Item without time', 'Changed']);
        const c = deleteItem(a, 0);
        eq([a.items.length, c.items.length, c.items[0].text.startsWith('Read')], [3, 2, true]);
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

    test('inbox fields: the schema, chips without the capture time, missing fields, setting one, and adding an option', () => {
        const inbox = parseInbox('---\ninbox: true\nfields:\n  tipe: select(ide, bacaan)\n  created: text\n  url: link\n---\n\n# Inbox\n\n- Satu #x [created:: 2026-10-07 14:22] [tipe:: ide]\n- Dua\n');
        const schema = inboxSchema(inbox);
        eq(schema.map(f => `${f.key}:${f.type}`), ['created:date', 'tipe:select', 'url:link'], 'created cannot be redeclared');
        eq(itemFields(inbox.items[0].text, schema).map(c => [c.text, c.option]), [['ide', 0]], 'the capture time is shown as its age, not as a chip');
        eq(itemMissingFields(inbox.items[1].text, schema).map(f => f.key), ['tipe', 'url'], 'created is set by capturing');
        const tipe = schema[1];
        eq(setItemField(inbox, 1, tipe, 'BACAAN').items[1].text, 'Dua [tipe:: bacaan]');
        eq(setItemField(inbox, 0, tipe, '').items[0].text, 'Satu #x [created:: 2026-10-07 14:22]');
        ok(setItemField(inbox, 1, tipe, 'urgent') === inbox && setItemField(inbox, 5, tipe, 'ide') === inbox, 'a value that does not fit, or no such note, changes nothing');
        const next = withInboxOption(inbox, 'tipe', 'urgent');
        eq(inboxSchema(next)[1].options, ['ide', 'bacaan', 'urgent']);
        eq(next.items, inbox.items, 'notes untouched');
        ok(withInboxOption(inbox, 'tipe', 'ide') === inbox && withInboxOption(inbox, 'url', 'x') === inbox, 'nothing to add');
    });
}
