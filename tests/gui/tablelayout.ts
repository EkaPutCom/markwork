// GUI tests: the table layout (ui/table.ts), not the Markdown tables of the editor (gui/table.ts).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { parseBoard } from '../../src/markdown/kanban.js';
import { isTable } from '../../src/markdown/layout.js';
import { descendants } from '../widgets.js';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';

const TABLE = [
    '---', 'layout: table', 'add: top', 'fields:', '  status: select(todo:gray, doing:blue, done:green) = todo', '  due: date', '  progress: progress', '---', '',
    '# Sprint', '',
    '- [ ] Delta [status:: doing] [due:: 2026-10-14] [progress:: 3/5]',
    '- [ ] Alpha [status:: todo] [due:: 2026-10-08]',
    '- [x] Charlie [status:: done] [due:: 2026-10-16] [progress:: 100%]',
    '- [ ] Bravo', '',
].join('\n');

export function tableLayoutGuiTests(c: GuiContext): void {
    const { w, pump, text } = c;
    section('Table layout (view)');
    const file = GLib.build_filenamev([tmp, 'table.md']);
    const settle = () => { for (let i = 0; i < 25; i++) { pump(); GLib.usleep(8000); } };
    const open = (content = TABLE) => { GLib.file_set_contents(file, content); w.load(file); settle(); };
    w.table.today = () => '2026-10-11';
    w.table.now = () => new Date(2026, 9, 11, 9, 30);

    const grid = () => w.table['grid'] as Gtk.Grid;
    // Column 0 is the checkbox column (these notes have checkboxes), then Title, status, due, progress, and the delete column.
    const cell = (col: number, row: number) => grid().get_child_at(col, row)!;
    const labelsIn = (widget: Gtk.Widget) => descendants(widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label);
    const titles = () => [1, 2, 3, 4].map(r => labelsIn(cell(1, r))[0]?.label).filter(Boolean);
    // The header cell is a button itself, and so is the delete cell.
    const buttonIn = (widget: Gtk.Widget) => (widget instanceof Gtk.Button ? widget : descendants(widget).find((x): x is Gtk.Button => x instanceof Gtk.Button))!;
    const head = (col: number) => buttonIn(cell(col, 0));
    const items = () => parseBoard(text()).columns.flatMap(g => g.cards.map(i => i.text));

    test('a table document opens as a table, not as a board, a list, or text; its text is not changed by being opened', () => {
        open();
        ok(w.tableMode && !w.boardMode && !w.inboxMode, 'the table is not shown');
        eq(text(), TABLE);
        ok(w.statusBar.right.label.includes('4 notes'), `status: ${w.statusBar.right.label}`);
        eq([1, 2, 3, 4].map(col => head(col).label), ['Title', 'status', 'due', 'progress'], 'the column headers');
    });

    test('cells: a select is a colored chip, a progress is a bar, a date past its day is marked, a missing value is a dash', () => {
        open();
        const chip = labelsIn(cell(2, 1))[0];
        eq(chip.label, 'doing');
        ok(chip.has_css_class('opt-blue'), 'the color chosen for the option');
        ok(descendants(cell(4, 1)).some(x => x instanceof Gtk.ProgressBar && Math.abs(x.fraction - 0.6) < 1e-9), 'the bar of 3/5');
        ok(labelsIn(cell(3, 2))[0].has_css_class('table-late'), 'Alpha was due on the 8th, and it is the 11th');
        ok(!labelsIn(cell(3, 1))[0].has_css_class('table-late'), 'Delta is not late');
        ok(!labelsIn(cell(3, 3))[0].has_css_class('table-late'), 'a done note is never late');
        eq(labelsIn(cell(3, 4))[0].label, '—', 'Bravo has no date');
        eq(labelsIn(cell(2, 4))[0].label, '—', 'and no status');
    });

    test('a click on a header sorts: ascending, descending, back to the order of the document; the file is not rewritten', () => {
        open();
        eq(titles(), ['Delta', 'Alpha', 'Charlie', 'Bravo'], 'the order of the document');
        head(3).emit('clicked'); settle();
        eq(titles(), ['Alpha', 'Delta', 'Charlie', 'Bravo'], 'by due ascending; Bravo has none and goes last');
        ok(head(3).label?.endsWith('▲'), 'the arrow');
        head(3).emit('clicked'); settle();
        eq(titles(), ['Charlie', 'Delta', 'Alpha', 'Bravo'], 'descending; Bravo is still last');
        head(3).emit('clicked'); settle();
        eq(titles(), ['Delta', 'Alpha', 'Charlie', 'Bravo'], 'back to the document order');
        head(1).emit('clicked'); settle();
        eq(titles(), ['Alpha', 'Bravo', 'Charlie', 'Delta'], 'by title');
        eq(text(), TABLE, 'sorting does not change the text');
        open(TABLE.replace('add: top', 'add: top\nsort: -due'));
        eq(titles(), ['Charlie', 'Delta', 'Alpha', 'Bravo'], 'the sort: of the document');
        open();
    });

    test('a click on a cell changes the field in place from a popover; a new option is one undo step', () => {
        open();
        const alphaStatus = cell(2, 2);
        const pop = w.table.editField({ column: 0, index: 1 }, 'status', alphaStatus)!;
        settle();
        const buttons = descendants(pop).filter((x): x is Gtk.Button => x instanceof Gtk.Button);
        buttons.find(b => b.label === 'doing')!.emit('clicked'); settle(); settle();
        ok(items()[1].includes('[status:: doing]'), items()[1]);
        const again = w.table.editField({ column: 0, index: 3 }, 'status', cell(2, 4))!;
        settle();
        const entry = descendants(again).find((x): x is Gtk.Entry => x instanceof Gtk.Entry)!;
        entry.set_text('blocked'); settle();
        descendants(again).filter((x): x is Gtk.Button => x instanceof Gtk.Button).find(b => b.label === 'Add “blocked” to the list')!.emit('clicked'); settle(); settle();
        ok(text().includes('status: select(todo:gray, doing:blue, done:green, blocked)') && items()[3].includes('[status:: blocked]'), text());
        c.action('undo'); settle();
        ok(!text().includes('blocked'), 'one undo reverts the option and the value together');
        c.action('undo'); settle();
        eq(text(), TABLE);
        open();
    });

    test('quick add puts a row where add: says with the defaults of the fields; New Row and delete work, and undo restores', () => {
        open();
        w.table.capture('Zulu'); settle();
        eq(items()[0], 'Zulu [status:: todo]', 'at the top, with the default status');
        ok(titles()[0] === 'Zulu' || titles().includes('Zulu'), 'shown');
        const remove = buttonIn(cell(5, 1));
        remove.emit('clicked'); settle();
        eq(items().length, 4, 'deleted');
        c.action('undo'); c.action('undo'); settle();
        eq(text(), TABLE);
        open();
    });

    test('the checkbox column marks a note done and back', () => {
        open();
        const check = descendants(cell(0, 1)).find((x): x is Gtk.CheckButton => x instanceof Gtk.CheckButton)!;
        check.set_active(true); settle();
        ok(text().includes('- [x] Delta'), 'checked');
        check.set_active(false); settle();
        ok(text().includes('- [ ] Delta'), 'and unchecked');
        open();
    });

    test('Fields… is available on a table; the same file is a board or a list when its layout line says so; New Table makes a table', () => {
        open();
        ok((c.app.lookup_action('fields-edit') as unknown as { enabled: boolean }).enabled, 'enabled while a table is shown');
        open(TABLE.replace('layout: table', 'layout: board'));
        ok(w.boardMode && !w.tableMode, 'a board');
        open(TABLE.replace('layout: table', 'layout: list'));
        ok(w.inboxMode && !w.tableMode, 'a list');
        w.newTableDocument(); settle();
        // `text()` is the text of the first editor; the new document is in a tab of its own.
        ok(w.tableMode && isTable(w.editor.getText()), 'the new document is not a table');
        eq(parseBoard(w.editor.getText()).columns, [], 'with no rows yet');
        while (w.editor !== c.ed) ok(w.closeTab(), 'closeTab() failed');
        open();
    });
}
