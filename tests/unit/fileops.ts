// File operation tests: create files/folders and move.

import { copyEntry, createFile, createFolder, moveEntry, renameEntry } from '../../src/fileops.js';
import { remapPath } from '../../src/app/documents.js';
import { section, test, eq, ok, tmp, disk } from '../core/framework.js';

const throws = (fn: () => unknown, part: string): void => {
    try { fn(); } catch (e) { ok((e as Error).message.includes(part), `message "${(e as Error).message}" does not contain "${part}"`); return; }
    throw new Error('should have thrown an error');
};

export function fileOpsTests(): void {
    section('File operations');
    const base = disk.join(tmp, 'ops');
    const at = (...parts: string[]) => disk.join(base, ...parts);
    const exists = (path: string) => disk.exists(path);
    disk.mkdirs(base);

    test('createFile appends .md if it is not a Markdown extension', () => {
        eq(createFile(base, 'notes'), at('notes.md'), 'path');
        eq(createFile(base, ' idea.markdown '), at('idea.markdown'), 'markdown extension is kept');
        ok(exists(at('notes.md')), 'file was not created');
    });
    test('createFile can append another extension, and keeps one that fits', () => {
        eq(createFile(base, 'sales', 'a,b\n', '.csv', /\.csv$/i), at('sales.csv'), 'appended');
        eq(createFile(base, 'q3.CSV', 'a,b\n', '.csv', /\.csv$/i), at('q3.CSV'), 'kept');
        eq(disk.read(at('sales.csv')), 'a,b\n', 'content');
    });
    test('renameEntry keeps a CSV or HTML extension instead of adding .md', () => {
        eq(renameEntry(at('sales.csv'), 'sales-q3.csv'), at('sales-q3.csv'));
        eq(createFile(base, 'page.html', '<p>x</p>', '.html', /\.html?$/i), at('page.html'));
        eq(renameEntry(at('page.html'), 'home.htm'), at('home.htm'));
    });
    test('createFile rejects empty names, names with slashes or dots, and existing ones', () => {
        throws(() => createFile(base, '  '), 'empty');
        throws(() => createFile(base, 'a/b'), '/');
        throws(() => createFile(base, '.secret'), 'dot');
        throws(() => createFile(base, 'notes.md'), 'already exists');
    });
    test('createFolder creates a folder and rejects duplicates', () => {
        eq(createFolder(base, 'chapter'), at('chapter'), 'path');
        ok(disk.isDirectory(at('chapter')), 'not a folder');
        throws(() => createFolder(base, 'chapter'), 'already exists');
    });
    test('moveEntry moves a file into a folder and back out', () => {
        eq(moveEntry(at('notes.md'), at('chapter')), at('chapter', 'notes.md'), 'into');
        ok(!exists(at('notes.md')) && exists(at('chapter', 'notes.md')), 'the file did not move');
        eq(moveEntry(at('chapter', 'notes.md'), base), at('notes.md'), 'out');
    });
    test('moveEntry moves a folder with contents into another folder', () => {
        createFolder(base, 'target');
        createFile(at('chapter'), 'content');
        eq(moveEntry(at('chapter'), at('target')), at('target', 'chapter'), 'path');
        ok(exists(at('target', 'chapter', 'content.md')), 'the folder contents moved along');
    });
    test('moveEntry: no change, into itself, and name clash', () => {
        eq(moveEntry(at('notes.md'), base), null, 'same folder');
        throws(() => moveEntry(at('target'), at('target', 'chapter')), 'itself');
        throws(() => moveEntry(at('target'), at('target')), 'itself');
        createFile(at('target'), 'notes');
        throws(() => moveEntry(at('notes.md'), at('target')), 'already exists');
        ok(exists(at('notes.md')), 'the source must not disappear');
    });
    test('renameEntry renames files (keeping .md) and folders, rejects clashes', () => {
        createFile(base, 'r1'); createFile(base, 'r2'); createFolder(base, 'rd');
        eq(renameEntry(at('r1.md'), 'r3'), at('r3.md'), 'file');
        eq(renameEntry(at('rd'), 'rd2'), at('rd2'), 'folder without an extension');
        eq(renameEntry(at('r3.md'), 'r3.md'), null, 'same name');
        throws(() => renameEntry(at('r3.md'), 'r2'), 'already exists');
        throws(() => renameEntry(at('r3.md'), 'a/b'), '/');
    });
    test('copyEntry copies files and folders, numbering a name clash, and refuses into itself', () => {
        createFolder(base, 'cp'); createFile(at('cp'), 'inside');
        disk.write(at('pic.png'), 'x');
        eq(copyEntry(at('pic.png'), at('cp')), at('cp', 'pic.png'), 'file');
        eq(copyEntry(at('pic.png'), at('cp')), at('cp', 'pic (2).png'), 'clash');
        ok(exists(at('pic.png')), 'the source stays');
        eq(copyEntry(at('cp'), at('target')), at('target', 'cp'), 'folder');
        ok(exists(at('target', 'cp', 'inside.md')) && exists(at('target', 'cp', 'pic (2).png')), 'folder contents');
        throws(() => copyEntry(at('cp'), at('cp')), 'itself');
    });
    test('remapPath follows moves of files and folders', () => {
        eq(remapPath('/a/b.md', '/a/b.md', '/c/b.md'), '/c/b.md', 'file');
        eq(remapPath('/a/d/x.md', '/a/d', '/c/d'), '/c/d/x.md', 'folder contents');
        eq(remapPath('/a/dd/x.md', '/a/d', '/c/d'), null, 'a name prefix alone is not a parent');
    });
}
