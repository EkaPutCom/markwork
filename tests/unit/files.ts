// Background write tests: ordering per path, coalescing, and an explicit flush.

import { fileUri, flushWrites, insideName, readTextFile, writeTextFile, writeTextFileAsync } from '../../src/files.js';
import { below, atOrBelow } from '../../src/markdown/pathbelow.js';
import { section, test, eq, ok, tmp, until, disk } from '../framework.js';

export async function fileWriteTests(): Promise<void> {
    section('Background writes');
    const base = disk.join(tmp, 'writes');
    disk.mkdirs(base);
    const at = (name: string) => disk.join(base, name);

    await test('fileUri encodes each part, and a Windows drive path gets file:///C:/', () => {
        eq(fileUri('/home/eka/my notes/a#b.md'), 'file:///home/eka/my%20notes/a%23b.md');
        eq(fileUri('C:\\Users\\eka\\my notes\\a.md'), 'file:///C:/Users/eka/my%20notes/a.md');
        eq(fileUri('d:/x/y.md'), 'file:///d:/x/y.md');
    });

    await test('insideName gives the / name below a folder, and null for the folder itself or elsewhere', () => {
        eq(insideName('/home/eka/notes', '/home/eka/notes/a/b.md'), 'a/b.md');
        eq(insideName('/home/eka/notes/', '/home/eka/notes/b.md'), 'b.md', 'a trailing slash');
        eq(insideName('/home/eka/notes', '/home/eka/notes'), null, 'the folder itself');
        eq(insideName('/home/eka/notes', '/home/eka/notes-other/b.md'), null, 'the same name prefix is not inside');
        eq(insideName('/home/eka/notes', '/home/eka/b.md'), null, 'outside');
    });

    await test('below: a path under a folder, with / everywhere and \\ under a Windows folder', () => {
        eq([below('/a/b', '/a/b/c'), below('/a/b', '/a/b'), below('/a/b', '/a/bc/d'), below('/a/b', '/a/b/')], [true, false, false, false]);
        eq([below('C:\\a', 'C:\\a\\b'), below('C:\\a', 'C:\\a/b'), below('/a', '/a\\b'), atOrBelow('/a', '/a')], [true, true, false, true]);
    });

    await test('overlapping background writes to one file end with the newest text', async () => {
        const path = at('burst.md');
        const calls: string[] = [];
        for (let i = 1; i <= 20; i++) writeTextFileAsync(path, `v${i}`, e => calls.push(e ? `error ${i}` : `${i}`));
        eq(calls, [], 'done is never called during writeTextFileAsync');
        await until(() => calls.length === 20);
        eq(readTextFile(path), 'v20', 'file contents');
        eq(calls, Array.from({ length: 20 }, (_, i) => `${i + 1}`), 'callbacks in request order');
    });

    await test('flushWrites finishes waiting writes without running other main-loop callbacks', async () => {
        const path = at('flush.md');
        let idleRan = false, doneCount = 0;
        setTimeout(() => { idleRan = true; }, 0);
        writeTextFileAsync(path, 'old', () => doneCount++);
        writeTextFileAsync(path, 'new', () => doneCount++);
        flushWrites(base);   // a folder flushes the files inside it
        ok(!idleRan, 'flushWrites ran an unrelated callback');
        eq(doneCount, 0, 'done callbacks wait for the main loop');
        eq(readTextFile(path), 'new', 'file contents after the flush');
        await until(() => idleRan && doneCount === 2);
    });

    await test('a synchronous write after background writes is the one that stays', async () => {
        const path = at('sync.md');
        let done = 0;
        writeTextFileAsync(path, 'background 1', () => done++);
        writeTextFileAsync(path, 'background 2', () => done++);
        writeTextFile(path, 'saved');
        await until(() => done === 2);
        eq(readTextFile(path), 'saved', 'file contents');
    });

    await test('a failed background write reports its error to every waiting caller', async () => {
        const path = at('missing/dir/file.md');
        const errors: unknown[] = [];
        writeTextFileAsync(path, 'a', e => errors.push(e));
        writeTextFileAsync(path, 'b', e => errors.push(e));
        await until(() => errors.length === 2);
        ok(errors.every(e => e), 'an error was not reported');
    });
}
