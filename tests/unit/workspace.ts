// Workspace tests: the folder snapshot, change tracking, the contents cache, unsaved overlays, and warming.

import { writeTextFile } from '../../src/files.js';
import { WorkspaceRepository } from '../../src/workspace.js';
import { section, test, eq, ok, tmp, until, disk } from '../core/framework.js';

export async function workspaceTests(): Promise<void> {
    section('Workspace');
    let n = 0;
    // A fresh folder per test with the given files; the repository is closed afterwards.
    const withFolder = (files: Record<string, string>, fn: (root: string, at: (name: string) => string) => void | Promise<void>) => {
        const root = disk.join(tmp, `workspace-${++n}`);
        const at = (name: string) => disk.join(root, ...name.split('/'));
        for (const [name, text] of Object.entries(files)) {
            disk.mkdirs(disk.dirname(at(name)));
            disk.write(at(name), text);
        }
        return fn(root, at);
    };

    await test('lists Markdown files alphabetically, skipping dot files, tool folders, and other files', () => {
        withFolder({ 'b.md': 'B', 'a/z.md': 'Z', 'a/10.md': '10', 'a/9.md': '9', '.hidden.md': '', 'node_modules/x.md': '', 'c.txt': '' }, root => {
            const w = new WorkspaceRepository();
            eq(w.names(root), ['a/9.md', 'a/10.md', 'a/z.md', 'b.md']);
            eq(w.files(`${root}/`, { except: disk.join(root, 'b.md') }).map(f => f.text), ['9', '10', 'Z'], 'trailing slash, except');
            eq(w.files(root, { keep: t => t !== 'Z', limit: 2 }).map(f => f.name), ['a/9.md', 'a/10.md'], 'keep before limit');
            w.close();
        });
    });

    await test('unsaved documents are read from their editor, also for keep', () => {
        withFolder({ 'a.md': 'disk', 'b.md': 'disk' }, (root, at) => {
            const w = new WorkspaceRepository(() => new Map([[at('a.md'), 'editor'], [at('b.md'), '']]));
            eq(w.files(root, { keep: t => t !== '' }), [{ name: 'a.md', text: 'editor' }]);
            w.close();
        });
    });

    await test('the app\'s own writes are visible at once, without walking or waiting for a monitor', () => {
        withFolder({ 'a.md': 'one' }, (root, at) => {
            const w = new WorkspaceRepository();
            eq(w.files(root).map(f => f.text), ['one']);
            writeTextFile(at('a.md'), 'two');
            writeTextFile(at('new.md'), 'new');
            eq(w.files(root).map(f => f.text), ['two', 'new']);
            w.close();
        });
    });

    await test('outside changes arrive through the folder monitors; until then the snapshot is reused', async () => {
        await withFolder({ 'a.md': 'A', 'sub/b.md': 'B' }, async (root, at) => {
            const w = new WorkspaceRepository();
            eq(w.names(root), ['a.md', 'sub/b.md']);
            disk.write(at('sub/c.md'), 'C');   // not through files.ts
            eq(w.names(root), ['a.md', 'sub/b.md'], 'served from the snapshot');
            eq(w.files(root, { freshness: 'current' }).map(f => f.name), ['a.md', 'sub/b.md', 'sub/c.md'], 'current walks again');
            disk.remove(at('sub/c.md'));
            eq(w.names(root), ['a.md', 'sub/b.md', 'sub/c.md'], 'served from the snapshot again');
            disk.write(at('sub/c.md'), 'C');
            await until(() => w.names(root).includes('sub/c.md'));
            disk.remove(at('a.md'));
            await until(() => !w.names(root).includes('a.md'));
            eq(w.files(root, { freshness: 'fresh' }).map(f => f.text), ['B', 'C']);
            w.close();
        });
    });

    await test('the contents cache stays within its limit, least recently used out first', () => {
        withFolder({ 'a.md': 'a'.repeat(40), 'b.md': 'b'.repeat(40), 'c.md': 'c'.repeat(40) }, root => {
            const w = new WorkspaceRepository(undefined, 100);
            eq(w.files(root).map(f => f.text.length), [40, 40, 40], 'every file is still returned');
            ok(w.cacheSize <= 100, `cache holds ${w.cacheSize} units`);
            eq(w.cacheSize, 80, 'the two most recent files');
            w.close();
        });
    });

    await test('warm walks and reads in the background', async () => {
        await withFolder({ 'a.md': 'A', 'b/c.md': 'C' }, async root => {
            const w = new WorkspaceRepository();
            w.warm(root);
            ok(w.busy, 'nothing was scheduled');
            eq(w.cacheSize, 0, 'nothing read synchronously');
            await until(() => !w.busy);
            eq(w.cacheSize, 2, 'contents read');
            eq(w.files(root).map(f => f.text), ['A', 'C']);
            w.close();
            ok(!w.busy, 'closing stops background work');
        });
    });
}
