// Tests for throwing away uncommitted changes (git.ts discardChanges) against a real repository.

import { discardChanges, repoChanges, runGit } from '../../src/base/git.js';
import { section, test, eq, ok, contains, within, tmp, disk } from '../core/framework.js';

export async function discardTests(): Promise<void> {
    section('Discarding uncommitted changes');
    const repo = disk.join(tmp, 'discard');
    disk.mkdirs(repo);
    const sh = async (...args: string[]) => {
        const run = await within(runGit(repo, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args]));
        if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
        return run.out.trim();
    };
    const at = (name: string) => disk.join(repo, name);
    const write = (name: string, text: string) => disk.write(at(name), text);
    const read = (name: string) => disk.read(at(name));
    const exists = (name: string) => disk.exists(at(name));
    const discard = async (names: string[]) => within(discardChanges(names.map(at)));
    await sh('init', '-q', '-b', 'main');
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) write(name, `# ${name}\n`);
    await sh('add', '-A');
    await sh('commit', '-q', '-m', 'First');
    const status = () => sh('status', '--porcelain=v1', '--untracked-files=all');

    await test('a modified file goes back to the last commit, in the working tree and in the index', async () => {
        write('a.md', '# a.md\nedited\n');
        write('b.md', '# b.md\nstaged edit\n');
        await sh('add', 'b.md');
        write('b.md', '# b.md\nstaged edit\nand more\n');
        eq((await discard(['a.md', 'b.md'])).ok, true);
        eq([read('a.md'), read('b.md')], ['# a.md\n', '# b.md\n']);
        eq(await status(), '');
    });
    await test('a deleted file comes back', async () => {
        disk.remove(at('c.md'));
        eq((await discard(['c.md'])).ok, true);
        eq(read('c.md'), '# c.md\n');
    });
    await test('a new file, staged or not, is taken out and moved to the Trash', async () => {
        write('new-untracked.md', 'x\n');
        write('new-staged.md', 'y\n');
        await sh('add', 'new-staged.md');
        eq((await discard(['new-untracked.md', 'new-staged.md'])).ok, true);
        ok(!exists('new-untracked.md') && !exists('new-staged.md'), 'a new file is still there');
        eq(await status(), '');
    });
    await test('only the files that were named are touched', async () => {
        write('a.md', 'edited a\n');
        write('d.md', 'edited d\n');
        eq((await discard(['a.md'])).ok, true);
        eq([read('a.md'), read('d.md')], ['# a.md\n', 'edited d\n']);
        eq((await discard(['d.md'])).ok, true);
    });
    await test('a renamed file is refused and left alone', async () => {
        await sh('mv', 'd.md', 'renamed.md');
        const result = await discard(['renamed.md']);
        ok(!result.ok, 'the rename was discarded');
        if (!result.ok) contains(result.message, 'renamed');
        ok(exists('renamed.md') && !exists('d.md'), 'the files were touched');
        await sh('mv', 'renamed.md', 'd.md');
    });
    await test('a clean file is not an error, and nothing selected is', async () => {
        eq((await discard(['a.md'])).ok, true);
        eq((await within(discardChanges([]))).ok, false);
    });
    await test('the repository list is empty again after everything is discarded', async () => {
        const changes = await within(repoChanges(repo));
        ok(changes.ok && changes.changes.length === 0, JSON.stringify(changes));
    });
}
