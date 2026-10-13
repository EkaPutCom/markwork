// Tests for throwing away uncommitted changes (git.ts discardChanges) against a real repository.

import GLib from 'gi://GLib';
import { discardChanges, repoChanges } from '../../src/git.js';
import { discardPrompt } from '../../src/ui/discard.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, contains, settle, tmp } from '../framework.js';

export function discardTests(): void {
    section('Discarding uncommitted changes');
    const repo = GLib.build_filenamev([tmp, 'discard']);
    GLib.mkdir_with_parents(repo, 0o755);
    const sh = (...args: string[]) => {
        const run = settle(runGit(repo, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args]));
        if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
        return run.out.trim();
    };
    const at = (name: string) => GLib.build_filenamev([repo, name]);
    const write = (name: string, text: string) => GLib.file_set_contents(at(name), text);
    const read = (name: string) => new TextDecoder().decode(GLib.file_get_contents(at(name))[1]);
    const exists = (name: string) => GLib.file_test(at(name), GLib.FileTest.EXISTS);
    sh('init', '-q', '-b', 'main');
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) write(name, `# ${name}\n`);
    sh('add', '-A');
    sh('commit', '-q', '-m', 'First');
    const status = () => sh('status', '--porcelain=v1', '--untracked-files=all');

    test('a modified file goes back to the last commit, in the working tree and in the index', () => {
        write('a.md', '# a.md\nedited\n');
        write('b.md', '# b.md\nstaged edit\n');
        sh('add', 'b.md');
        write('b.md', '# b.md\nstaged edit\nand more\n');
        eq(settle(discardChanges([at('a.md'), at('b.md')])).ok, true);
        eq([read('a.md'), read('b.md')], ['# a.md\n', '# b.md\n']);
        eq(status(), '');
    });
    test('a deleted file comes back', () => {
        GLib.unlink(at('c.md'));
        eq(settle(discardChanges([at('c.md')])).ok, true);
        eq(read('c.md'), '# c.md\n');
    });
    test('a new file, staged or not, is taken out and moved to the Trash', () => {
        write('new-untracked.md', 'x\n');
        write('new-staged.md', 'y\n');
        sh('add', 'new-staged.md');
        eq(settle(discardChanges([at('new-untracked.md'), at('new-staged.md')])).ok, true);
        ok(!exists('new-untracked.md') && !exists('new-staged.md'), 'a new file is still there');
        eq(status(), '');
    });
    test('only the files that were named are touched', () => {
        write('a.md', 'edited a\n');
        write('d.md', 'edited d\n');
        eq(settle(discardChanges([at('a.md')])).ok, true);
        eq([read('a.md'), read('d.md')], ['# a.md\n', 'edited d\n']);
        eq(settle(discardChanges([at('d.md')])).ok, true);
    });
    test('a renamed file is refused and left alone', () => {
        sh('mv', 'd.md', 'renamed.md');
        const result = settle(discardChanges([at('renamed.md')]));
        ok(!result.ok, 'the rename was discarded');
        if (!result.ok) contains(result.message, 'renamed');
        ok(exists('renamed.md') && !exists('d.md'), 'the files were touched');
        sh('mv', 'renamed.md', 'd.md');
    });
    test('a clean file is not an error, and nothing selected is', () => {
        eq(settle(discardChanges([at('a.md')])).ok, true);
        eq(settle(discardChanges([])).ok, false);
    });
    test('the repository list is empty again after everything is discarded', () => {
        const changes = settle(repoChanges(repo));
        ok(changes.ok && changes.changes.length === 0, JSON.stringify(changes));
    });
    test('the question names the file and says what happens to it', () => {
        contains(discardPrompt('modified', '/x/notes.md').heading, 'notes.md');
        contains(discardPrompt('modified', '/x/notes.md').detail, 'cannot be undone');
        contains(discardPrompt('untracked', '/x/notes.md').detail, 'Trash');
        eq(discardPrompt('deleted', '/x/notes.md').accept, 'Restore');
    });
}
