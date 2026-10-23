// Tests for the diff laid out side by side and inline, with the changed words.

import { parseDiff } from '../../src/base/gitlog.js';
import { inline, sideBySide, wordDiff } from '../../src/markdown/diffview.js';
import { section, test, eq } from '../core/framework.js';

const DIFF = [
    '@@ -3,4 +3,4 @@ # Title',
    ' same',
    '-Open it in Nyerat now.',
    '-gone',
    '+Open it in Markwork now.',
    ' tail',
    '+added',
    '\\ No newline at end of file',
].join('\n');

export function diffViewTests(): void {
    section('Diff view');
    test('only the words that differ are marked', () => {
        eq(wordDiff('Open it in Nyerat now.', 'Open it in Markwork now.'), [
            [{ text: 'Open it in ', changed: false }, { text: 'Nyerat', changed: true }, { text: ' now.', changed: false }],
            [{ text: 'Open it in ', changed: false }, { text: 'Markwork', changed: true }, { text: ' now.', changed: false }],
        ]);
    });
    test('side by side pairs a removed line with the line that replaced it and fills the side that has none', () => {
        const rows = sideBySide(parseDiff(DIFF));
        eq(rows[0], { kind: 'hunk', text: '@@ -3,4 +3,4 @@' });   // the section git names after it reads like a line of the file
        const nums = rows.slice(1).map(r => r.kind === 'line' ? [r.left?.kind ?? null, r.left?.number ?? null, r.right?.kind ?? null, r.right?.number ?? null] : null);
        eq(nums, [
            ['context', 3, 'context', 3],
            ['del', 4, 'add', 4],
            ['del', 5, null, null],
            ['context', 6, 'context', 5],
            [null, null, 'add', 6],
        ]);
        const pair = rows[2];
        eq(pair.kind === 'line' && pair.right?.spans.filter(s => s.changed).map(s => s.text), ['Markwork']);
    });
    test('inline keeps both line numbers, removed lines before added ones', () => {
        const rows = inline(parseDiff(DIFF)).slice(1).map(r => r.kind === 'hunk' ? r.text : [r.kind, r.old, r.new]);
        eq(rows, [['context', 3, 3], ['del', 4, null], ['del', 5, null], ['add', null, 4], ['context', 6, 5], ['add', null, 6]]);
    });
    test('lines under a caption have no numbers', () => {
        const rows = inline([{ kind: 'hunk', text: 'Fields' }, { kind: 'add', text: '+tags: a' }]);
        eq(rows, [{ kind: 'hunk', text: 'Fields' }, { kind: 'add', old: null, new: null, spans: [{ text: 'tags: a', changed: false }] }]);
    });
}
