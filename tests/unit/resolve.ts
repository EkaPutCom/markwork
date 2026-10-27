// Tests for resolving a pull request's conflicts locally: real git against a local bare "forge" repository.

import { finishLocalMerge, abortLocalMerge, confirmMerged, conflictedFiles, hasMarkers, pendingMerge, preflight, startLocalMerge, unresolved, type LocalMerge } from '../../src/forge/resolve';
import { ForgeError, type ForgeProvider } from '../../src/forge/types';
import { repoChanges, runGit } from '../../src/base/git';
import { platform } from '../../src/platform/index';
import { section, test, eq, ok, contains, within, tmp, disk } from '../core/framework';
import { host } from '../core/host';

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const run = await within(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

export async function resolveTests(): Promise<void> {
    section('Resolving pull request conflicts locally');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) host().setenv(name, value);
    const dir = disk.join(tmp, 'resolve');
    let counter = 0;
    const write = (path: string, text: string) => disk.write(path, text);
    const read = (path: string) => disk.read(path);

    // A fresh scenario: a bare "forge", a maintainer's clone on main, and pull request #7 that edits the same line as a later
    // commit on main (so it conflicts) or a different file (so it does not).
    const scenario = async (conflict: boolean) => {
        const root = disk.join(dir, `case-${++counter}`);
        const bare = disk.join(root, 'forge.git'), work = disk.join(root, 'work'), other = disk.join(root, 'author');
        disk.mkdirs(bare);
        await sh(bare, 'init', '-q', '--bare', '-b', 'main');
        await sh(root, 'clone', '-q', bare, work);
        await sh(work, 'checkout', '-q', '-B', 'main');
        write(`${work}/journal.md`, '# Journal\n\nhello\n');
        write(`${work}/other.md`, '# Other\n');
        await sh(work, 'add', '-A');
        await sh(work, 'commit', '-q', '-m', 'First');
        await sh(work, 'push', '-q', '-u', 'origin', 'main');
        // The author's branch becomes pull request #7 (a forge keeps it under refs/pull/7/head).
        await sh(root, 'clone', '-q', bare, other);
        await sh(other, 'checkout', '-q', '-b', 'feature');
        write(`${other}/${conflict ? 'journal.md' : 'other.md'}`, conflict ? '# Journal\n\nhello from the pull request\n' : '# Other\n\nadded by the pull request\n');
        await sh(other, 'commit', '-q', '-a', '-m', 'The pull request');
        await sh(other, 'push', '-q', 'origin', 'feature');
        await sh(bare, 'update-ref', 'refs/pull/7/head', await sh(other, 'rev-parse', 'HEAD'));
        // Meanwhile main moved on.
        write(`${work}/journal.md`, '# Journal\n\nhello from main\n');
        await sh(work, 'commit', '-q', '-a', '-m', 'Main moved on');
        await sh(work, 'push', '-q', 'origin', 'main');
        const merge: LocalMerge = { folder: work, base: 'main', cloneUrl: bare, pull: 7, title: 'Greeting', login: 'eka', token: 'sekret' };
        return { bare, work, merge };
    };

    await test('conflict markers are told from a Markdown heading underline', async () => {
        ok(hasMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> FETCH_HEAD\n'), 'markers');
        ok(!hasMarkers('Title\n=======\n\ntext\n'), 'a setext heading is not a conflict');
        ok(!hasMarkers('a << b >> c\n<<<<<<<<x'), 'not at the start of a line with a space after');
    });

    await test('the folder must be on the base branch, clean, and not in the middle of a merge', async () => {
        const { work } = await scenario(true);
        eq(await within(preflight(runGit, work, 'main')), null);
        contains(String(await within(preflight(runGit, work, 'develop'))), 'Switch this folder to the branch develop');
        write(`${work}/journal.md`, 'dirty\n');
        contains(String(await within(preflight(runGit, work, 'main'))), 'not committed');
        await sh(work, 'checkout', '-q', '--', 'journal.md');
        write(`${work}/untracked.md`, 'not tracked\n');
        eq(await within(preflight(runGit, work, 'main')), null);   // a file git does not know cannot be lost by a merge
    });

    await test('a merge left in the folder (the app was closed) is found again with its pull request and files', async () => {
        const { work, merge } = await scenario(true);
        eq(await within(pendingMerge(runGit, work)), null);
        const start = await within(startLocalMerge(runGit, merge));
        ok(start.ok, 'started');
        const found = await within(pendingMerge(runGit, work));
        ok(found !== null, 'the merge in progress was not found');
        if (!found || !start.ok) return;
        eq(found.pull, 7);
        eq(found.before, start.before);
        eq(found.conflicts, [disk.join(work, 'journal.md')]);
        await sh(work, 'merge', '--abort');
        eq(await within(pendingMerge(runGit, work)), null);
    });

    await test('a merge that was started by hand is found, without a pull request', async () => {
        const { work } = await scenario(true);
        await sh(work, 'checkout', '-q', '-b', 'side', 'HEAD~1');
        write(`${work}/journal.md`, 'side\n');
        await sh(work, 'commit', '-q', '-a', '-m', 'Side');
        await sh(work, 'checkout', '-q', 'main');
        const merged = await within(runGit(work, ['merge', '--no-ff', 'side']));
        ok(merged?.status !== 0, 'the merge should conflict');
        const found = await within(pendingMerge(runGit, work));
        ok(found !== null && found.pull === null, JSON.stringify(found));
        await sh(work, 'merge', '--abort');
    });

    await test('a conflicting pull request is merged as far as it goes and the conflicting files are listed', async () => {
        const { work, merge } = await scenario(true);
        const start = await within(startLocalMerge(runGit, merge));
        ok(start.ok, `started: ${!start.ok && start.message}`);
        if (!start.ok) return;
        eq(start.conflicts, [disk.join(work, 'journal.md')]);
        contains(read(`${work}/journal.md`), '<<<<<<<');
        eq(await within(conflictedFiles(runGit, work)), [disk.join(work, 'journal.md')]);
        eq(unresolved(start.conflicts, read), [disk.join(work, 'journal.md')]);
        eq(await sh(work, 'rev-parse', 'HEAD'), start.before);
    });

    await test('finishing commits the resolution as a merge and pushes the base branch', async () => {
        const { bare, work, merge } = await scenario(true);
        const start = await within(startLocalMerge(runGit, merge));
        if (!start.ok) throw new Error(start.message);
        write(`${work}/journal.md`, '# Journal\n\nhello from main and the pull request\n');
        eq(unresolved(start.conflicts, read), []);
        const done = await within(finishLocalMerge(runGit, merge, start.conflicts));
        ok(done.ok, `finished: ${!done.ok && done.message}`);
        eq(await sh(bare, 'rev-parse', 'main'), await sh(work, 'rev-parse', 'HEAD'));
        eq((await sh(bare, 'log', '-1', '--format=%P')).split(' ').length, 2);          // a merge commit
        contains(await sh(bare, 'log', '-1', '--format=%s'), 'Merge pull request #7: Greeting');
        eq(await sh(bare, 'merge-base', '--is-ancestor', await sh(bare, 'rev-parse', 'refs/pull/7/head'), 'main') === '', true);
    });

    await test('finishing while git still sees conflicts is refused and nothing is pushed', async () => {
        const { bare, merge } = await scenario(true);
        const before = await sh(bare, 'rev-parse', 'main');
        const start = await within(startLocalMerge(runGit, merge));
        if (!start.ok) throw new Error(start.message);
        const done = await within(finishLocalMerge(runGit, merge, []));     // the files were never staged as resolved
        ok(!done.ok, 'refused');
        eq(await sh(bare, 'rev-parse', 'main'), before);
    });

    await test('aborting returns the folder to what it was', async () => {
        const { work, merge } = await scenario(true);
        const start = await within(startLocalMerge(runGit, merge));
        if (!start.ok) throw new Error(start.message);
        ok((await within(abortLocalMerge(runGit, work, start.before))).ok, 'aborted');
        eq(read(`${work}/journal.md`), '# Journal\n\nhello from main\n');
        eq(await sh(work, 'status', '--porcelain'), '');
    });

    await test('a pull request that merges cleanly is committed at once; finishing only pushes, aborting undoes it', async () => {
        const { bare, work, merge } = await scenario(false);
        const start = await within(startLocalMerge(runGit, merge));
        ok(start.ok && start.conflicts.length === 0, 'no conflicts');
        if (!start.ok) return;
        ok(await sh(work, 'rev-parse', 'HEAD') !== start.before, 'the merge commit exists');
        ok((await within(abortLocalMerge(runGit, work, start.before))).ok, 'undone');
        eq(await sh(work, 'rev-parse', 'HEAD'), start.before);
        const again = await within(startLocalMerge(runGit, merge));
        if (!again.ok) throw new Error(again.message);
        ok((await within(finishLocalMerge(runGit, merge, []))).ok, 'pushed');
        eq(await sh(bare, 'rev-parse', 'main'), await sh(work, 'rev-parse', 'HEAD'));
    });

    await test('a local base that has diverged from the server stops before the pull request is touched', async () => {
        const { work, merge } = await scenario(true);
        write(`${work}/local.md`, 'only here\n');
        await sh(work, 'add', 'local.md');
        await sh(work, 'commit', '-q', '-m', 'Local only');
        const bareMoves = disk.join(dir, 'mover');
        await sh(dir, 'clone', '-q', merge.cloneUrl, bareMoves);
        write(`${bareMoves}/server.md`, 'only on the server\n');
        await sh(bareMoves, 'add', 'server.md');
        await sh(bareMoves, 'commit', '-q', '-m', 'Server only');
        await sh(bareMoves, 'push', '-q', 'origin', 'main');
        const start = await within(startLocalMerge(runGit, merge));
        ok(!start.ok && start.message.includes('bring them together'), 'refused with a reason');
        eq(await sh(work, 'status', '--porcelain'), '');
    });

    await test('a forge without the pull request ref says so', async () => {
        const { merge } = await scenario(true);
        const start = await within(startLocalMerge(runGit, { ...merge, pull: 99 }));
        ok(!start.ok && start.message.includes('Could not fetch the pull request'), 'refused');
    });

    // The pull request has to be recorded as merged after the push; what the server answers decides what the user is told.
    const forge = (states: Array<'open' | 'merged'>, mark: () => Promise<void>) => {
        let reads = 0, marks = 0;
        const provider = {
            async getPull() { return { state: states[Math.min(reads++, states.length - 1)] }; },
            async markMerged() { marks++; await mark(); },
        } as unknown as ForgeProvider;
        return { provider, marks: () => marks };
    };
    await test('a pull request the server already shows as merged is left alone', async () => {
        const f = forge(['merged'], async () => {});
        ok((await within(confirmMerged(f.provider, 7, 'abc'))).ok, 'ok');
        eq(f.marks(), 0);
    });
    await test('an open pull request is recorded as merged with the pushed commit', async () => {
        const f = forge(['open'], async () => {});
        ok((await within(confirmMerged(f.provider, 7, 'abc'))).ok, 'ok');
        eq(f.marks(), 1);
    });
    await test('a repository that does not allow manual merges is explained, not hidden', async () => {
        const f = forge(['open'], async () => { throw new ForgeError('not-mergeable', 'not allowed', 405); });
        const result = await within(confirmMerged(f.provider, 7, 'abc'));
        ok(!result.ok && result.message.includes('Manually merged') && result.message.includes('still shows it as open'), 'explained');
    });
    await test('a server that notices the merge by itself while it is being recorded counts as merged', async () => {
        const f = forge(['open', 'merged'], async () => { throw new ForgeError('not-mergeable', 'already merged', 405); });
        ok((await within(confirmMerged(f.provider, 7, 'abc'))).ok, 'ok');
    });
    await test('any other failure is passed on as it is', async () => {
        const f = forge(['open'], async () => { throw new ForgeError('network', 'Cannot reach git.example.org'); });
        const result = await within(confirmMerged(f.provider, 7, 'abc'));
        ok(!result.ok && result.message === 'Cannot reach git.example.org', 'passed on');
    });

    await test('a repository opened through a symbolic link keeps that spelling in its changes', async () => {
        if (platform().os === 'win32') return;   // a folder link needs rights a Windows runner may not have
        const real = disk.join(dir, 'linked-real'), link = disk.join(dir, 'linked');
        disk.mkdirs(disk.join(real, 'sub'));
        await sh(real, 'init', '-q', '-b', 'main');
        write(disk.join(real, 'a.md'), 'a\n');
        await sh(real, 'add', '-A');
        await sh(real, 'commit', '-q', '-m', 'First');
        host().symlink(real, link);
        write(disk.join(real, 'sub', 'b.md'), 'b\n');
        const changes = await within(repoChanges(disk.join(link, 'sub')));
        ok(changes.ok, 'read');
        eq(changes.ok && changes.changes.map(c => c.path), [disk.join(link, 'sub', 'b.md')]);
    });

    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) host().setenv(name, null);
}
