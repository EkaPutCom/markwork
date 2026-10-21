// The editor commands as text → edit (markdown/editcommands.ts): what every frontend's editor does on Ctrl+B, Enter in a
// list, Tab in a table, and the table menu. ‸ marks the cursor (the head of the selection) and · the other end of a
// selection, before and after the command.

import {
    applyChanges, block, continueBlock, enterInTable, heading, indentListItem, isInCodeBlock, link, mapPosition,
    lineKindOf, runTableCommand, setLineKind, tabInTable, togglePrefix, wrap, type TextEdit, type TextState,
} from '../../src/markdown/editcommands.js';
import { section, test, eq, ok } from '../core/framework.js';

const HEAD = '‸', ANCHOR = '·';

function state(marked: string): TextState {
    const head = marked.replace(ANCHOR, '').indexOf(HEAD);
    const anchorAt = marked.replace(HEAD, '').indexOf(ANCHOR);
    return { text: marked.replace(HEAD, '').replace(ANCHOR, ''), head, anchor: anchorAt < 0 ? head : anchorAt };
}

function marked(text: string, { anchor, head }: { anchor: number; head: number }): string {
    const marks = anchor === head ? [[head, HEAD]] : [[head, HEAD], [anchor, ANCHOR]];
    let out = text;
    for (const [at, mark] of marks.sort((a, b) => (b[0] as number) - (a[0] as number))) out = out.slice(0, at as number) + mark + out.slice(at as number);
    return out;
}

// The text after the command, with its selection marked; null when the command did not handle it.
function after(before: string, command: (s: TextState) => TextEdit | null): string | null {
    const s = state(before);
    const edit = command(s);
    return edit && marked(applyChanges(s.text, edit.changes), edit.selection);
}

export function editCommandTests(): void {
    section('Editor commands (text → edit)');

    test('applyChanges and mapPosition: a position in a replaced range or at an insertion moves past the new text', () => {
        const changes = [{ from: 1, to: 1, insert: 'XY' }, { from: 3, to: 5, insert: 'z' }];
        eq(applyChanges('abcdef', changes), 'aXYbczf');
        eq([0, 1, 2, 3, 4, 5, 6].map(p => mapPosition(p, changes)), [0, 3, 4, 6, 6, 6, 7]);
    });

    test('wrap: around a selection, removed again, and a pair at the cursor', () => {
        eq(after('a ·word‸ b', s => wrap(s, '**')), 'a ‸**word**· b');
        eq(after('a ‸**word**· b', s => wrap(s, '**')), 'a ‸word· b', 'the same marker again removes it');
        eq(after('a ‸ b', s => wrap(s, '`')), 'a `‸` b');
        eq(after('a ‸🎉· b', s => wrap(s, '*')), 'a ‸*🎉*· b', 'an emoji is two UTF-16 units');
    });

    test('link: selected text, a selected URL, and nothing selected', () => {
        eq(after('see ·docs‸', link), 'see [docs](‸)');
        eq(after('see ·https://x.org‸', link), 'see [‸](https://x.org)');
        eq(after('see ‸', link), 'see [‸]()');
    });

    test('block: a blank line first on a line with text', () => {
        eq(after('‸', s => block(s, '```\n', '\n```')), '```\n‸\n```');
        eq(after('text‸', s => block(s, '```\n', '\n```')), 'text\n\n```\n‸\n```');
    });

    test('togglePrefix: every selected line, numbered, and removed when all have it', () => {
        eq(after('·one\ntwo‸', s => togglePrefix(s, /^>\s?/, '> ')), '> ·one\n> two‸');
        eq(after('> ·one\n> two‸', s => togglePrefix(s, /^>\s?/, '> ')), '·one\ntwo‸');
        eq(after('a‸\nb·', s => togglePrefix(s, /^\d+[.)]\s+/, '1. ')), '1. a‸\n2. b·');
        eq(after('x\n- a‸\ny', s => togglePrefix(s, /^[-*+]\s+/, '- ')), 'x\na‸\ny', 'only the cursor line');
    });

    test('lineKindOf: headings, quotes, the three lists, and plain text', () => {
        eq(['## Two', '> said', '- item', '  3. third', '- [x] done', 'text', ''].map(l => lineKindOf(l).kind),
            ['h2', 'quote', 'bullet', 'numbered', 'task', 'paragraph', 'paragraph']);
        eq(lineKindOf('  - [ ] todo'), { kind: 'task', prefix: 8, indent: '  ' });
    });

    test('setLineKind: replaces the prefix a line has, and the same kind again makes a paragraph', () => {
        eq(after('- it‸em', s => setLineKind(s, 'numbered')), '1. it‸em', 'not "1. - item"');
        eq(after('## Ti‸tle', s => setLineKind(s, 'quote')), '> Ti‸tle');
        eq(after('wo‸rk', s => setLineKind(s, 'task')), '- [ ] wo‸rk');
        eq(after('- [x] wo‸rk', s => setLineKind(s, 'task')), 'wo‸rk');
        eq(after('  - it‸em', s => setLineKind(s, 'task')), '  - [ ] it‸em', 'a list item keeps its indent');
        eq(after('  - it‸em', s => setLineKind(s, 'h1')), '# it‸em');
        eq(after('‸', s => setLineKind(s, 'bullet')), '- ‸', 'an empty line, as the / menu leaves it');
        eq(after('·a\n- b\nc‸', s => setLineKind(s, 'numbered')), '1. ·a\n2. b\n3. c‸');
        eq(after('> a‸', s => setLineKind(s, 'paragraph')), 'a‸');
    });

    test('heading: set, change, and the same level back to a paragraph', () => {
        eq(after('Ti‸tle', s => heading(s, 2)), '## Ti‸tle');
        eq(after('## Ti‸tle', s => heading(s, 3)), '### Ti‸tle');
        eq(after('## Ti‸tle', s => heading(s, 2)), 'Ti‸tle');
        eq(after('‸Title', s => heading(s, 1)), '# ‸Title', 'a cursor at the line start moves past the marker');
        eq(after('Ti‸tle', s => heading(s, 0)), 'Ti‸tle');
        eq(after('- [ ] Ti‸tle', s => heading(s, 2)), '## Ti‸tle', 'a list item\'s prefix is replaced');
    });

    test('Enter continues a list, a numbered list, a task, and a quote', () => {
        eq(after('- one‸', continueBlock), '- one\n- ‸');
        eq(after('9. nine‸', continueBlock), '9. nine\n10. ‸');
        eq(after('- [x] done‸', continueBlock), '- [x] done\n- [ ] ‸');
        eq(after('> quoted‸', continueBlock), '> quoted\n> ‸');
        eq(after('> - in a quote‸', continueBlock), '> - in a quote\n> - ‸');
    });

    test('Enter on an empty item ends the list; on plain text it is not handled', () => {
        eq(after('- one\n- ‸', continueBlock), '- one\n‸');
        eq(after('> - ‸', continueBlock), '‸');
        eq(after('> a\n> ‸', continueBlock), '> a\n‸');
        eq(after('plain‸', continueBlock), null);
    });

    test('Tab and Shift+Tab indent a list item by 4 spaces; not a list line = not handled', () => {
        eq(after('- it‸em', s => indentListItem(s, false)), '    - it‸em');
        eq(after('    - it‸em', s => indentListItem(s, true)), '- it‸em');
        eq(after('- it‸em', s => indentListItem(s, true)), '- it‸em', 'nothing to outdent, still handled');
        eq(after('pla‸in', s => indentListItem(s, false)), null);
    });

    test('isInCodeBlock: inside and after a fence', () => {
        const lines = ['a', '```', '- x', '```', '- y'];
        eq([2, 4].map(n => isInCodeBlock(lines, n)), [true, false]);
    });

    const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |';

    test('Tab moves to the next cell, wraps to the next row, and adds a row after the last cell', () => {
        eq(after('| a‸ | b |\n| --- | --- |\n| 1 | 2 |', s => tabInTable(s, false)), '| a | ‸b |\n| --- | --- |\n| 1 | 2 |');
        eq(after('| a | b‸ |\n| --- | --- |\n| 1 | 2 |', s => tabInTable(s, false)), '| a | b |\n| --- | --- |\n| ‸1 | 2 |');
        eq(after('| a | b |\n| --- | --- |\n| 1 | 2‸ |', s => tabInTable(s, false)), `${TABLE}\n| ‸ |  |`);
        eq(after('| a | b |\n| --- | --- |\n| ‸1 | 2 |', s => tabInTable(s, true)), '| a | ‸b |\n| --- | --- |\n| 1 | 2 |', 'Shift+Tab back a row');
        eq(after('| ‸a | b |\n| --- | --- |\n| 1 | 2 |', s => tabInTable(s, true)), '| ‸a | b |\n| --- | --- |\n| 1 | 2 |', 'the first cell stays');
        eq(after('not a ‸table', s => tabInTable(s, false)), null);
    });

    test('Enter moves down a row; on an empty last row it leaves the table', () => {
        eq(after('| a | ‸b |\n| --- | --- |\n| 1 | 2 |', enterInTable), '| a | b |\n| --- | --- |\n| 1 | ‸2 |');
        eq(after(`${TABLE}\n|  | ‸ |`, enterInTable), `${TABLE}\n‸`);
        eq(after(`${TABLE}\n|  | ‸ |\n\nafter`, enterInTable), `${TABLE}\n‸\nafter`, 'an existing blank line is reused');
    });

    test('table commands: rows, columns, alignment, and what cannot be done', () => {
        const run = (before: string, command: Parameters<typeof runTableCommand>[1]) => after(before, s => {
            const result = runTableCommand(s, command);
            return result.ok ? result.edit : null;
        });
        eq(run('| a | b |\n| --- | --- |\n| ‸1 | 2 |', 'row-below'), '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| ‸    |     |');
        eq(run('| a | b |\n| --- | --- |\n| 1 | ‸2 |', 'delete-col'), '| a   |\n| --- |\n| ‸1   |');
        eq(run('| ‸a | b |\n| --- | --- |\n| 1 | 2 |', 'align-right'), '|   ‸a | b   |\n| --: | --- |\n|   1 | 2   |');
        const failure = (before: string, command: Parameters<typeof runTableCommand>[1]) => {
            const result = runTableCommand(state(before), command);
            return result.ok ? 'ok' : result.reason;
        };
        eq(failure('| ‸a |\n| --- |\n| 1 |', 'delete-row'), 'delete-header');
        eq(failure('| ‸a |\n| --- |\n| 1 |', 'row-above'), 'row-above-header');
        eq(failure('| a |\n| --- |\n| ‸1 |', 'delete-col'), 'delete-last-column');
        eq(failure('no ‸table', 'format'), 'not-in-table');
        ok(failure('| a |\n| --- |\n| ‸1 |', 'format') === 'ok', 'format runs anywhere in a table');
    });
}
