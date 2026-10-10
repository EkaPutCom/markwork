// GUI tests: Kanban (board).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { readTextFile } from '../../src/files.js';
import { addCard, parseBoard } from '../../src/markdown/kanban.js';
import { isBoard } from '../../src/markdown/layout.js';
import { KanbanBoard } from '../../src/ui/kanban.js';
import { dueField, editCardDialog, findDialog } from '../../src/ui/dialogs.js';
import { findEntry, type MenuEntry } from '../../src/ui/menu.js';
import { childrenOf } from '../../src/gtkutil.js';
import { descendants, whenDialogReady, widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal, settle } from '../framework.js';
import { BOARD } from '../fixtures.js';
import type { GuiContext } from './context.js';

export function kanbanBoardTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, action } = c;

    section('Kanban (board)');
    const board = GLib.build_filenamev([tmp, 'board.md']);
    GLib.file_set_contents(board, BOARD);
    const kb = w.board;
    const settleK = () => { for (let i = 0; i < 25; i++) { pump(); GLib.usleep(8000); } };
    const kbDescendants = descendants;
    const kbEntry = (name: string) => kbDescendants(kb.widget).find(c => c.get_name() === name) as Gtk.Entry | undefined;
    const kbCheck = (col: number, idx: number) => kbDescendants(kb.columns[col].cards[idx]).find(c => c instanceof Gtk.CheckButton) as Gtk.CheckButton;
    const kbMenu = (menu: MenuEntry[], label: string) => {
        const item = findEntry(menu, label);
        if (!item) throw new Error(`menu item "${label}" does not exist`);
        return { item, enabled: item.enabled !== false, activate: () => item.run!() };
    };
    const kbTitles = () => kb.getBoard().columns.map(c => c.title);
    // A point on the card `target` (offset dx, dy) expressed in the coordinates of the card `from`.
    const inCard = (from: Gtk.Widget, target: Gtk.Widget, dx: number, dy: number) => {
        const [, x, y] = target.translate_coordinates(from, dx, dy);
        return [x, y] as const;
    };
    const stubDialogs = (over: Partial<KanbanBoard['dialogs']> = {}) => {
        const calls: string[] = [];
        kb.dialogs = {
            editCard: () => { calls.push('edit'); return null; },
            prompt: () => { calls.push('prompt'); return null; },
            confirm: () => { calls.push('confirm'); return true; },
            ...over,
        };
        return calls;
    };
    const openBoard = () => { GLib.file_set_contents(board, BOARD); w.load(board); settleK(); };

    test('fields declared in the frontmatter are shown as chips; a value that does not fit is marked and its text is unchanged', () => {
        const text = '---\nlayout: board\nfields:\n  prioritas: select(tinggi, sedang, rendah)\n  progres: progress\n---\n\n## Plan\n\n- [ ] Parser [prioritas:: sedang] [progres:: 3/5] [due:: 2026-10-20]\n- [ ] Broken [prioritas:: urgent] [owner:: Eka]\n';
        GLib.file_set_contents(board, text); w.load(board); settleK();
        const chips = (idx: number) => kbDescendants(kb.columns[0].cards[idx]).filter((x): x is Gtk.Label => x instanceof Gtk.Label && x.has_css_class('kanban-chip'));
        eq(chips(0).slice(0, 2).map(c => c.label), ['sedang', 'progres: 3/5'], 'select value, then progress; the due badge follows');
        ok(chips(0).at(-1)!.has_css_class('kanban-due'), 'the due badge is still its own chip');
        ok(chips(0)[0].has_css_class('kanban-tag-1'), 'a select option takes the color of its position');
        eq(chips(1).map(c => [c.label, c.has_css_class('kanban-field-invalid')]), [['prioritas: urgent', true], ['owner: Eka', false]]);
        ok(chips(1)[0].get_tooltip_text()?.includes('not one of: tinggi, sedang, rendah'), 'the reason is in the tooltip');
        eq(kb.getBoard().columns[0].cards[1].text, 'Broken [prioritas:: urgent] [owner:: Eka]', 'the text of the card is unchanged');
        openBoard();
    });

    // Change a field in place from its popover.
    const FIELD_BOARD = '---\nlayout: board\nfields:\n  prioritas: select(tinggi, sedang, rendah)\n  progres: progress\n---\n\n## Plan\n\n- [ ] Parser [prioritas:: sedang] [due:: 2026-10-20 09:00]\n';
    const popoverOf = (key: string, column = 0, index = 0): Gtk.Popover => {
        const popover = kb.editField(column, index, key);
        ok(popover, `no popover for ${key}`);
        settleK();
        return popover;
    };
    const popButtons = (popover: Gtk.Popover) => descendants(popover).filter((x): x is Gtk.Button => x instanceof Gtk.Button);
    const popButton = (popover: Gtk.Popover, label: string) => popButtons(popover).find(b => b.label === label) ?? (() => { throw new Error(`no button "${label}"`); })();
    const popEntry = (popover: Gtk.Popover) => descendants(popover).find((x): x is Gtk.Entry => x instanceof Gtk.Entry)!;

    test('a select popover lists the options and sets one; Clear removes the field', () => {
        GLib.file_set_contents(board, FIELD_BOARD); w.load(board); settleK();
        let pop = popoverOf('prioritas');
        eq(popButtons(pop).filter(b => b.get_visible()).map(b => b.label), ['tinggi', '✓ sedang', 'rendah', 'Clear'], 'the current option is marked');
        popButton(pop, 'tinggi').emit('clicked'); settleK();
        eq(kb.getBoard().columns[0].cards[0].text, 'Parser [prioritas:: tinggi] [due:: 2026-10-20 09:00]');
        ok(text().includes('[prioritas:: tinggi]'), 'written to the document');
        pop = popoverOf('prioritas');
        popButton(pop, 'Clear').emit('clicked'); settleK();
        eq(kb.getBoard().columns[0].cards[0].text, 'Parser [due:: 2026-10-20 09:00]');
        eq(kb.editField(0, 0, 'nope'), null, 'a key that is not declared has no popover');
    });

    test('a typed select value: a close option is offered, a new one needs a confirmation and is one undo step', () => {
        GLib.file_set_contents(board, FIELD_BOARD); w.load(board); settleK();
        const before = text();
        let pop = popoverOf('prioritas');
        const entry = popEntry(pop);
        const offer = () => popButtons(pop).find(b => b.get_visible() && /^(Use|Add) /.test(b.label ?? ''));
        ok(!offer(), 'nothing is offered for an empty entry');
        entry.set_text('tingi'); settleK();
        eq(offer()?.label, 'Use “tinggi”', 'one typo away from an existing option');
        entry.set_text('urgent'); settleK();
        eq(offer()?.label, 'Add “urgent” to the list');
        eq(text(), before, 'nothing is written before the confirmation');
        offer()!.emit('clicked'); settleK();
        ok(text().includes('prioritas: select(tinggi, sedang, rendah, urgent)'), 'the option is in the frontmatter');
        ok(text().includes('[prioritas:: urgent]'), 'and the card uses it');
        action('undo'); settleK();
        eq(text(), before, 'one undo reverts the option and the value together');
        pop = popoverOf('prioritas');
        popEntry(pop).set_text('tingi'); settleK();
        popButtons(pop).find(b => b.get_visible() && b.label === 'Use “tinggi”')!.emit('clicked'); settleK();
        ok(text().includes('[prioritas:: tinggi]') && !text().includes('urgent'), 'using the close option adds nothing to the list');
    });

    test('a date popover keeps the time; an entry popover refuses a value that does not fit', () => {
        GLib.file_set_contents(board, FIELD_BOARD); w.load(board); settleK();
        let pop = popoverOf('due');
        const calendar = descendants(pop).find((x): x is Gtk.Calendar => x instanceof Gtk.Calendar)!;
        eq(calendar.get_date().format('%Y-%m-%d'), '2026-10-20', 'the calendar opens on the date in the field');
        calendar.select_day(GLib.DateTime.new_local(2026, 11, 2, 0, 0, 0)); settleK();
        eq(kb.getBoard().columns[0].cards[0].text, 'Parser [prioritas:: sedang] [due:: 2026-11-02 09:00]');
        pop = popoverOf('progres');
        const entry = popEntry(pop);
        entry.set_text('nope'); entry.emit('activate'); settleK();
        ok(entry.has_css_class('error'), 'marked');
        ok(!kb.getBoard().columns[0].cards[0].text.includes('progres'), 'nothing written');
        entry.set_text('4/5'); entry.emit('activate'); settleK();
        ok(kb.getBoard().columns[0].cards[0].text.endsWith('[progres:: 4/5]'), kb.getBoard().columns[0].cards[0].text);
        openBoard();
    });

    test('a card offers the fields it has no value for; choosing one opens its popover and fills it in', () => {
        const T = '---\nlayout: board\nfields:\n  prioritas: select(tinggi, sedang, rendah)\n  progres: progress\n---\n\n## Plan\n\n- [ ] Bare\n- [ ] Full [prioritas:: sedang] [progres:: 1/2] [due:: 2026-10-20]\n';
        GLib.file_set_contents(board, T); w.load(board); settleK();
        const addButton = (idx: number) => kbDescendants(kb.columns[0].cards[idx]).find((x): x is Gtk.Button => x instanceof Gtk.Button && x.has_css_class('kanban-add-field'));
        ok(addButton(0), 'a card with fields to fill has the add button');
        ok(!addButton(1), 'a card with every field filled has none');
        eq(kb.addFieldMenu(1, 0), null, 'nothing to offer when every field has a value');
        const menu = kb.addFieldMenu(0, 0)!;
        settleK();
        eq(popButtons(menu).filter(b => b.get_visible()).map(b => b.label), ['due', 'prioritas', 'progres'], 'the agent is not offered here');
        popButton(menu, 'prioritas').emit('clicked'); settleK(); settleK();
        const pop = kbDescendants(kb.widget).find((x): x is Gtk.Popover => x instanceof Gtk.Popover && x.get_mapped());
        ok(pop, 'the popover of the chosen field opened');
        popButton(pop, 'rendah').emit('clicked'); settleK();
        eq(kb.getBoard().columns[0].cards[0].text, 'Bare [prioritas:: rendah]');
        action('undo'); settleK();
        eq(text(), T, 'one undo');
        openBoard();
    });

    test('a kanban document opens as a board, a plain document as text', () => {
        openBoard();
        ok(w.boardMode, 'the board is not shown');
        eq(kbTitles(), ['Plan', 'In Progress', 'Done']);
        eq(kb.columns.map(c => c.cards.length), [2, 1, 2], 'number of cards');
        ok(w.statusBar.right.label.includes('3 lists · 5 cards'), `status: ${w.statusBar.right.label}`);
        eq(text(), BOARD, 'the document text did not change because it was opened');
        GLib.file_set_contents(board, '# Plain\n\ntext');
        w.load(board); settleK();
        ok(!w.boardMode, 'a plain document was shown as a board');
        openBoard();
    });
    test('adding a card through the dialog writes to the document text', () => {
        openBoard();
        const titles: (string | undefined)[] = [];
        stubDialogs({ editCard: (_p, _c, title) => { titles.push(title); return { text: 'Test card #new', notes: ['note'] }; } });
        kb.showAddCard(1); settleK();
        eq(titles, ['Add Card'], 'dialog title');
        eq(kb.cardTexts(1), ['Design logo', 'Test card #new'], 'model');
        ok(text().includes('- [ ] Design logo\n- [ ] Test card #new\n  note\n'), 'document text');
        ok(buf.get_modified(), 'the document was not marked as modified');
        stubDialogs({ editCard: () => ({ text: '', notes: [] }) });
        kb.showAddCard(1); settleK();
        eq(kb.cardTexts(1).length, 2, 'an empty card was rejected');
        stubDialogs({ editCard: () => null });
        kb.showAddCard(1); settleK();
        eq(kb.cardTexts(1).length, 2, 'cancelled');
    });
    test('adding a list through the entry', () => {
        openBoard();
        kb.showAddList(); settleK();
        const entry = kbEntry('kanban-entry-list')!;
        ok(entry.get_child_visible() && entry.get_mapped(), 'the entry is shown after clicking Add list');
        entry.set_text('Review'); entry.emit('activate'); settleK();
        eq(kbTitles(), ['Plan', 'In Progress', 'Done', 'Review']);
        ok(text().includes('## Review'), 'document text');
        kb.hideAdd();
    });
    test('the checkbox marks the card as done', () => {
        openBoard();
        kbCheck(0, 1).set_active(true); settleK();
        eq(kb.getBoard().columns[0].cards[1].done, true, 'model');
        ok(text().includes('- [x] Send invitations'), 'document text');
        ok(kb.columns[0].cards[1].has_css_class('kanban-card-done'), 'done card style');
    });
    test('card menu: delete, move to another list, up/down, mark done', () => {
        openBoard();
        const menu = kb.cardMenu(0, 0);
        ok(!kbMenu(menu, 'Move Up').enabled && kbMenu(menu, 'Move Down').enabled, 'Move Up/Move Down on the first card');
        kbMenu(menu, 'Move Down').activate(); settleK();
        eq(kb.cardTexts(0), ['Send invitations', 'Write report #important [due:: 2026-10-20]'], 'down');
        const submenu = kbMenu(kb.cardMenu(0, 0), 'Move to').item.submenu!;
        eq(submenu.map(e => e.label), ['In Progress', 'Done'], 'the destinations do not include the source list');
        submenu.find(e => e.label === 'Done')!.run!(); settleK();
        eq([kb.cardTexts(0).length, kb.cardTexts(2).at(-1)], [1, 'Send invitations'], 'moved to the end of the target list');
        kbMenu(kb.cardMenu(2, 2), 'Mark Done').activate(); settleK();
        eq(kb.getBoard().columns[2].cards[2].done, true, 'mark done');
        kbMenu(kb.cardMenu(2, 2), 'Delete').activate(); settleK();
        eq(kb.cardTexts(2).length, 2, 'delete');
    });
    test('list menu: rename, move, delete with confirmation', () => {
        openBoard();
        const calls = stubDialogs({ prompt: () => 'Backlog' });
        kbMenu(kb.columnMenu(0), 'Rename…').activate(); settleK();
        eq(kbTitles()[0], 'Backlog', 'rename');
        ok(!kbMenu(kb.columnMenu(0), 'Move Left').enabled, 'the first list cannot move left');
        kbMenu(kb.columnMenu(0), 'Move Right').activate(); settleK();
        eq(kbTitles(), ['In Progress', 'Backlog', 'Done'], 'move');
        stubDialogs({ confirm: () => false });
        kbMenu(kb.columnMenu(1), 'Delete List…').activate(); settleK();
        eq(kbTitles().length, 3, 'not deleted after all');
        stubDialogs({ confirm: () => true });
        kbMenu(kb.columnMenu(1), 'Delete List…').activate(); settleK();
        eq(kbTitles(), ['In Progress', 'Done'], 'deleted');
        void calls;
    });
    test('editing a card through the dialog: title and notes', () => {
        openBoard();
        stubDialogs({ editCard: () => ({ text: 'New title #x', notes: ['line 1', 'line 2'] }) });
        kb.editCard(0, 1); settleK();
        eq(kb.getBoard().columns[0].cards[1], { done: false, text: 'New title #x', notes: ['line 1', 'line 2'] });
        ok(text().includes('- [ ] New title #x\n  line 1\n  line 2\n'), 'document text');
        stubDialogs({ editCard: () => ({ text: '', notes: [] }) });
        kb.editCard(0, 1); settleK();
        eq(kb.cardTexts(0)[1], 'New title #x', 'an empty title does not overwrite');
    });
    test('clicking a card without moving opens the edit dialog; a small motion still counts as a click', () => {
        openBoard();
        const calls = stubDialogs();
        const card = kb.columns[0].cards[0];
        kb.onCardPress(0, 0, card, 10, 10);
        kb.onCardMotion(12, 11);
        ok(!kb.dragging, 'a 3 pixel motion was treated as dragging');
        kb.onCardRelease();
        eq(calls, ['edit']);
    });
    test('dragging a card to another list drops it at the indicated position', () => {
        openBoard();
        const calls = stubDialogs();
        const moved = kb.cardTexts(0)[0];
        const source = kb.columns[0].cards[0], target = kb.columns[2].cards[0];
        kb.onCardPress(0, 0, source, 10, 10);
        const top = inCard(source, target, 10, 4);   // on the upper half of the first card of the target list
        kb.onCardMotion(top[0], top[1]);
        ok(kb.dragging, 'dragging did not start');
        eq(childrenOf(kb.columns[2].cardsBox).length, 3, 'the drop marker appeared in the target list');
        const ghost = kb['drag']!.ghost;
        ok(ghost.get_parent(), 'ghost card');
        kb.onCardRelease(); settleK();
        ok(!kb.dragging, 'still dragging after release');
        ok(!ghost.get_parent(), 'the ghost card was not cleaned up');
        eq([kb.cardTexts(2)[0], kb.cardTexts(0).length, kb.cardTexts(2).length], [moved, 1, 3], 'the card moved to the top of the target list');
        ok(text().includes(`## Done\n\n- [ ] ${moved}\n`), 'document text');
        eq(calls, [], 'dragging did not open the edit dialog');
    });
    test('dragging onto the lower half of a card drops after it; within the same list it reorders', () => {
        openBoard();
        const source = kb.columns[0].cards[0], second = kb.columns[0].cards[1];
        const first = kb.cardTexts(0)[0];
        kb.onCardPress(0, 0, source, 10, 10);
        const low = inCard(source, second, 10, second.get_allocated_height() - 3);
        kb.onCardMotion(low[0], low[1]);
        kb.onCardRelease(); settleK();
        eq(kb.cardTexts(0)[1], first, 'the first card went below the second card');
    });
    test('dropping at the original place changes nothing', () => {
        openBoard();
        buf.set_modified(false);
        const source = kb.columns[1].cards[0];
        kb.onCardPress(1, 0, source, 10, 10);
        const same = inCard(source, source, 10, 4);
        kb.onCardMotion(same[0] + 200, same[1]);   // 200 px to the right → dragging
        kb.onCardMotion(same[0], same[1]);         // then back to the original place
        kb.onCardRelease(); settleK();
        eq(text(), BOARD, 'text');
        ok(!buf.get_modified(), 'the document was marked as modified');
    });
    test('dragging into the empty space below a list drops at the end of that list', () => {
        openBoard();
        const source = kb.columns[0].cards[0], last = kb.columns[1].cards[0];
        const moved = kb.cardTexts(0)[0];
        kb.onCardPress(0, 0, source, 10, 10);
        const below = inCard(source, last, 10, 400);
        kb.onCardMotion(below[0], below[1]);
        kb.onCardRelease(); settleK();
        eq(kb.cardTexts(1).at(-1), moved);
    });
    test('dragging near the right edge scrolls the board', () => {
        openBoard();
        kb.showAddList(); kb.hideAdd(); settleK();
        const hadj = kb.scroller.get_hadjustment();
        if (hadj.get_upper() - hadj.get_page_size() < 50) { w.win.set_default_size(700, 600); settleK(); }
        hadj.set_value(0);
        const source = kb.columns[0].cards[0];
        kb.onCardPress(0, 0, source, 10, 10);
        kb.onCardMotion(20, 20);
        const drag = kb['drag']!;
        const edgeX = hadj.get_value() + kb.scroller.get_allocated_width() - 10;   // 10 px from the right edge
        drag.pointer = [edgeX, drag.pointer[1]];
        kb.autoscroll();
        ok(hadj.get_value() > 0, `the board did not scroll  (${hadj.get_value()})`);
        kb.onCardRelease(); settleK();
        w.win.set_default_size(1100, 700); settleK();
    });
    test('undo and redo restore the board and the text, one step per change', () => {
        openBoard();
        kb.commit(addCard(kb.getBoard(), 0, 'One'));
        kb.commit(addCard(kb.getBoard(), 0, 'Two')); settleK();
        eq(kb.cardTexts(0).length, 4, 'two cards were added');
        action('undo'); settleK();
        eq([kb.cardTexts(0).length, text().includes('Two')], [3, false], 'the first undo only reverted "Two"');
        action('undo'); settleK();
        eq([kb.cardTexts(0).length, text()], [2, BOARD], 'the second undo restored the original text');
        action('redo'); settleK();
        eq(kb.cardTexts(0).at(-1), 'One', 'redo');
    });
    test('switching to the text view and back; changes in the text appear on the board', () => {
        openBoard();
        w.toggleBoardView(false); settleK();
        ok(!w.boardMode && ed.widget.get_visible(), 'text view');
        eq(text(), BOARD, 'raw text');
        setText(BOARD.replace('- [ ] Send invitations', '- [ ] Send invitations\n- [ ] From text'));
        w.toggleBoardView(true); settleK();
        ok(w.boardMode, 'back to the board');
        eq(kb.cardTexts(0), ['Write report #important [due:: 2026-10-20]', 'Send invitations', 'From text']);
    });
    test('the board view for a plain document is refused with a message', () => {
        GLib.file_set_contents(board, '# Plain');
        w.load(board); settleK();
        w.toggleBoardView(true);
        ok(!w.boardMode, 'a plain document was shown as a board');
        ok(w.lastToast.includes('not a board or list'), `message: ${w.lastToast}`);
    });
    test('a new kanban board contains three empty lists', () => {
        w.newBoardDocument(); settleK();
        ok(w.boardMode && w.file === null, 'mode or file name');
        eq(kbTitles(), ['Plan', 'In Progress', 'Done']);
        ok(isBoard(w.editor.getText()), 'the text is not a kanban board');
        // The new board opens in a new tab (the previous document has a file); close it so the other tests use the original editor.
        ok(w.closeTab(), 'closeTab() failed'); settleK();
        ok(w.editor === ed, 'the original editor is no longer active');
    });
    test('actions that edit text are disabled while the board is shown and enabled again in the text view', () => {
        openBoard();
        const before = text();
        action('bold'); action('heading1'); action('table');
        eq(text(), before, 'the text changed');
        const enabled = (name: string) => w.app.lookup_action(name)!.enabled;
        eq([enabled('bold'), enabled('heading1'), enabled('table'), enabled('save')], [false, false, false, true], 'action state on the board');
        w.toggleBoardView(false); settleK();
        eq([enabled('bold'), enabled('table')], [true, true], 'action state in the text view');
        w.toggleBoardView(true); settleK();
    });
    test('saving writes Markdown that can be read back as the same board', () => {
        openBoard();
        kb.commit(addCard(kb.getBoard(), 1, 'Saved'));
        const out = GLib.build_filenamev([tmp, 'save.md']);
        w.file = out;
        ok(w.save(), 'save() failed');
        const saved = readTextFile(out);
        eq(saved, text(), 'file contents = document contents');
        eq(parseBoard(saved), kb.getBoard(), 'the board from the file = the board on screen');
        w.file = null;
    });
    test('date label: the year only if it is not this year; a date past its limit is marked', () => {
        kb.today = () => '2026-10-20';
        eq([kb.formatDue('2026-10-25'), kb.formatDue('2027-01-02')], ['25 Oct', '2 Jan 2027']);
        openBoard();
        const chip = (cls: string) => kbDescendants(kb.widget).some(c => c instanceof Gtk.Label && c.has_css_class(cls));
        ok(!chip('kanban-due-overdue'), 'the date of 20 Oct is not overdue on 20 Oct');
        kb.today = () => '2026-10-21'; kb.render(); settleK();
        ok(chip('kanban-due-overdue'), 'the date of 20 Oct must be overdue on 21 Oct');
        kb.today = () => '2026-10-20';
        eq([kb.tagColor('important'), kb.tagColor('important')].every(c => c >= 0 && c < 8), true, 'tag color in range');
        eq(kb.tagColor('bug'), kb.tagColor('bug'), 'tag color is stable');
    });
    test('replaceText: a minimal edit, one undo step, safe for emoji', () => {
        setText('top 🎉 middle 🎉 bottom');
        buf.set_modified(false);
        ed.replaceText('top 🎉 MIDDLE 🎉 bottom'); pump();
        eq(text(), 'top 🎉 MIDDLE 🎉 bottom');
        buf.undo(); pump();
        eq(text(), 'top 🎉 middle 🎉 bottom', 'undo');
        buf.set_modified(false);
        ed.replaceText('top 🎉 middle 🎉 bottom'); pump();
        ok(!buf.get_modified(), 'the same text does not modify the document');
        ed.replaceText('🎉🎉'); pump();
        eq(text(), '🎉🎉', 'a surrogate pair at the edge');
        ed.replaceText('x🎉🎉y'); pump();
        eq(text(), 'x🎉🎉y');
    });
    test('the board and dragging do not trigger GTK warnings', () => {
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Gdk', 'Pango', 'GLib-GObject'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, m) => { warnings.push(`${domain}: ${m}`); })] as const);
        try {
            openBoard();
            const source = kb.columns[0].cards[0], target = kb.columns[2].cards[0];
            kb.onCardPress(0, 0, source, 10, 10);
            const at = inCard(source, target, 10, 4);
            kb.onCardMotion(at[0], at[1]); settleK();
            kb.onCardRelease(); settleK();
            kb.showAddList(); settleK(); kb.hideAdd(); settleK();
            w.setDark(true); settleK(); w.setDark(false); settleK();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'warnings');
    });
    GLib.file_set_contents(board, '# done');
    w.load(board); settleK();
    stubDialogs();
    w.file = null;
    buf.set_modified(false);

    test('due date field: the calendar fills in the date, keeps the time, and can be cleared', () => {
        const field = dueField('2026-10-05 09:30');
        const host = new Gtk.Window({ child: field.widget, default_width: 400 });
        host.present();
        pump();
        const popover = field.button.popover!;
        field.button.popup();
        pump();
        const date = field.calendar.get_date();
        eq([date.get_year(), date.get_month(), date.get_day_of_month()], [2026, 10, 5], 'the calendar points at the date in the field');
        eq(field.entry.text, '2026-10-05 09:30', 'opening the calendar does not change the field');
        const shot = optVal('shot-due');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(popover)?.savev(`${shot}-calendar.png`, 'png', [], []);
        }
        // Clicking a day = select_day then day-selected (select_day itself does not emit it).
        field.calendar.select_day(GLib.DateTime.new_local(2026, 10, 20, 0, 0, 0));
        field.calendar.emit('day-selected');
        pump();
        eq(field.entry.text, '2026-10-20 09:30', 'the date changed, the time stayed');
        ok(!popover.get_visible(), 'the calendar closed after choosing');

        field.entry.text = 'not a date';
        field.button.popup();
        pump();
        const today = GLib.DateTime.new_now_local();
        eq(field.calendar.get_date().format('%Y-%m-%d'), today.format('%Y-%m-%d'), 'invalid text: the calendar is on today');
        const buttons = descendants(popover).filter((b): b is Gtk.Button => b instanceof Gtk.Button);
        buttons.find(b => b.label === 'Clear')!.emit('clicked');
        pump();
        eq(field.entry.text, '', 'cleared');
        field.button.popup();
        pump();
        buttons.find(b => b.label === 'Today')!.emit('clicked');
        pump();
        eq(field.entry.text, today.format('%Y-%m-%d'), 'today');
        host.destroy();
        pump();
        // The real card edit dialog (modal), light and dark: captured from a timer while shown, then closed.
        if (shot) {
            for (const dark of [false, true]) {
                w.setOption('dark', dark);
                whenDialogReady(() => findDialog('Add Card'), dialog => {
                    widgetPixbuf(dialog)?.savev(`${shot}-dialog${dark ? '-dark' : ''}.png`, 'png', [], []);
                    dialog.close();
                });
                settle(editCardDialog(w.win, { text: 'Write report #work [due:: 2026-10-20]', notes: ['Follow the decision in [[Meeting Notes]].'] }, 'Add Card', () => ['Meeting Notes.md']));
            }
            w.setOption('dark', false);
            pump();
        }
    });
}
