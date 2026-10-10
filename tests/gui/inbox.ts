// Tes GUI: Inbox.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { parseBoard } from '../../src/markdown/kanban.js';
import { findDialog } from '../../src/ui/dialogs.js';
import { isList } from '../../src/markdown/layout.js';
import { descendants, whenDialogReady, widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import { BOARD, INBOX } from '../fixtures.js';
import type { GuiContext } from './context.js';

export function inboxTests(c: GuiContext): void {
    const { w, pump, text } = c;

    section('Inbox (view)');
    const file =  GLib.build_filenamev([tmp, 'inbox.md']);
    const settle = () => { for (let i = 0; i < 25; i++) { pump(); GLib.usleep(8000); } };
    const open = (content = INBOX) => { GLib.file_set_contents(file,  content); w.load(file); settle(); };
    const labels = () => descendants(w.inbox.widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label());
    const rows = () => descendants(w.inbox.widget).filter((x): x is Gtk.ListBoxRow => x instanceof Gtk.ListBoxRow);
    const removeButton = (row: number) => descendants(rows()[row]).find((x): x is Gtk.Button => x instanceof Gtk.Button)!;
    const entry = () => descendants(w.inbox.widget).find(x => x.get_name() === 'inbox-entry') as Gtk.Entry;
    // A fixed time so the age labels do not depend on the clock of the test.
    w.inbox.now = () => new Date(2026, 9, 7, 14, 32);

    test('an inbox document opens as an inbox, not as a board or text', () => {
        open();
        ok(w.inboxMode && !w.boardMode, 'the inbox is not shown');
        eq(rows().length, 3, 'number of rows');
        ok(labels().includes('Inbox') && labels().includes('A place to capture ideas.'), `title: ${labels().join('|')}`);
        ok(w.statusBar.right.label.includes('3 notes'), `status: ${w.statusBar.right.label}`);
        eq(text(), INBOX, 'the document text did not change because it was opened');
        GLib.file_set_contents(file,  BOARD);
        w.load(file); settle();
        ok(w.boardMode && !w.inboxMode, 'the kanban board was disturbed');
        GLib.file_set_contents(file,  '# Plain\n\n- a');
        w.load(file); settle();
        ok(!w.boardMode && !w.inboxMode, 'a plain document was shown as an inbox');
    });
    test('rows show the title without tags, the age, and the tags', () => {
        open();
        const all = labels();
        ok(all.includes('10 minutes ago · has notes'), `age: ${all.join('|')}`);
        ok(all.includes('1 hour ago'), 'jam');
        ok(all.includes('#idea') && all.includes('#read'), 'tag');
        ok(!all.some(l => l.includes('created::')), 'the capture time is not shown raw');
    });
    test('quick capture inserts the item at the top and writes the document text', () => {
        open();
        entry().set_text('Interesting link #read');
        entry().emit('activate');
        settle();
        eq(rows().length, 4, 'rows');
        const items = parseBoard(text()).columns.flatMap(c => c.cards);
        ok(/^Interesting link #read \[created:: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]$/.test(items[0].text), items[0].text);
        eq(entry().text, '', 'the entry was cleared');
        ok(w.statusBar.right.label.includes('4 notes'), 'the status was updated');
        entry().set_text('   ');
        entry().emit('activate');
        settle();
        eq(rows().length, 4, 'empty text was rejected');
        eq(entry().text, '', 'whitespace only was cleared');
    });
    test('the delete button removes the item; undo restores it', () => {
        open();
        removeButton(1).emit('clicked');
        settle();
        eq(rows().length, 2, 'rows after deleting');
        ok(!text().includes('Read HIG article'), 'the item is still in the text');
        c.action('undo');
        settle();
        eq(rows().length, 3, 'rows after undo');
        eq(text(), INBOX, 'the text is back');
    });
    test('a new note and editing through the dialog; the capture time is kept', () => {
        open();
        const calls: string[] = [];
        w.inbox.dialogs = { editNote: (_p, item, title) => { calls.push(title ?? 'edit'); return { text: item.text ? `${item.text} #new` : 'From dialog #d', notes: ['content'] }; } };
        w.inbox.showAddNote();
        settle();
        eq(calls, ['New Note']);
        const items = parseBoard(text()).columns.flatMap(c => c.cards);
        ok(items[0].text.startsWith('From dialog #d [created:: '), items[0].text);
        eq(items[0].notes, ['content']);
        rows()[1].emit('activate');
        settle();
        eq(calls[1], 'edit');
        eq(parseBoard(text()).columns.flatMap(c => c.cards)[1].text, 'SQLite idea #idea [created:: 2026-10-07 14:22] #new');
        w.inbox.dialogs = { editNote: () => null };
        const before = text();
        w.inbox.editItem({ column: 0, index: 0 });
        settle();
        eq(text(), before, 'cancelling changes nothing');
    });
    test('the text view and back to the inbox; New Inbox creates an inbox document', () => {
        open();
        w.toggleBoardView(false);
        ok(!w.inboxMode, 'still an inbox');
        w.toggleBoardView(true);
        ok(w.inboxMode, 'did not return to the inbox');
        w.newInboxDocument();
        settle();
        ok(w.inboxMode && isList(text()), 'the new document is not an inbox');
        eq(rows().length, 0, 'the new inbox is empty');
        ok(descendants(w.inbox.widget).some(x => x instanceof Gtk.Label && x.get_label() === 'The inbox is empty'), 'the empty state is not shown');
        while (w.editor !== c.ed) ok(w.closeTab(), 'closeTab() failed');
    });
    test('screenshot of the inbox', () => {
        // --shot-inbox=<prefix>: save <prefix>-light.png and <prefix>-dark.png.
        const shot = optVal('shot-inbox');
        if (!shot) return;
        open(INBOX.replace('A place to capture ideas.', 'A place to capture ideas, notes, and things to process later.'));
        w.win.set_focus(null);
        for (const dark of [false, true]) {
            w.setOption('dark', dark);
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(15000); }
            widgetPixbuf(w.win)?.savev(`${shot}-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
        }
        w.setOption('dark', false);
    });

    // Fields declared in the frontmatter: chips, a popover on a chip, and the + button for a field with no value.
    const FIELD_INBOX = '---\nlayout: list\nfields:\n  tipe: select(ide, bacaan)\n  progres: progress\n---\n\n# Inbox\n\n- Satu [tipe:: ide] [created:: 2026-10-07 14:22]\n- Dua [tipe:: urgent]\n- Tiga [tipe:: bacaan] [progres:: 1/2]\n';
    const popButtons = (popover: Gtk.Popover) => descendants(popover).filter((x): x is Gtk.Button => x instanceof Gtk.Button);
    const popButton = (popover: Gtk.Popover, label: string) => popButtons(popover).find(b => b.label === label) ?? (() => { throw new Error(`no button "${label}"`); })();
    const chips = (row: number) => descendants(rows()[row]).filter((x): x is Gtk.Label => x instanceof Gtk.Label && x.has_css_class('inbox-field'));

    test('declared fields are shown as chips; a value that does not fit is marked and its text is unchanged', () => {
        open(FIELD_INBOX);
        eq(chips(0).map(l => l.label), ['ide']);
        ok(chips(0)[0].has_css_class('inbox-field-0'), 'a select option takes the color of its position');
        eq(chips(1).map(l => [l.label, l.has_css_class('inbox-field-invalid')]), [['tipe: urgent', true]]);
        eq(w.inbox.getBoard().columns[0].cards[1].text, 'Dua [tipe:: urgent]');
        eq(text(), FIELD_INBOX, 'opening the inbox did not change the text');
    });

    test('a chip popover changes the value; a new option is added only after confirmation, and is one undo step', () => {
        open(FIELD_INBOX);
        let pop = w.inbox.editField({ column: 0, index: 0 }, 'tipe')!;
        settle();
        eq(popButtons(pop).filter(b => b.get_visible()).map(b => b.label), ['✓ ide', 'bacaan', 'Clear']);
        popButton(pop, 'bacaan').emit('clicked'); settle();
        eq(w.inbox.getBoard().columns[0].cards[0].text, 'Satu [tipe:: bacaan] [created:: 2026-10-07 14:22]');
        open(FIELD_INBOX);
        pop = w.inbox.editField({ column: 0, index: 1 }, 'tipe')!; settle();
        const entry = descendants(pop).find((x): x is Gtk.Entry => x instanceof Gtk.Entry)!;
        entry.set_text('video'); settle();
        eq(text(), FIELD_INBOX, 'nothing is written before the confirmation');
        popButtons(pop).find(b => b.get_visible() && b.label === 'Add “video” to the list')!.emit('clicked'); settle();
        ok(text().includes('tipe: select(ide, bacaan, video)') && text().includes('Dua [tipe:: video]'), text());
        c.action('undo'); settle();
        eq(text(), FIELD_INBOX, 'one undo reverts the option and the value');
        eq(w.inbox.editField({ column: 0, index: 0 }, 'nope'), null, 'a key that is not declared has no popover');
    });

    test('the + button offers the fields a note has no value for; the capture time is not one of them', () => {
        open(FIELD_INBOX);
        const add = (row: number) => descendants(rows()[row]).find((x): x is Gtk.Button => x instanceof Gtk.Button && x.has_css_class('inbox-add-field'));
        ok(add(0) && add(1), 'notes with a field to fill have the button');
        ok(!add(2), 'a note with every field filled has none');
        eq(w.inbox.addFieldMenu({ column: 0, index: 2 }), null);
        const menu = w.inbox.addFieldMenu({ column: 0, index: 0 })!; settle();
        eq(popButtons(menu).filter(b => b.get_visible()).map(b => b.label), ['progres']);
        popButton(menu, 'progres').emit('clicked'); settle(); settle();
        const pop = descendants(w.inbox.widget).find((x): x is Gtk.Popover => x instanceof Gtk.Popover && x.get_mapped());
        ok(pop, 'the popover of the chosen field opened');
        const entry = descendants(pop).find((x): x is Gtk.Entry => x instanceof Gtk.Entry)!;
        entry.set_text('nope'); entry.emit('activate'); settle();
        ok(entry.has_css_class('error'), 'a value that does not fit is refused');
        entry.set_text('2/4'); entry.emit('activate'); settle();
        eq(w.inbox.getBoard().columns[0].cards[0].text, 'Satu [tipe:: ide] [created:: 2026-10-07 14:22] [progres:: 2/4]');
        open();
    });

    test('a list with headings shows them as sections; the same file with layout: board shows them as columns, without a conversion', () => {
        const TEXT = '---\nlayout: list\n---\n\n# Reading\n\n- loose\n\n## Now\n\n- one\n- two\n\n## Later\n\n- three\n';
        open(TEXT);
        ok(w.inboxMode, 'shown as a list');
        const sections = descendants(w.inbox.widget).filter((x): x is Gtk.ListBoxRow => x instanceof Gtk.ListBoxRow && x.has_css_class('inbox-section'));
        eq(sections.length, 2, 'a section title for each heading');
        eq(labels().filter(l => ['Now', 'Later'].includes(l)), ['Now', 'Later']);
        eq(rows().length, 6, 'two section titles and four notes');
        open(TEXT.replace('layout: list', 'layout: board'));
        ok(w.boardMode && !w.inboxMode, 'shown as a board');
        eq(w.board.getBoard().columns.map(c => [c.title, c.cards.length]), [['', 1], ['Now', 2], ['Later', 1]], 'the notes before the first heading are the first column');
        eq(text(), TEXT.replace('layout: list', 'layout: board'), 'the text was not rewritten by being opened');
        open();
    });

    test('add: bottom puts a quick capture and a note from the dialog at the end; add-to: names the group', () => {
        const base = (extra: string) => `---\nlayout: list\n${extra}fields:\n  created: date = now\n---\n\n- old\n\n## Now\n\n- one\n`;
        const texts = () => parseBoard(text()).columns.map(c => c.cards.map(i => i.text.replace(/ \[created:: [^\]]+\]/, '')));
        open(base('add: bottom\n'));
        w.inbox.capture('typed'); settle();
        eq(texts(), [['old'], ['one', 'typed']], 'the end of the last group');
        open(base('add-to: Now\n'));
        w.inbox.capture('typed'); settle();
        eq(texts(), [['old'], ['typed', 'one']], 'the top of the named group');
        ok(text().includes('[created:: '), 'the capture time is still added');
        open();
    });

    test('Fields… on a list: a name a board keeps for itself is free here, and the new field is used by the notes at once', () => {
        open(FIELD_INBOX);
        whenDialogReady(() => findDialog('Fields'), dialog => {
            (descendants(dialog).find(x => x instanceof Gtk.Button && (x as Gtk.Button).label === '+ Add field') as Gtk.Button).emit('clicked'); pump();
            (descendants(dialog).find(x => x instanceof Gtk.Entry && (x as Gtk.Entry).placeholder_text === 'Field name') as Gtk.Entry).set_text('due');
            (descendants(dialog).find(x => x instanceof Gtk.DropDown) as Gtk.DropDown).selected = 3; pump();   // Date
            (descendants(dialog).find(x => x instanceof Gtk.Button && (x as Gtk.Button).label === 'Save') as Gtk.Button).emit('clicked');
        });
        w.editFields();
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { pump(); GLib.usleep(20000); }
        settle();
        ok(text().includes('  progres: progress\n  due: date\n'), text());
        ok(w.inbox.schema().some(f => f.key === 'due'), 'the list reads the new field');
        c.action('undo'); settle();
        eq(text(), FIELD_INBOX, 'one undo');
        open();
    });

    test('a list chip takes the color chosen for its option', () => {
        open('---\nlayout: list\nfields:\n  tipe: select(ide, bacaan:purple)\n---\n\n- Satu [tipe:: bacaan]\n- Dua [tipe:: ide]\n');
        ok(chips(0)[0].has_css_class('opt-purple'), 'the chosen color');
        ok(chips(1)[0].has_css_class('inbox-field-0') && !chips(1)[0].has_css_class('opt-purple'), 'no color: the color of its position');
        open();
    });
}
