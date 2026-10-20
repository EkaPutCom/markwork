// Markdown table model tests (markdown/table.ts).

import { cellIndexAt, cellStart, deleteColumn, deleteRow, displayWidth, findTables, fitColumns, insertColumn, insertRow, parseTable, renderTable, setAlign, splitRow, tableEnd } from '../../src/markdown/table.js';
import { section, test, eq, ok } from '../framework.js';

export function tableTests(): void {
    section('Markdown tables');
    const spans = (line: string) => splitRow(line).map(c => [c.text, c.start, c.end]);
    test('splitRow: edge pipes, no edge pipes, empty cell, \\|', () => {
        eq(spans('| a | b |'), [['a', 2, 3], ['b', 6, 7]], 'with edge pipes');
        eq(spans('a | b'), [['a', 0, 1], ['b', 4, 5]], 'without edge pipes');
        eq(spans('|  | x |'), [['', 2, 2], ['x', 5, 6]], 'empty cell');
        eq(spans('| a \\| b | c |').map(c => c[0]), ['a \\| b', 'c'], 'an escaped pipe is not a separator');
        eq(splitRow('| one |').length, 1, 'one cell');
    });
    test('cellIndexAt and cellStart', () => {
        const line = '| aa | bb | cc |';
        eq([cellIndexAt(line, 2), cellIndexAt(line, 7), cellIndexAt(line, 12)], [0, 1, 2], 'column at position');
        eq([cellStart(line, 0), cellStart(line, 2), cellStart(line, 9)], [2, 12, line.length], 'cell start; out of range = end of line');
    });
    test('parseTable: alignment, missing and extra cells', () => {
        const t = parseTable(['| a | b | c | d |', '| :--- | :-: | ---: | --- |', '| 1 |', '| 1 | 2 | 3 | 4 | 5 |']);
        eq(t.aligns, ['left', 'center', 'right', null], 'alignment');
        eq(t.rows, [['1', '', '', ''], ['1', '2', '3', '4']], 'rows are padded/truncated to the header count');
    });
    test('displayWidth: CJK and emoji take two columns, joiners take zero', () => {
        eq([displayWidth('abc'), displayWidth('日本'), displayWidth('🎉'), displayWidth('e\u0301')], [3, 4, 2, 1]);
    });
    test('renderTable tidies columns according to alignment', () => {
        const t = parseTable(['| Name | N |', '| :-- | --: |', '| one | 1 |', '| thirty | 30 |']);
        eq(renderTable(t), [
            '| Name   |   N |',
            '| :----- | --: |',
            '| one    |   1 |',
            '| thirty |  30 |',
        ]);
    });
    test('renderTable: CJK width counts as two columns', () => {
        const lines = renderTable(parseTable(['| a | b |', '| --- | --- |', '| 日本 | x |']));
        eq(lines, ['| a    | b   |', '| ---- | --- |', '| 日本 | x   |']);
    });
    test('renderTable followed by parseTable returns the same table', () => {
        const t = parseTable(['| a | b |', '| :-: | --: |', '| 1 | 2 |']);
        eq(parseTable(renderTable(t)), t);
    });
    test('row and column operations do not change the original table', () => {
        const t = parseTable(['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |']);
        const before = JSON.stringify(t);
        eq(insertRow(t, 1).rows, [['1', '2'], ['', ''], ['3', '4']], 'insert row');
        eq(deleteRow(t, 0).rows, [['3', '4']], 'delete row');
        eq(insertColumn(t, 1).header, ['a', '', 'b'], 'insert column');
        eq(insertColumn(t, 1).rows[0], ['1', '', '2'], 'insert column in a body row');
        eq(deleteColumn(t, 0).header, ['b'], 'delete column');
        eq(setAlign(t, 1, 'right').aligns, [null, 'right'], 'alignment');
        eq(JSON.stringify(t), before, 'original table');
    });
    test('the last column cannot be deleted', () => {
        const t = parseTable(['| a |', '| --- |', '| 1 |']);
        eq(deleteColumn(t, 0), t);
    });
    test('findTables: several tables, skipping code blocks, stopping at other blocks', () => {
        const lines = [
            '| a | b |', '| - | - |', '| 1 | 2 |', '',            // 0–2
            '```', '| x | y |', '| - | - |', '```',               // inside a code block: not a table
            'p | q', '--- | ---', 'r | s', '# Title', 'not a row', // 8–10; a heading stops the table
            '| m |', '| - |', '> quote',                          // 13–14; a quote stops the table
        ];
        eq(findTables(lines), [{ start: 0, end: 2 }, { start: 8, end: 10 }, { start: 13, end: 14 }]);
        eq(tableEnd(['| a |', '| - |', '| 1 |', 'no pipe'], 0), 2, 'a line without a pipe ends the table');
    });
    test('fitColumns: left alone if it fits, only wide columns are narrowed', () => {
        eq(fitColumns([100, 80], 300), [100, 80], 'fits');
        eq(fitColumns([400, 50, 50], 300), [200, 50, 50], 'wide columns narrowed, narrow ones left alone');
        eq(fitColumns([400, 400], 300), [150, 150], 'divided evenly');
        ok(fitColumns([1000, 1000, 1000], 90).every(w => w >= 56), 'not smaller than the minimum width');
    });
}
