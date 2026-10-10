// Tes GUI: Inbox.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { parseInbox, isInbox } from '../../src/markdown/inbox.js';
import { descendants, widgetPixbuf } from '../widgets.js';
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
        const items = parseInbox(text()).items;
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
        const items = parseInbox(text()).items;
        ok(items[0].text.startsWith('From dialog #d [created:: '), items[0].text);
        eq(items[0].notes, ['content']);
        rows()[1].emit('activate');
        settle();
        eq(calls[1], 'edit');
        eq(parseInbox(text()).items[1].text, 'SQLite idea #idea [created:: 2026-10-07 14:22] #new');
        w.inbox.dialogs = { editNote: () => null };
        const before = text();
        w.inbox.editItem(0);
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
        ok(w.inboxMode && isInbox(text()), 'the new document is not an inbox');
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
}
