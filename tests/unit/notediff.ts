// Tests for the pull request diff helpers: cutting a unified diff per file, and the note-aware diff of two versions.

import { fileDiff, isBinaryDiff } from '../../src/forge/diff';
import { countChanges, diffNote, MAX_DIFF_LINES } from '../../src/markdown/notediff';
import { section, test, eq, ok } from '../core/framework';

const DIFF = `diff --git a/agenda/rapat.md b/agenda/rapat.md
index 111..222 100644
--- a/agenda/rapat.md
+++ b/agenda/rapat.md
@@ -1,3 +1,3 @@
-tanggal
+tanggal baru
diff --git a/img/a.png b/img/a.png
new file mode 100644
Binary files /dev/null and b/img/a.png differ
diff --git a/old name.md b/new name.md
similarity index 90%
rename from old name.md
rename to new name.md
`;

export function noteDiffTests(): void {
    section('Pull request diff helpers');
    test('fileDiff cuts the part of one file out of the whole diff', () => {
        const part = fileDiff(DIFF, 'agenda/rapat.md');
        ok(part.startsWith('diff --git a/agenda/rapat.md'), 'starts with its own header');
        ok(part.includes('+tanggal baru') && !part.includes('img/a.png'), 'only its own lines');
        eq(fileDiff(DIFF, 'nothing.md'), '');
    });
    test('a renamed file is found by its new name, a binary file is recognized', () => {
        ok(fileDiff(DIFF, 'new name.md').includes('rename from old name.md'), 'rename part');
        ok(isBinaryDiff(fileDiff(DIFF, 'img/a.png')), 'binary');
        ok(!isBinaryDiff(fileDiff(DIFF, 'agenda/rapat.md')), 'text');
    });

    const before = '---\ntitle: Rapat\ndate: 2026-10-12\nlayout: list\n---\n# Rapat\n\nBahas rilis.\nBawa laptop.\n';
    const after = '---\ntitle: Rapat\ndate: 2026-10-14\nlayout: calendar\nowner: budi\n---\n# Rapat\n\nBahas kolaborasi.\nBawa laptop.\n';
    test('the frontmatter fields that changed, were added, or were removed', () => {
        eq(diffNote(before, after).fields, [
            { key: 'date', before: '2026-10-12', after: '2026-10-14' },
            { key: 'layout', before: 'list', after: 'calendar' },
            { key: 'owner', before: null, after: 'budi' },
        ]);
        eq(diffNote('---\na: 1\nb: 2\n---\n', '---\na: 1\n---\n').fields, [{ key: 'b', before: '2', after: null }]);
    });
    test('the text is diffed line by line with the unchanged lines kept in place', () => {
        const { body } = diffNote(before, after);
        eq(body.map(l => `${l.kind}:${l.text}`), ['same:# Rapat', 'same:', 'del:Bahas rilis.', 'add:Bahas kolaborasi.', 'same:Bawa laptop.']);
        eq(countChanges(diffNote(before, after)), { added: 1, removed: 1 });
    });
    test('a new note is all added, a deleted note all removed', () => {
        const added = diffNote(null, '# Baru\n\nIsi\n');
        eq(added.body.map(l => l.kind), ['add', 'add', 'add']);
        eq(diffNote('# Lama\n', null).body.map(l => l.kind), ['del']);
        eq(diffNote('# Sama\n', '# Sama\n'), { fields: [], body: [{ kind: 'same', text: '# Sama' }] });
    });
    test('a note without frontmatter, and a frontmatter that never closes, are all text', () => {
        eq(diffNote('a\n', 'b\n').fields, []);
        eq(diffNote('---\nno end\ntext\n', '---\nno end\ntext!\n').fields, []);
    });
    test('lines moved in the middle are matched, not shown as one big change', () => {
        const { body } = diffNote('1\n2\n3\n4\n5\n', '1\n2\nX\n4\n5\n');
        eq(body.map(l => `${l.kind}:${l.text}`), ['same:1', 'same:2', 'del:3', 'add:X', 'same:4', 'same:5']);
    });
    test('a diff of two huge texts is not computed line by line', () => {
        const big = (tag: string) => Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `${tag}${i}`).join('\n');
        const { body } = diffNote(big('a'), big('b'));
        eq(body.filter(l => l.kind === 'same').length, 0);
        eq(body.length, 2 * (MAX_DIFF_LINES + 5));
    });
}
