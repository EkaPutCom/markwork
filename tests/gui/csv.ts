// GUI tests: the CSV tab (ui/csvpage.ts) and the way a .csv file opens in it.

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import type Gtk from 'gi://Gtk?version=4.0';
import { findEntry } from '../../src/ui/menu.js';
import { widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import type { GuiContext } from './context.js';

const CSV = 'name,age,city\nAda,36,London\nLin,41,"Taipei, TW"\n';

export function csvTests(c: GuiContext): void {
    const { w, pump, text } = c;
    section('CSV tab');
    const settle = () => { for (let i = 0; i < 25; i++) { pump(); GLib.usleep(8000); } };
    const open = (content = CSV, name = 'sheet.csv') => {
        const file = GLib.build_filenamev([tmp, name]);
        GLib.file_set_contents(file, content);
        w.load(file);
        settle();
        return file;
    };
    // Edit a cell the way a user does: type, then leave it.
    const type = (row: number, column: number, value: string) => {
        const entry = w.csv.entryAt(row, column)!;
        entry.grab_focus();
        settle();
        entry.set_text(value);
        w.csv.entryAt(row === 1 ? 2 : 1, column)!.grab_focus();
        settle();
    };

    test('a .csv file opens as a table, and opening it does not change the text', () => {
        open();
        ok(w.csvMode && !w.tableMode, 'the CSV table is not shown');
        eq(text(), CSV);
        eq(w.csv.shownCells(), [['name', 'age', 'city'], ['Ada', '36', 'London'], ['Lin', '41', 'Taipei, TW']]);
        ok(w.statusBar.right.label.includes('2 rows · 3 columns'), `status: ${w.statusBar.right.label}`);
    });

    test('a cell edit is written to the document when the cell is left, and only that line changes', () => {
        open();
        type(1, 1, '37');
        eq(text(), 'name,age,city\nAda,37,London\nLin,41,"Taipei, TW"\n');
        type(2, 2, 'Kyoto, JP');
        eq(text(), 'name,age,city\nAda,37,London\nLin,41,"Kyoto, JP"\n');
    });

    test('undo and redo follow the table: one edit is one step', () => {
        open();
        type(1, 0, 'Grace');
        eq(w.csv.shownCells()[1][0], 'Grace');
        c.action('undo'); settle();
        eq(text(), CSV);
        eq(w.csv.shownCells()[1][0], 'Ada', 'the table shows the undone text');
        c.action('redo'); settle();
        eq(w.csv.shownCells()[1][0], 'Grace');
    });

    test('rows and columns are added and deleted from the menus; each is one undo step', () => {
        open();
        findEntry(w.csv.menuFor(1, 0), 'Insert Row Below')!.run!(); settle();
        eq(text(), 'name,age,city\nAda,36,London\n,,\nLin,41,"Taipei, TW"\n');
        findEntry(w.csv.menuFor(2, 0), 'Delete Row')!.run!(); settle();
        eq(text(), CSV);
        findEntry(w.csv.menuFor(0, 1), 'Insert Column Right')!.run!(); settle();
        eq(text(), 'name,age,Column 4,city\nAda,36,,London\nLin,41,,"Taipei, TW"\n');
        findEntry(w.csv.menuFor(0, 2), 'Delete Column')!.run!(); settle();
        eq(text(), CSV);
        c.action('undo'); settle();
        eq(text(), 'name,age,Column 4,city\nAda,36,,London\nLin,41,,"Taipei, TW"\n');
    });

    // The cell that has the focus, as [row, column], or null.
    const focusedCell = (): [number, number] | null => {
        const found = w.csv['cellOf'](w.win.get_focus());
        return found ? [found.cell.row, found.cell.column] : null;
    };
    // A key pressed in a cell, through the handler the entry's controller calls.
    const press = (row: number, column: number, keyval: number, state = 0 as Gdk.ModifierType) => {
        const entry = w.csv.entryAt(row, column)!;
        entry.grab_focus();
        settle();
        const handled = w.csv['keyPressed']({ row, column }, entry, keyval, state);
        settle();
        return handled;
    };

    test('Enter writes the cell and moves down; Enter in the last row adds a row; Shift+Enter moves up', () => {
        open();
        w.csv.entryAt(1, 1)!.set_text('37');
        ok(press(1, 1, Gdk.KEY_Return), 'Enter was not handled');
        eq(text(), 'name,age,city\nAda,37,London\nLin,41,"Taipei, TW"\n', 'written');
        eq(focusedCell(), [2, 1]);
        press(2, 1, Gdk.KEY_Return);
        eq(text(), 'name,age,city\nAda,37,London\nLin,41,"Taipei, TW"\n,,\n', 'a row was added');
        eq(focusedCell(), [3, 1], 'the focus is in the new row');
        press(3, 1, Gdk.KEY_Return, Gdk.ModifierType.SHIFT_MASK);
        eq(focusedCell(), [2, 1]);
    });

    test('Tab in the last cell adds a row, elsewhere it is left to the focus chain; Ctrl+Enter inserts below', () => {
        open();
        eq(press(1, 0, Gdk.KEY_Tab), false, 'Tab in the middle is not handled');
        eq(press(2, 2, Gdk.KEY_Tab), true);
        eq(text(), 'name,age,city\nAda,36,London\nLin,41,"Taipei, TW"\n,,\n');
        eq(focusedCell(), [3, 0], 'the new row, first cell');
        press(1, 2, Gdk.KEY_Return, Gdk.ModifierType.CONTROL_MASK);
        eq(text(), 'name,age,city\nAda,36,London\n,,\nLin,41,"Taipei, TW"\n,,\n');
        eq(focusedCell(), [2, 2]);
    });

    test('Escape puts the old value back; the arrows move between rows', () => {
        open();
        const entry = w.csv.entryAt(1, 0)!;
        entry.set_text('changed');
        press(1, 0, Gdk.KEY_Escape);
        eq(entry.text, 'Ada');
        eq(text(), CSV);
        press(1, 0, Gdk.KEY_Down);
        eq(focusedCell(), [2, 0]);
        press(2, 0, Gdk.KEY_Up);
        eq(focusedCell(), [1, 0]);
    });

    test('a row is moved by a drop between two others, and a column by a drop on the header; each is one undo step', () => {
        open('a,b,c\n1,x,10\n2,y,20\n3,z,30\n');
        w.csv['dropAt']('row', 1, 4); settle();
        eq(text(), 'a,b,c\n2,y,20\n3,z,30\n1,x,10\n', 'row 1 dropped after the last');
        w.csv['dropAt']('row', 3, 1); settle();
        eq(text(), 'a,b,c\n1,x,10\n2,y,20\n3,z,30\n', 'the last row dropped before the first');
        w.csv['dropAt']('row', 2, 3); settle();
        eq(text(), 'a,b,c\n1,x,10\n2,y,20\n3,z,30\n', 'dropping in the gap next to itself moves nothing');
        w.csv['dropAt']('column', 0, 3); settle();
        eq(text(), 'a,b,c\nx,10,1\ny,20,2\nz,30,3\n'.replace('a,b,c', 'b,c,a'), 'column a dropped after the last');
        eq(w.csv.shownCells()[1], ['x', '10', '1']);
        eq([0, 1, 2].map(c => w.csv.entryAt(1, c)!.xalign), [0, 1, 1], 'the numbers are aligned right in their new places');
        c.action('undo'); settle();
        eq(text(), 'a,b,c\n1,x,10\n2,y,20\n3,z,30\n', 'one undo puts the column back');
        eq([0, 1, 2].map(c => w.csv.entryAt(1, c)!.xalign), [1, 0, 1], 'and the alignment');
    });

    test('a drop is placed by the pointer: the half of a row, the half of a header, and the edges of the table', () => {
        open('a,b,c\n1,x,10\n2,y,20\n3,z,30\n');
        const list = w.csv['list'] as Gtk.Widget;
        const rect = (row: number) => { const r = w.csv['bound'].get(row - 1)!.box.compute_bounds(list)![1]; return { top: r.get_y(), height: r.get_height() }; };
        const r2 = rect(2);
        eq(w.csv.gapAt('row', 5, r2.top + 2), 2, 'upper half of row 2: before it');
        eq(w.csv.gapAt('row', 5, r2.top + r2.height - 2), 3, 'lower half: after it');
        eq(w.csv.gapAt('row', 5, rect(3).top + rect(3).height + 200), 4, 'below the last row: at the end');
        const head = w.csv['headBoxes'][1].compute_bounds(w.csv['headScroll'] as Gtk.Widget)![1];
        eq(w.csv.gapAt('column', head.get_x() + 2, 5), 1, 'left half of column b');
        eq(w.csv.gapAt('column', head.get_x() + head.get_width() - 2, 5), 2, 'right half');
        eq(w.csv.gapAt('column', 99999, 5), 3, 'past the last column: at the end');
    });

    test('a table wider than the window scrolls sideways, and the header scrolls with the rows', () => {
        const wide = Array.from({ length: 14 }, (_x, c) => `column number ${c}`);
        open(`${wide.join(',')}\n${wide.map((_x, c) => `value ${c}`).join(',')}\n`, 'wide.csv');
        const scroll = w.csv['bodyScroll'] as Gtk.ScrolledWindow;
        const range = scroll.hadjustment;
        ok(range.upper > range.page_size + 200, `the table is squeezed into the window: ${range.upper} px in ${range.page_size} px`);
        const last = w.csv['headBoxes'][13] as Gtk.Widget, row = w.csv['bound'].get(0)!.entries[13] as Gtk.Widget;
        const headX = last.compute_bounds(w.csv['headScroll'] as Gtk.Widget)![1].get_x(), rowX = row.compute_bounds(w.csv['list'] as Gtk.Widget)![1].get_x();
        range.set_value(range.upper - range.page_size); settle();
        const after = last.compute_bounds(w.csv['headScroll'] as Gtk.Widget)![1].get_x();
        ok(Math.abs(after - (headX - range.value)) < 2, 'the header did not follow the scroll');
        ok(Math.abs(headX - rowX) < 3, `a column is not in the same place in the header (${headX}) and in the rows (${rowX})`);
        range.set_value(0); settle();
    });

    // Type in the search bar the way a user does.
    const search = (query: string) => { w.csv.bar.setQuery(query); settle(); };
    const marked = () => w.csv.shownCells().flatMap((row, r) => row.map((_cell, c) => [r, c] as const)).filter(([r, c]) => w.csv.entryAt(r, c)?.has_css_class('csv-match'));

    test('Ctrl+F in the table opens its search bar, not the text one; the cells that match are marked and the first is current', () => {
        open('name,city\nAda,Paris\nLin,Taipei\nPaula,Paris\n');
        c.action('find'); settle();
        ok(w.csv.searchState().open, 'the table search bar did not open');
        ok(!w.findBar.get_search_mode(), 'the text search bar opened behind the table');
        ok(!w.csv.bar.replaceShown, 'Ctrl+F shows the Replace row');
        search('pa');
        eq(w.csv.searchState(), { matches: 3, current: 0, label: '1 of 3', open: true });
        eq(marked(), [[1, 1], [3, 0], [3, 1]], 'Paris, Paula, Paris');
        ok(w.csv.entryAt(1, 1)!.has_css_class('csv-match-current'), 'the first match is not the current one');
        eq(text(), 'name,city\nAda,Paris\nLin,Taipei\nPaula,Paris\n', 'searching changes nothing');
    });

    test('next and previous go round the matches; no match says so; closing the bar clears the marks and focuses the current cell', () => {
        open('name,city\nAda,Paris\nLin,Taipei\nPaula,Paris\n');
        c.action('find'); settle();
        search('pa');
        w.csv['step'](1); settle();
        eq(w.csv.searchState().label, '2 of 3');
        w.csv['step'](1); w.csv['step'](1); settle();
        eq(w.csv.searchState().label, '1 of 3', 'wrapped round to the first');
        w.csv['step'](-1); settle();
        eq(w.csv.searchState().label, '3 of 3', 'and back to the last');
        search('xyz');
        eq(w.csv.searchState(), { matches: 0, current: -1, label: 'No results', open: true });
        eq(marked(), []);
        search('lin');
        w.csv['closeSearch'](); settle();
        eq(marked(), [], 'the marks went with the bar');
        eq(focusedCell(), [2, 0], 'the cell of the match is focused');
    });

    test('the options of the search work as in the text editor: match case, whole words, regular expression; a bad expression is marked', () => {
        open('name,city\nAda,Paris\nlin,"Par, ada"\nZed,PARIS\n');
        c.action('find'); settle();
        search('paris');
        eq(w.csv.searchState().matches, 2, 'any case');
        w.csv.bar.buttons.matchCase.active = true; settle();
        eq(w.csv.searchState().matches, 0, 'match case: paris is in no cell as written');
        w.csv.bar.buttons.matchCase.active = false;
        search('ada');
        eq(w.csv.searchState().matches, 2);
        w.csv.bar.buttons.wholeWord.active = true; settle();
        eq(w.csv.searchState().matches, 2, 'whole word: Ada and "Par, ada" both have it as a word');
        search('ad');
        eq(w.csv.searchState().matches, 0, 'whole word: ad is not a word in either');
        w.csv.bar.buttons.wholeWord.active = false;
        w.csv.bar.buttons.regex.active = true;
        search('^(p|z)\\w+$');
        eq(w.csv.searchState().matches, 3, 'regular expression: Paris, Zed, and PARIS, not "Par, ada"');
        search('(');
        eq([w.csv.searchState().matches, w.csv.bar.counter, w.csv.bar._entry.has_css_class('error')], [0, '', true], 'a bad expression finds nothing and is marked');
        w.csv.bar.buttons.regex.active = false;
        w.csv.bar.close(); settle();
    });

    test('Ctrl+H shows the Replace row; Replace changes the current cell and goes to the next match; one undo step each', () => {
        open('name,city\nAda,Paris\nLin,Paris Paris\nZed,Rome\n');
        c.action('replace'); settle();
        ok(w.csv.bar.replaceShown, 'the Replace row is not shown');
        search('paris');
        w.csv.bar.setReplacement('Lyon');
        eq(w.csv.searchState().label, '1 of 2');
        w.csv.bar._replaceOne.emit('clicked'); settle();
        eq(text(), 'name,city\nAda,Lyon\nLin,Paris Paris\nZed,Rome\n');
        eq(w.csv.searchState().label, '1 of 1', 'on to the next match');
        ok(w.csv.entryAt(2, 1)!.has_css_class('csv-match-current'), 'the next match is the current one');
        w.csv.bar._replaceOne.emit('clicked'); settle();
        eq(text(), 'name,city\nAda,Lyon\nLin,Lyon Lyon\nZed,Rome\n', 'every match in the cell');
        eq(w.csv.searchState().label, 'No results');
        c.action('undo'); settle();
        eq(text(), 'name,city\nAda,Lyon\nLin,Paris Paris\nZed,Rome\n', 'one undo per Replace');
        w.csv.bar.close(); settle();
    });

    test('All replaces in every cell as one undo step, with $1 in a regular expression; nothing to replace changes nothing', () => {
        open('name,city\nAda,Paris\nLin,paris 7\nZed,Rome\n');
        c.action('replace'); settle();
        search('paris');
        w.csv.bar.setReplacement('Lyon');
        w.csv.bar._replaceAll.emit('clicked'); settle();
        eq(text(), 'name,city\nAda,Lyon\nLin,Lyon 7\nZed,Rome\n');
        eq(w.csv.searchState().label, 'No results');
        c.action('undo'); settle();
        eq(text(), 'name,city\nAda,Paris\nLin,paris 7\nZed,Rome\n', 'one undo for all');
        w.csv.bar.buttons.regex.active = true;
        search('(\\w+) (\\d)');
        w.csv.bar.setReplacement('$2 $1');
        w.csv.bar._replaceAll.emit('clicked'); settle();
        eq(text(), 'name,city\nAda,Paris\nLin,7 paris\nZed,Rome\n', 'a regular expression can use the groups');
        const before = text();
        search('nothing');
        w.csv.bar._replaceAll.emit('clicked'); settle();
        eq(text(), before);
        w.csv.bar.buttons.regex.active = false;
        w.csv.bar.close(); settle();
    });

    test('the search follows the table: an edit and an undo change what matches', () => {
        open('name,city\nAda,Paris\nLin,Taipei\n');
        c.action('find'); settle();
        search('paris');
        eq(w.csv.searchState().matches, 1);
        type(2, 1, 'Paris'); settle();
        eq(w.csv.searchState().matches, 2, 'an edit that makes a match');
        c.action('undo'); settle();
        eq(w.csv.searchState().matches, 1, 'and its undo');
    });

    test('a search finds a row far down a long file and scrolls to it', () => {
        const lines = ['id,name'];
        for (let i = 1; i <= 20000; i++) lines.push(`${i},person ${i}`);
        open(lines.join('\n') + '\n', 'search-big.csv');
        c.action('find'); settle();
        search('person 17777');
        eq(w.csv.searchState().matches, 1);
        settle();
        ok(w.csv.entryAt(17777, 1)?.has_css_class('csv-match-current'), 'the row was not scrolled to, or not marked');
        w.csv.bar.close(); settle();
    });

    test('the header row cannot be deleted or have a row inserted above it', () => {
        open();
        eq(findEntry(w.csv.menuFor(0, 0), 'Delete Row')!.enabled, false);
        eq(findEntry(w.csv.menuFor(0, 0), 'Insert Row Above')!.enabled, false);
    });

    test('Escape-style revert: leaving a cell with its old text writes nothing', () => {
        open();
        const before = text();
        w.csv.entryAt(1, 0)!.grab_focus();
        w.csv.entryAt(2, 0)!.grab_focus();
        settle();
        eq(text(), before);
    });

    test('the text view and back', () => {
        open();
        w.toggleBoardView(false);
        ok(!w.csvMode, 'still a table');
        w.toggleBoardView(true);
        ok(w.csvMode, 'did not return to the table');
    });

    test('a file of 20,000 rows is a table with row widgets only for the rows on screen; an edit far down changes one line', () => {
        const lines = ['id,name,score'];
        for (let i = 1; i <= 20000; i++) lines.push(`${i},person ${i},${(i * 7) % 100}`);
        const big = lines.join('\n') + '\n';
        const before = w.csv.rowWidgets().made;
        open(big, 'big.csv');
        ok(w.csvMode, 'a file of 20,000 rows is not shown as a table');
        const { made, bound, height, listHeight } = w.csv.rowWidgets();
        ok(bound > 0 && bound < 40 && made - before < 400, `${made} row widgets made, ${bound} bound, view ${height} px, list ${listHeight} px`);
        eq(text(), big, 'opening did not change the text');
        // Down to row 15000 by keyboard-like focus, then an edit and a move away.
        w.csv['focusCell'](15000, 1); settle();
        eq(focusedCell(), [15000, 1], 'the row far down was not scrolled to and focused');
        w.csv.entryAt(15000, 1)!.set_text('edited');
        w.csv['focusCell'](15001, 1); settle();
        const after = text().split('\n');
        eq(after.length, lines.length + 1);
        eq(after[15000], '15000,edited,0');
        eq(after.filter((line, i) => line !== lines[i] && i < lines.length).length, 1, 'more than one line changed');
        w.csv['focusCell'](1, 0); settle();
        eq(w.csv.shownCells()[1][1], 'person 1', 'the top is shown again after scrolling back');
    });

    test('a quoted multi-line cell round-trips, and other documents are not shown as a table', () => {
        const multi = 'a,b\n"line 1\nline 2",x\n';
        open(multi);
        eq(w.csv.shownCells()[1][0], 'line 1\nline 2');
        eq(text(), multi);
        open('# Not a table\n', 'note.md');
        ok(!w.csvMode, 'a Markdown file is shown as a table');
    });

    test('screenshot of the CSV tab', () => {
        // --shot-csv=<prefix>: save <prefix>-light.png, <prefix>-dark.png, <prefix>-find.png (the search bar), and <prefix>-big.png (a file of 20,000 rows).
        const shot = optVal('shot-csv');
        if (!shot) return;
        const rows = ['Date,Customer,Amount,Qty,Status'];
        const names = ['PT Maju Jaya', 'CV Sinar Baru', 'Toko Makmur', 'UD Berkah'];
        const status = ['paid', 'paid', 'pending', 'refunded'];
        for (let i = 0; i < 14; i++) rows.push(`2026-07-${String(i + 2).padStart(2, '0')},${names[i % 4]},${(12400000 - i * 530000)},${40 - i * 2},${status[i % 4]}`);
        open(rows.join('\n') + '\n', 'sales-q3.csv');
        w.csv.entryAt(3, 1)!.grab_focus();
        w.win.set_focus(w.csv.entryAt(3, 1)!);
        for (const dark of [false, true]) {
            w.setOption('dark', dark);
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(15000); }
            widgetPixbuf(w.win)?.savev(`${shot}-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
        }
        w.setOption('dark', false);
        // The search bar, with the matches marked.
        w.csv.openFind();
        w.csv.bar.setQuery('paid');
        for (let i = 0; i < 30; i++) { pump(); GLib.usleep(15000); }
        w.csv['step'](1);
        for (let i = 0; i < 30; i++) { pump(); GLib.usleep(15000); }
        widgetPixbuf(w.win)?.savev(`${shot}-find.png`, 'png', [], []);
        w.csv['closeSearch']();
        // A file of 20,000 rows, scrolled far down.
        const lines = ['id,name,score'];
        for (let i = 1; i <= 20000; i++) lines.push(`${i},person ${i},${(i * 7) % 100}`);
        open(lines.join('\n') + '\n', 'many.csv');
        w.csv['focusCell'](12000, 1);
        for (let i = 0; i < 30; i++) { pump(); GLib.usleep(15000); }
        widgetPixbuf(w.win)?.savev(`${shot}-big.png`, 'png', [], []);
    });
}
