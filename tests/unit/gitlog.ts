// Tests for the git output parser.

import { parseDiff, parseLog, parseStatus, relativeTime } from '../../src/base/gitlog';
import { section, test, eq } from '../core/framework';

const record = (hash: string, short: string, author: string, time: number, subject: string, ...files: string[]) =>
    `\x1e${hash}\x1f${short}\x1f${author}\x1f${time}\x1f${subject}\n\n${files.join('\n')}\n`;

export function gitLogTests(): void {
    section('Git history (parser)');
    test('the log is read into commits with their file paths', () => {
        const out = record('a'.repeat(40), 'aaaaaaa', 'Eka Putra', 1700000000, 'Edit notes', 'notes/a.md')
            + record('b'.repeat(40), 'bbbbbbb', 'Eka', 1690000000, 'Create notes', 'a.md');
        eq(parseLog(out), [
            { hash: 'a'.repeat(40), short: 'aaaaaaa', author: 'Eka Putra', time: 1700000000, subject: 'Edit notes', path: 'notes/a.md' },
            { hash: 'b'.repeat(40), short: 'bbbbbbb', author: 'Eka', time: 1690000000, subject: 'Create notes', path: 'a.md' },
        ]);
    });
    test('empty output yields no commits', () => {
        eq(parseLog(''), []);
        eq(parseLog('\n'), []);
    });
    test('paths quoted by git are not used raw', () => {
        eq(parseLog(record('c'.repeat(40), 'ccccccc', 'E', 1, 'x', '"a\\tb.md"'))[0].path, null);
    });
    test('a commit message may contain a colon and a tab', () => {
        eq(parseLog(record('d'.repeat(40), 'ddddddd', 'E', 1, 'Fix: a\tb', 'a.md'))[0].subject, 'Fix: a\tb');
    });
    test('status is read into a list of changed files, a rename uses the new path', () => {
        eq(parseStatus(' M a.md\nA  b.md\n?? c d.md\nR  old.md -> new.md\n D x.md\n?? "t\\"k.md"\n'), [
            { path: 'a.md', kind: 'modified' }, { path: 'b.md', kind: 'added' }, { path: 'c d.md', kind: 'untracked' },
            { path: 'new.md', kind: 'renamed' }, { path: 'x.md', kind: 'deleted' }, { path: 't"k.md', kind: 'untracked' },
        ]);
        eq(parseStatus(''), []);
    });
    test('relative time', () => {
        const now = 1_000_000_000;
        eq(relativeTime(now - 10, now), 'just now');
        eq(relativeTime(now - 5 * 60, now), '5 min ago');
        eq(relativeTime(now - 3 * 3600, now), '3 hr ago');
        eq(relativeTime(now - 2 * 86400, now), '2 d ago');
        eq(relativeTime(now - 15 * 86400, now), '2 wk ago');
        eq(relativeTime(now - 90 * 86400, now), '3 mo ago');
        eq(relativeTime(now - 800 * 86400, now), '2 yr ago');
        eq(relativeTime(now + 500, now), 'just now', 'the computer clock is behind the commit');
    });
    test('diff: the header is dropped, lines get a kind', () => {
        const diff = 'diff --git a/a.md b/a.md\nindex 1..2 100644\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n # Title\n-old\n+new\n\\ No newline at end of file\n';
        eq(parseDiff(diff), [
            { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
            { kind: 'context', text: ' # Title' },
            { kind: 'del', text: '-old' },
            { kind: 'add', text: '+new' },
            { kind: 'context', text: '\\ No newline at end of file' },
        ]);
    });
    test('a diff without hunks (rename only) is empty', () => {
        eq(parseDiff('diff --git a/a.md b/b.md\nsimilarity index 100%\nrename from a.md\nrename to b.md\n'), []);
        eq(parseDiff(''), []);
    });
}
