// Table layout tests (markdown/tablelayout.ts).

import { nextSort, newTable, sortSpec, tableColumns, tableRows } from '../../src/markdown/tablelayout';
import { boardSchema, parseBoard, serializeBoard } from '../../src/markdown/kanban';
import { layoutOf } from '../../src/markdown/layout';
import { section, test, eq, ok } from '../core/framework';

const TABLE = (extra = '') => `---\nlayout: table\n${extra}fields:\n  status: select(todo:gray, doing:blue, done:green) = todo\n  due: date\n  progress: progress\n  owner: person\n---\n\n# Sprint\n\n- [ ] Delta [status:: doing] [due:: 2026-10-14] [progress:: 3/5] [owner:: Eka]\n- [ ] Alpha [status:: todo] [due:: 2026-10-16]\n- [ ] Charlie [status:: done] [due:: 2026-10-08 09:00] [progress:: 100%]\n- [ ] Bravo [status:: doing] [owner:: Rina]\n\n## Later\n\n- [ ] Echo [due:: 2026-10-01] [progress:: 1/10]\n`;
const rowsOf = (extra: string, sort: string | null) => {
    const board = parseBoard(TABLE(extra));
    const spec = sort === null ? null : nextSort(null, sort.replace(/^-/, '')) && { key: sort.replace(/^-/, ''), desc: sort.startsWith('-') };
    return tableRows(board, spec).map(r => r.card.text.split(' [')[0].replace('- [ ] ', ''));
};

export function tableLayoutTests(): void {
    section('Table layout (model)');

    test('layout: table is recognized, has only the fields it declares, and a new table is written and read back', () => {
        eq(layoutOf(TABLE()), 'table');
        eq(boardSchema(parseBoard(TABLE())).map(f => f.key), ['status', 'due', 'progress', 'owner'], 'no built-in due or agent');
        const text = serializeBoard(newTable('Tasks'));
        eq(layoutOf(text), 'table');
        eq(boardSchema(parseBoard(text)).map(f => f.key), ['status']);
        eq(serializeBoard(parseBoard(text)), text, 'stable');
    });

    test('tableColumns: the title and every field by default (and the section when a group has a title); columns: picks and orders them', () => {
        const board = parseBoard(TABLE());
        eq(tableColumns(board), ['title', 'status', 'due', 'progress', 'owner', 'section']);
        eq(tableColumns(parseBoard(TABLE('columns: [title, due, status]\n'))), ['title', 'due', 'status']);
        eq(tableColumns(parseBoard(TABLE('columns: due, nope, title, due, section\n'))), ['due', 'title', 'section'], 'unknown and repeated names are left out, brackets are optional');
        eq(tableColumns(parseBoard(TABLE('columns: [nope]\n'))), ['title', 'status', 'due', 'progress', 'owner', 'section'], 'nothing usable: the default');
        eq(tableColumns(parseBoard('---\nlayout: table\n---\n\n- one\n')), ['title'], 'no fields, no sections');
    });

    test('sortSpec reads sort: with an optional minus', () => {
        eq([sortSpec(parseBoard(TABLE('sort: due\n'))), sortSpec(parseBoard(TABLE('sort: -progress\n'))), sortSpec(parseBoard(TABLE())), sortSpec(parseBoard(TABLE('sort: -\n')))],
            [{ key: 'due', desc: false }, { key: 'progress', desc: true }, null, null]);
    });

    test('tableRows: document order, or sorted by title, date, progress, option order, or section; notes without a value go last', () => {
        eq(rowsOf('', null), ['Delta', 'Alpha', 'Charlie', 'Bravo', 'Echo'], 'the order of the document, across groups');
        eq(rowsOf('', 'title'), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
        eq(rowsOf('', 'due'), ['Echo', 'Charlie', 'Delta', 'Alpha', 'Bravo'], 'dates; the one without a date last');
        eq(rowsOf('', '-due'), ['Alpha', 'Delta', 'Charlie', 'Echo', 'Bravo'], 'descending, and the one without a date is still last');
        eq(rowsOf('', 'progress'), ['Echo', 'Delta', 'Charlie', 'Alpha', 'Bravo'], 'by the ratio, 3/5 before 100%');
        eq(rowsOf('', 'status'), ['Alpha', 'Delta', 'Bravo', 'Charlie', 'Echo'], 'by the order of the options (todo, doing, done); equal ones keep the document order; none last');
        eq(rowsOf('', 'section'), ['Delta', 'Alpha', 'Charlie', 'Bravo', 'Echo'], 'by section, the unnamed one first');
        eq(rowsOf('', 'nope'), ['Delta', 'Alpha', 'Charlie', 'Bravo', 'Echo'], 'a key that is not a column: the document order');
        ok(tableRows(parseBoard(TABLE()), null)[4].section === 'Later' && tableRows(parseBoard(TABLE()), null)[4].at.column === 1, 'a row knows its section and position');
    });

    test('nextSort: ascending, then descending, then the document order; another column starts again', () => {
        const a = nextSort(null, 'due'), b = nextSort(a, 'due'), c = nextSort(b, 'due');
        eq([a, b, c, nextSort(b, 'title')], [{ key: 'due', desc: false }, { key: 'due', desc: true }, null, { key: 'title', desc: false }]);
    });
}
