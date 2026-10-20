// CSV model tests: reading, writing without disturbing untouched rows, and the operations of the CSV tab.

import { section, test, eq } from '../core/framework.js';
import { buildPattern, type SearchOptions } from '../../src/markdown/search.js';
import {
    cellAt, columnCount, findCells, replaceInCell, replaceInCells, landing, moveColumn, moveRow, CSV_VIEW_CELLS, fitsTableView, deleteColumn, deleteRow, insertColumn, insertRow, isCsvFile, isNumericColumn, newCsvText, nextColumnName, parseCsv,
    serializeCsv, setCell,
} from '../../src/markdown/csv.js';

const cells = (text: string): string[][] => parseCsv(text).rows.map(r => [...r.cells]);

export function csvTests(): void {
    section('CSV');
    test('the CSV tab opens .csv files, whatever the case', () => {
        eq(['a.csv', 'A.CSV', 'a.csv.md', 'csv', 'a.tsv'].map(isCsvFile), [true, true, false, false, false]);
        eq(isCsvFile(null), false);
    });
    test('records split into cells', () => {
        eq(cells('name,age\nAda,36\nLin,41\n'), [['name', 'age'], ['Ada', '36'], ['Lin', '41']]);
    });
    test('quotes hold delimiters, line breaks, and doubled quotes', () => {
        eq(cells('a,b\n"x, y","line 1\nline 2"\n"say ""hi""",z\n'), [['a', 'b'], ['x, y', 'line 1\nline 2'], ['say "hi"', 'z']]);
    });
    test('empty cells, a trailing delimiter, and a last record without a line break', () => {
        eq(cells('a,,c\n,,\nx,'), [['a', '', 'c'], ['', '', ''], ['x', '']]);
    });
    test('an empty file is one empty header cell', () => {
        eq(cells(''), [['']]);
        eq(serializeCsv(parseCsv('')), '');
    });
    test('the delimiter is the one that splits the first record', () => {
        eq(parseCsv('a;b;c\n1;2;3\n').delimiter, ';');
        eq(parseCsv('a\tb\n1\t2\n').delimiter, '\t');
        eq(parseCsv('a|b\n').delimiter, '|');
        eq(parseCsv('single\nvalue\n').delimiter, ',');
        eq(parseCsv('"a;b",c\n').delimiter, ',', 'a delimiter inside quotes does not count');
        eq(cells('a;b\n1;2\n'), [['a', 'b'], ['1', '2']]);
    });
    test('a file that was not touched is written exactly as it was read', () => {
        const samples = [
            'a,b\n1,2\n', 'a,b\n1,2', 'a,b\r\n1,2\r\n', '﻿a,b\n1,2\n', 'a, b ,"c"\n"1" ,2,\n', 'a,b\n\n1,2\n\n',
            '"multi\nline",x\n', 'a;b\n1;2\n', 'x\n', 'a,b\r\n"q\r\nr",2', ',\n,\n',
        ];
        for (const text of samples) eq(serializeCsv(parseCsv(text)), text, JSON.stringify(text));
    });
    test('an edited cell rewrites only its own record', () => {
        const table = parseCsv('a, b ,"c"\n"1" ,2,3\nx,y,z\n');
        const edited = setCell(table, 2, 1, 'new');
        eq(serializeCsv(edited), 'a, b ,"c"\n"1" ,2,3\nx,new,z\n');
        eq(edited.rows[0], table.rows[0], 'the header is the same record');
        eq(setCell(table, 1, 0, '9') === table, false);
        eq(setCell(table, 2, 1, 'y') === table, true, 'setting the same value changes nothing');
    });
    test('a value that needs quotes gets them, and only then', () => {
        let table = parseCsv('a,b\n1,2\n');
        table = setCell(table, 1, 0, 'x, y');
        table = setCell(table, 1, 1, 'say "hi"');
        eq(serializeCsv(table), 'a,b\n"x, y","say ""hi"""\n');
        eq(serializeCsv(setCell(parseCsv('a;b\n1;2\n'), 1, 0, 'x, y')), 'a;b\nx, y;2\n', 'a comma needs no quotes in a semicolon file');
        eq(serializeCsv(setCell(parseCsv('a,b\n1,2\n'), 1, 0, 'two\nlines')), 'a,b\n"two\nlines",2\n');
    });
    test('the line ending and the final line break are kept', () => {
        eq(serializeCsv(setCell(parseCsv('a,b\r\n1,2\r\n'), 1, 0, '9')), 'a,b\r\n9,2\r\n');
        eq(serializeCsv(setCell(parseCsv('a,b\n1,2'), 1, 0, '9')), 'a,b\n9,2');
        eq(serializeCsv(setCell(parseCsv('﻿a,b\n1,2\n'), 1, 0, '9')), '﻿a,b\n9,2\n');
    });
    test('a short record grows when a cell past its end is set', () => {
        const table = setCell(parseCsv('a,b,c\n1\n'), 1, 2, 'z');
        eq(serializeCsv(table), 'a,b,c\n1,,z\n');
        eq(cellAt(table, 1, 5), '');
    });
    test('a row is inserted below the header or at the end, as wide as the table', () => {
        const table = parseCsv('a,b,c\n1,2,3\n');
        eq(serializeCsv(insertRow(table, 1)), 'a,b,c\n,,\n1,2,3\n');
        eq(serializeCsv(insertRow(table, 2)), 'a,b,c\n1,2,3\n,,\n');
        eq(serializeCsv(insertRow(table, 0)), 'a,b,c\n,,\n1,2,3\n', 'nothing goes above the header');
        eq(serializeCsv(insertRow(table, 99)), 'a,b,c\n1,2,3\n,,\n');
    });
    test('a row is deleted, but not the header', () => {
        const table = parseCsv('a,b\n1,2\n3,4\n');
        eq(serializeCsv(deleteRow(table, 1)), 'a,b\n3,4\n');
        eq(deleteRow(table, 0) === table, true);
        eq(deleteRow(table, 9) === table, true);
        eq(serializeCsv(deleteRow(deleteRow(deleteRow(parseCsv('a\n1\n'), 1), 0), 0)), 'a\n', 'the header stays when all rows are gone');
    });
    test('a column is inserted with a header and empty cells', () => {
        const table = parseCsv('a,b\n1,2\n3\n');
        eq(serializeCsv(insertColumn(table, 1, 'mid')), 'a,mid,b\n1,,2\n3,,\n');
        eq(serializeCsv(insertColumn(table, 2, 'end')), 'a,b,end\n1,2,\n3,,\n');
        eq(serializeCsv(insertColumn(table, 0, 'first')), 'first,a,b\n,1,2\n,3,\n');
    });
    test('a column is deleted from every record, but not the last one', () => {
        const table = parseCsv('a,b,c\n1,2,3\n');
        eq(serializeCsv(deleteColumn(table, 1)), 'a,c\n1,3\n');
        eq(deleteColumn(parseCsv('a\n1\n'), 0) === parseCsv('a\n1\n'), false);
        const single = parseCsv('a\n1\n');
        eq(deleteColumn(single, 0) === single, true);
        eq(deleteColumn(table, 7) === table, true);
    });
    test('the width is the widest record', () => {
        eq(columnCount(parseCsv('a\n1,2,3\n')), 3);
        eq(columnCount(parseCsv('')), 1);
    });
    test('a new column is named after the next free number', () => {
        eq(nextColumnName(parseCsv('a,b,c\n')), 'Column 4');
        eq(nextColumnName(parseCsv('Column 3,Column 4,x\n')), 'Column 5', 'a name that is taken is skipped');
    });
    test('a column of numbers is recognized, blanks aside; one other value makes it text', () => {
        const table = parseCsv('n,amount,mixed,empty\nAda,12,1,\nLin,-3.5,x,\nZed,,2,\n1,\"1,200\",3,\n');
        eq([0, 1, 2, 3].map(c => isNumericColumn(table, c)), [false, true, false, false]);
        eq(isNumericColumn(parseCsv('p\n50%\n+7\n.5\n'), 0), true);
    });
    test('a table of a hundred thousand rows fits the table view, and one of a million cells and more does not', () => {
        const row = { cells: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], raw: null };
        const table = (rows: number) => ({ ...parseCsv('a\n'), rows: new Array(rows).fill(row) });
        eq(fitsTableView(table(100_000)), true);
        eq(fitsTableView(table(CSV_VIEW_CELLS / 10 + 1)), false);
    });
    test('a row moves to another place and the other lines keep their text; the header cannot move or be passed', () => {
        const table = parseCsv('h,i\n"a",1\nb, 2\nc,3\n');
        eq(serializeCsv(moveRow(table, 1, 3)), 'h,i\nb, 2\nc,3\n"a",1\n');
        eq(serializeCsv(moveRow(table, 3, 1)), 'h,i\nc,3\n"a",1\nb, 2\n');
        eq(serializeCsv(moveRow(table, 2, 0)), 'h,i\nb, 2\n"a",1\nc,3\n', 'nothing goes above the header');
        eq(serializeCsv(moveRow(table, 1, 99)), 'h,i\nb, 2\nc,3\n"a",1\n');
        eq(moveRow(table, 0, 2) === table, true, 'the header does not move');
        eq(moveRow(table, 2, 2) === table, true);
        eq(moveRow(table, 9, 1) === table, true);
    });
    test('a column moves in every record, short ones included', () => {
        const table = parseCsv('a,b,c\n1,2,3\n4\n');
        eq(serializeCsv(moveColumn(table, 0, 2)), 'b,c,a\n2,3,1\n,,4\n');
        eq(serializeCsv(moveColumn(table, 2, 0)), 'c,a,b\n3,1,2\n,4,\n');
        eq(moveColumn(table, 1, 1) === table, true);
        eq(moveColumn(table, 5, 0) === table, true);
    });
    test('dropping before a gap lands one place earlier when the dragged item was before it', () => {
        eq([[1, 1], [1, 2], [1, 3], [3, 1], [3, 3], [3, 4]].map(([from, gap]) => landing(from, gap)), [1, 1, 2, 1, 3, 3]);
    });
    const pattern = (query: string, options: Partial<SearchOptions> = {}): RegExp => {
        const built = buildPattern(query, { caseSensitive: false, wholeWord: false, regex: false, ...options });
        if (!(built instanceof RegExp)) throw new Error('no pattern');
        return built;
    };
    test('finding looks in every cell, header included, in reading order, with the options of the search', () => {
        const table = parseCsv('Name,City\nAda,Paris\nlin,"Par, Ada"\nZed,\n');
        eq(findCells(table, pattern('ada')), [{ row: 1, column: 0 }, { row: 2, column: 1 }]);
        eq(findCells(table, pattern('PAR')), [{ row: 1, column: 1 }, { row: 2, column: 1 }]);
        eq(findCells(table, pattern('PAR', { caseSensitive: true })), []);
        eq(findCells(table, pattern('name')), [{ row: 0, column: 0 }], 'the header too');
        eq(findCells(table, pattern('par', { wholeWord: true })), [{ row: 2, column: 1 }], 'Par, but not Paris');
        eq(findCells(table, pattern('^a.a$', { regex: true })), [{ row: 1, column: 0 }]);
        eq(findCells(table, pattern('nothing here')), []);
    });
    test('replacing in a cell changes its matches only, and the row alone is written again', () => {
        const table = parseCsv('n,city\n"a",Paris Paris\nb, Rome\n');
        const next = replaceInCell(table, 1, 1, pattern('paris'), 'Lyon', false);
        eq(serializeCsv(next), 'n,city\na,Lyon Lyon\nb, Rome\n', 'the edited row is written again, without quotes it does not need');
        eq(next.rows[2] === table.rows[2], true, 'the other rows are the same');
        eq(replaceInCell(table, 2, 1, pattern('paris'), 'x', false) === table, true, 'no match: the same table');
        eq(serializeCsv(replaceInCell(table, 2, 1, pattern('(R)ome', { regex: true }), '$1-$&', true)), 'n,city\n"a",Paris Paris\nb, R-Rome\n');
    });
    test('replacing everywhere counts the matches and leaves rows without one as they were', () => {
        const table = parseCsv('city,note\nParis,"in Paris, FR"\nRome,\nparis,x\n');
        const done = replaceInCells(table, pattern('paris'), 'Lyon', false);
        eq(done.count, 3);
        eq(serializeCsv(done.table), 'city,note\nLyon,"in Lyon, FR"\nRome,\nLyon,x\n');
        eq(done.table.rows[2] === table.rows[2], true);
        eq(replaceInCells(table, pattern('zzz'), 'x', false), { table, count: 0 });
        eq(serializeCsv(replaceInCells(table, pattern('^city$', { regex: true }), 'town', true).table), 'town,note\nParis,"in Paris, FR"\nRome,\nparis,x\n', 'the header is replaced too');
    });
    test('a new file is a header and an empty row', () => {
        eq(newCsvText(['Column 1', 'Column 2', 'Column 3']), 'Column 1,Column 2,Column 3\n,,\n');
    });
}
