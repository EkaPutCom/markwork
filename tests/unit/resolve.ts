// Tests for resolving a pull request's conflicts locally: real git against a local bare "forge" repository.

import GLib from 'gi://GLib';
import { finishLocalMerge, abortLocalMerge, confirmMerged, conflictedFiles, hasMarkers, preflight, startLocalMerge, unresolved, type LocalMerge } from '../../src/forge/resolve.js';
import { ForgeError, type ForgeProvider } from '../../src/forge/types.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, contains, settle, tmp } from '../framework.js';

const sh = (cwd: string, ...args: string[]): string => {
    const run = settle(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

export function resolveTests(): void {
    section('Resolving pull request conflicts locally');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) GLib.setenv(name, value, true);
    const dir = GLib.build_filenamev([tmp, 'resolve']);
    let counter = 0;
    const write = (path: string, text: string) => GLib.file_set_contents(path, text);
    const read = (path: string) => new TextDecoder().decode(GLib.file_get_contents(path)[1]);

    // A fresh scenario: a bare "forge", a maintainer's clone on main, and pull request #7 that edits the same line as a later
    // commit on main (so it conflicts) or a different file (so it does not).
    const scenario = (conflict: boolean) => {
        const root = GLib.build_filenamev([dir, `case-${++counter}`]);
        const bare = GLib.build_filenamev([root, 'forge.git']), work = GLib.build_filenamev([root, 'work']), other = GLib.build_filenamev([root, 'author']);
        GLib.mkdir_with_parents(bare, 0o755);
        sh(bare, 'init', '-q', '--bare', '-b', 'main');
        sh(root, 'clone', '-q', bare, work);
        sh(work, 'checkout', '-q', '-B', 'main');
        write(`${work}/journal.md`, '# Journal\n\nhello\n');
        write(`${work}/other.md`, '# Other\n');
        sh(work, 'add', '-A');
        sh(work, 'commit', '-q', '-m', 'First');
        sh(work, 'push', '-q', '-u', 'origin', 'main');
        // The author's branch becomes pull request #7 (a forge keeps it under refs/pull/7/head).
        sh(root, 'clone', '-q', bare, other);
        sh(other, 'checkout', '-q', '-b', 'feature');
        write(`${other}/${conflict ? 'journal.md' : 'other.md'}`, conflict ? '# Journal\n\nhello from the pull request\n' : '# Other\n\nadded by the pull request\n');
        sh(other, 'commit', '-q', '-a', '-m', 'The pull request');
        sh(other, 'push', '-q', 'origin', 'feature');
        sh(bare, 'update-ref', 'refs/pull/7/head', sh(other, 'rev-parse', 'HEAD'));
        // Meanwhile main moved on.
        write(`${work}/journal.md`, '# Journal\n\nhello from main\n');
        sh(work, 'commit', '-q', '-a', '-m', 'Main moved on');
        sh(work, 'push', '-q', 'origin', 'main');
        const merge: LocalMerge = { folder: work, base: 'main', cloneUrl: bare, pull: 7, title: 'Greeting', login: 'eka', token: 'sekret' };
        return { bare, work, merge };
    };

    test('conflict markers are told from a Markdown heading underline', () => {
        ok(hasMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> FETCH_HEAD\n'), 'markers');
        ok(!hasMarkers('Title\n=======\n\ntext\n'), 'a setext heading is not a conflict');
        ok(!hasMarkers('a << b >> c\n<<<<<<<<x'), 'not at the start of a line with a space after');
    });

    test('the folder must be on the base branch, clean, and not in the middle of a merge', () => {
        const { work } = scenario(true);
        eq(settle(preflight(runGit, work, 'main')), null);
        contains(String(settle(preflight(runGit, work, 'develop'))), 'Switch this folder to the branch develop');
        write(`${work}/journal.md`, 'dirty\n');
        contains(String(settle(preflight(runGit, work, 'main'))), 'not committed');
        sh(work, 'checkout', '-q', '--', 'journal.md');
        write(`${work}/untracked.md`, 'not tracked\n');
        eq(settle(preflight(runGit, work, 'main')), null);   // a file git does not know cannot be lost by a merge
    });

    test('a conflicting pull request is merged as far as it goes and the conflicting files are listed', () => {
        const { work, merge } = scenario(true);
        const start = settle(startLocalMerge(runGit, merge));
        ok(start.ok, `started: ${!start.ok && start.message}`);
        if (!start.ok) return;
        eq(start.conflicts, [`${work}/journal.md`]);
        contains(read(`${work}/journal.md`), '<<<<<<<');
        eq(settle(conflictedFiles(runGit, work)), [`${work}/journal.md`]);
        eq(unresolved(start.conflicts, read), [`${work}/journal.md`]);
        eq(sh(work, 'rev-parse', 'HEAD'), start.before);
    });

    test('finishing commits the resolution as a merge and pushes the base branch', () => {
        const { bare, work, merge } = scenario(true);
        const start = settle(startLocalMerge(runGit, merge));
        if (!start.ok) throw new Error(start.message);
        write(`${work}/journal.md`, '# Journal\n\nhello from main and the pull request\n');
        eq(unresolved(start.conflicts, read), []);
        const done = settle(finishLocalMerge(runGit, merge, start.conflicts));
        ok(done.ok, `finished: ${!done.ok && done.message}`);
        eq(sh(bare, 'rev-parse', 'main'), sh(work, 'rev-parse', 'HEAD'));
        eq(sh(bare, 'log', '-1', '--format=%P').split(' ').length, 2);          // a merge commit
        contains(sh(bare, 'log', '-1', '--format=%s'), 'Merge pull request #7: Greeting');
        eq(sh(bare, 'merge-base', '--is-ancestor', sh(bare, 'rev-parse', 'refs/pull/7/head'), 'main') === '', true);
    });

    test('finishing while git still sees conflicts is refused and nothing is pushed', () => {
        const { bare, merge } = scenario(true);
        const before = sh(bare, 'rev-parse', 'main');
        const start = settle(startLocalMerge(runGit, merge));
        if (!start.ok) throw new Error(start.message);
        const done = settle(finishLocalMerge(runGit, merge, []));     // the files were never staged as resolved
        ok(!done.ok, 'refused');
        eq(sh(bare, 'rev-parse', 'main'), before);
    });

    test('aborting returns the folder to what it was', () => {
        const { work, merge } = scenario(true);
        const start = settle(startLocalMerge(runGit, merge));
        if (!start.ok) throw new Error(start.message);
        ok(settle(abortLocalMerge(runGit, work, start.before)).ok, 'aborted');
        eq(read(`${work}/journal.md`), '# Journal\n\nhello from main\n');
        eq(sh(work, 'status', '--porcelain'), '');
    });

    test('a pull request that merges cleanly is committed at once; finishing only pushes, aborting undoes it', () => {
        const { bare, work, merge } = scenario(false);
        const start = settle(startLocalMerge(runGit, merge));
        ok(start.ok && start.conflicts.length === 0, 'no conflicts');
        if (!start.ok) return;
        ok(sh(work, 'rev-parse', 'HEAD') !== start.before, 'the merge commit exists');
        ok(settle(abortLocalMerge(runGit, work, start.before)).ok, 'undone');
        eq(sh(work, 'rev-parse', 'HEAD'), start.before);
        const again = settle(startLocalMerge(runGit, merge));
        if (!again.ok) throw new Error(again.message);
        ok(settle(finishLocalMerge(runGit, merge, [])).ok, 'pushed');
        eq(sh(bare, 'rev-parse', 'main'), sh(work, 'rev-parse', 'HEAD'));
    });

    test('a local base that has diverged from the server stops before the pull request is touched', () => {
        const { work, merge } = scenario(true);
        write(`${work}/local.md`, 'only here\n');
        sh(work, 'add', 'local.md');
        sh(work, 'commit', '-q', '-m', 'Local only');
        const bareMoves = GLib.build_filenamev([dir, 'mover']);
        sh(dir, 'clone', '-q', merge.cloneUrl, bareMoves);
        write(`${bareMoves}/server.md`, 'only on the server\n');
        sh(bareMoves, 'add', 'server.md');
        sh(bareMoves, 'commit', '-q', '-m', 'Server only');
        sh(bareMoves, 'push', '-q', 'origin', 'main');
        const start = settle(startLocalMerge(runGit, merge));
        ok(!start.ok && start.message.includes('bring them together'), 'refused with a reason');
        eq(sh(work, 'status', '--porcelain'), '');
    });

    test('a forge without the pull request ref says so', () => {
        const { merge } = scenario(true);
        const start = settle(startLocalMerge(runGit, { ...merge, pull: 99 }));
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
    test('a pull request the server already shows as merged is left alone', () => {
        const f = forge(['merged'], async () => {});
        ok(settle(confirmMerged(f.provider, 7, 'abc')).ok, 'ok');
        eq(f.marks(), 0);
    });
    test('an open pull request is recorded as merged with the pushed commit', () => {
        const f = forge(['open'], async () => {});
        ok(settle(confirmMerged(f.provider, 7, 'abc')).ok, 'ok');
        eq(f.marks(), 1);
    });
    test('a repository that does not allow manual merges is explained, not hidden', () => {
        const f = forge(['open'], async () => { throw new ForgeError('not-mergeable', 'not allowed', 405); });
        const result = settle(confirmMerged(f.provider, 7, 'abc'));
        ok(!result.ok && result.message.includes('Manually merged') && result.message.includes('still shows it as open'), 'explained');
    });
    test('a server that notices the merge by itself while it is being recorded counts as merged', () => {
        const f = forge(['open', 'merged'], async () => { throw new ForgeError('not-mergeable', 'already merged', 405); });
        ok(settle(confirmMerged(f.provider, 7, 'abc')).ok, 'ok');
    });
    test('any other failure is passed on as it is', () => {
        const f = forge(['open'], async () => { throw new ForgeError('network', 'Cannot reach git.example.org'); });
        const result = settle(confirmMerged(f.provider, 7, 'abc'));
        ok(!result.ok && result.message === 'Cannot reach git.example.org', 'passed on');
    });

    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) GLib.unsetenv(name);
}
