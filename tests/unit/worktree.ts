// Tests for a worktree per kanban card: real git in temporary repositories (no network).

import GLib from 'gi://GLib';
import { createWorktree, DEFAULT_ISOLATION, findWorktree, listWorktrees, parseIsolation, removeWorktree, repoInfo, slugFor, worktreeRoot, writeIsolation, type Isolation } from '../../src/agent/worktree.js';
import { buildPrompt, RunQueue } from '../../src/agent/harness.js';
import { commentsReply, mergeWorktree, newLineNumbers, readReview, splitDiff } from '../../src/agent/worktreereview.js';
import { parseDiff } from '../../src/gitlog.js';
import { cardBranch, setCardBranch } from '../../src/markdown/kanban.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, contains, settle, tmp } from '../framework.js';

const sh = (cwd: string, ...args: string[]): string => {
    const run = settle(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

export function worktreeTests(): void {
    section('A worktree per card');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) GLib.setenv(name, value, true);
    const dir = GLib.build_filenamev([tmp, 'worktrees']);
    let counter = 0;
    const exists = (path: string) => GLib.file_test(path, GLib.FileTest.EXISTS);

    // A project repository on main with one commit, in a folder of its own so its worktrees land next to it.
    const project = () => {
        const root = GLib.build_filenamev([dir, `case-${++counter}`]);
        const repo = GLib.build_filenamev([root, 'shop']);
        GLib.mkdir_with_parents(`${repo}/web`, 0o755);
        sh(repo, 'init', '-q', '-b', 'main');
        GLib.file_set_contents(`${repo}/web/cart.ts`, 'export const cart = [];\n');
        sh(repo, 'add', '-A');
        sh(repo, 'commit', '-q', '-m', 'First');
        return { root, repo };
    };
    const iso = (patch: Partial<Isolation> = {}): Isolation => ({ ...DEFAULT_ISOLATION, ...patch });

    test('slugs and paths', () => {
        eq(slugFor('Checkout with QRIS!'), 'checkout-with-qris');
        eq(slugFor('Café über naïve'), 'cafe-uber-naive', 'accents are dropped');
        eq(slugFor('???'), 'card', 'nothing left → a fallback');
        ok(slugFor('a'.repeat(100)).length <= 40, 'short');
        eq(worktreeRoot('/home/eka/shop'), '/home/eka/.markwork-worktrees/shop', 'next to the project');
        eq(worktreeRoot('/home/eka/shop/', '/srv/wt/'), '/srv/wt', 'a folder chosen in the settings');
    });

    test('the isolation of a project is read with defaults', () => {
        eq(parseIsolation(undefined), DEFAULT_ISOLATION);
        eq(parseIsolation('not json'), DEFAULT_ISOLATION);
        eq(parseIsolation('{"worktrees":false,"slots":50,"base":" dev ","dir":"relative","afterMerge":"keep-branch"}'),
            { worktrees: false, slots: 8, base: 'dev', dir: '', afterMerge: 'keep-branch' }, 'clamped, trimmed, a relative folder ignored');
        eq(parseIsolation(writeIsolation(iso({ slots: 3, dir: '/srv/wt' }))), iso({ slots: 3, dir: '/srv/wt' }), 'round trip');
    });

    test('the card notes its branch', () => {
        const text = setCardBranch('Checkout with QRIS [agent:: pi] #feature', 'markwork/checkout-with-qris');
        eq(text, 'Checkout with QRIS [agent:: pi] #feature [branch:: markwork/checkout-with-qris]');
        eq(cardBranch(text), 'markwork/checkout-with-qris');
        eq(cardBranch('No branch [agent:: pi]'), null);
        eq(setCardBranch(text, null), 'Checkout with QRIS [agent:: pi] #feature');
    });

    test('a worktree is made next to the project on a branch of its own', () => {
        const { root, repo } = project();
        const made = settle(createWorktree(runGit, { folder: `${repo}/web`, title: 'Checkout with QRIS', isolation: iso() }));
        if (!made.ok) throw new Error(made.message);
        const wt = made.value;
        eq(wt.path, `${root}/.markwork-worktrees/shop/checkout-with-qris`);
        eq(wt.cwd, `${wt.path}/web`, 'the harness runs where the project folder is inside the repository');
        eq([wt.branch, wt.base, wt.repo], ['markwork/checkout-with-qris', 'main', repo]);
        eq(wt.baseCommit, sh(repo, 'rev-parse', 'main'));
        ok(exists(`${wt.cwd}/cart.ts`), 'checked out');
        eq(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the project folder stays on its branch');
        eq(sh(repo, 'config', 'branch.markwork/checkout-with-qris.markworkBase'), 'main', 'the base is remembered');

        const again = settle(createWorktree(runGit, { folder: repo, title: 'Checkout with QRIS', isolation: iso() }));
        ok(again.ok && again.value.branch === 'markwork/checkout-with-qris-2', 'a taken name gets a number');
        eq(settle(listWorktrees(runGit, repo)).map(w => w.branch), ['main', 'markwork/checkout-with-qris', 'markwork/checkout-with-qris-2']);
    });

    test('a worktree is found again from its branch, and removed', () => {
        const { repo } = project();
        const made = settle(createWorktree(runGit, { folder: repo, title: 'Fix', isolation: iso() }));
        if (!made.ok) throw new Error(made.message);
        GLib.file_set_contents(`${repo}/web/cart.ts`, 'export const cart = [1];\n');
        sh(repo, 'commit', '-q', '-a', '-m', 'Main moved on');
        const found = settle(findWorktree(runGit, repo, 'markwork/fix'));
        if (!found.ok) throw new Error(found.message);
        eq({ ...found.value }, { ...made.value }, 'the same worktree, with the commit it started from');
        eq(settle(findWorktree(runGit, repo, 'markwork/none')).ok, false);

        eq(settle(removeWorktree(runGit, made.value, true)).ok, true);
        ok(!exists(made.value.path), 'the folder is gone');
        ok(sh(repo, 'branch', '--list', 'markwork/fix').length > 0, 'the branch is kept when asked');
        const again = settle(createWorktree(runGit, { folder: repo, title: 'Other', isolation: iso() }));
        if (!again.ok) throw new Error(again.message);
        eq(settle(removeWorktree(runGit, again.value)).ok, true);
        eq(sh(repo, 'branch', '--list', 'markwork/other'), '', 'and deleted otherwise');
    });

    test('what cannot get a worktree says why', () => {
        const plain = GLib.build_filenamev([dir, `plain-${++counter}`]);
        GLib.mkdir_with_parents(plain, 0o755);
        const none = settle(repoInfo(runGit, plain));
        ok(!none.ok && none.notRepo === true, 'not a repository → work in the folder');
        const empty = GLib.build_filenamev([dir, `empty-${++counter}`]);
        GLib.mkdir_with_parents(empty, 0o755);
        sh(empty, 'init', '-q', '-b', 'main');
        const fresh = settle(createWorktree(runGit, { folder: empty, title: 'x', isolation: iso() }));
        ok(!fresh.ok && !fresh.notRepo && /no commit/.test(fresh.message), `no commit yet: ${!fresh.ok && fresh.message}`);
        const { repo } = project();
        const missing = settle(createWorktree(runGit, { folder: repo, title: 'x', isolation: iso({ base: 'develop' }) }));
        ok(!missing.ok && /develop does not exist/.test(missing.message), 'an unknown base branch');
        sh(repo, 'checkout', '-q', '--detach');
        const detached = settle(createWorktree(runGit, { folder: repo, title: 'x', isolation: iso() }));
        ok(!detached.ok && /detached/.test(detached.message), 'a detached HEAD needs a base branch');
        ok(settle(createWorktree(runGit, { folder: repo, title: 'x', isolation: iso({ base: 'main' }) })).ok, 'which is then used');
    });

    test('the prompt tells the harness about its branch', () => {
        const card = { text: 'Checkout [agent:: pi]', done: false, notes: [] };
        const wt = { path: '/w/checkout', cwd: '/w/checkout', branch: 'markwork/checkout', base: 'main', baseCommit: 'abc', repo: '/r' };
        const prompt = buildPrompt(card, 'shop', 'board.md', [], wt);
        contains(prompt, 'on the branch markwork/checkout (from main)');
        contains(prompt, 'do not switch branches');
        ok(!prompt.includes('Do not make commits'), 'commits on its own branch are fine');
    });

    // A worktree where the "harness" committed one change, left another uncommitted, made a new file, and deleted one.
    const worked = () => {
        const p = project();
        GLib.file_set_contents(`${p.repo}/web/old.ts`, 'old\n');
        sh(p.repo, 'add', '-A');
        sh(p.repo, 'commit', '-q', '-m', 'Old file');
        const made = settle(createWorktree(runGit, { folder: `${p.repo}/web`, title: 'Checkout', isolation: iso() }));
        if (!made.ok) throw new Error(made.message);
        const wt = made.value;
        GLib.file_set_contents(`${wt.cwd}/cart.ts`, 'export const cart = [];\nexport const total = 0;\n');
        sh(wt.path, 'commit', '-q', '-a', '-m', 'Add a total');
        GLib.file_set_contents(`${wt.cwd}/qris.ts`, 'export const qris = 1;\n');
        GLib.unlink(`${wt.cwd}/old.ts`);
        return { ...p, wt };
    };

    test('the review shows committed, uncommitted, new, and deleted changes against the start', () => {
        const { repo, wt } = worked();
        const read = settle(readReview(runGit, wt));
        if (!read.ok) throw new Error(read.message);
        const r = read.value;
        eq(r.files.map(f => [f.path, f.status, f.additions, f.deletions]), [['web/cart.ts', 'modified', 1, 0], ['web/old.ts', 'deleted', 0, 1], ['web/qris.ts', 'added', 1, 0]]);
        eq(r.commits.map(c => c.subject), ['Add a total']);
        eq([r.uncommitted, r.behind, r.conflicts], [true, 0, []]);
        eq(sh(repo, 'status', '--porcelain'), '', 'the project folder is untouched');
        const lines = parseDiff(r.files[0].part);
        eq(newLineNumbers(lines), [null, 1, 2], 'line numbers in the new file');
    });

    test('splitDiff: renames and binary files', () => {
        const files = splitDiff('diff --git a/a.md b/b.md\nsimilarity index 90%\nrename from a.md\nrename to b.md\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n');
        eq(files.map(f => [f.path, f.oldPath, f.status, f.binary]), [['b.md', 'a.md', 'renamed', false], ['i.png', null, 'modified', true]]);
    });

    test('merging takes everything into the base and removes the worktree', () => {
        const { repo, wt } = worked();
        const merged = settle(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'Checkout with QRIS', keepBranch: false }));
        if (!merged.ok) throw new Error(merged.message);
        eq(sh(repo, 'log', '-1', '--format=%s'), 'Checkout with QRIS');
        eq(sh(repo, 'log', '-1', '--format=%p').split(' ').length, 2, 'a merge commit');
        ok(exists(`${repo}/web/qris.ts`) && !exists(`${repo}/web/old.ts`), 'the uncommitted work came along');
        ok(!exists(wt.path), 'the worktree is gone');
        eq(sh(repo, 'branch', '--list', wt.branch), '', 'and its branch');
    });

    test('squashing makes one commit; taking some files leaves the others out', () => {
        const a = worked();
        const squashed = settle(mergeWorktree(runGit, a.wt, { method: 'squash', files: null, message: 'Squashed', keepBranch: true }));
        if (!squashed.ok) throw new Error(squashed.message);
        eq(sh(a.repo, 'log', '-1', '--format=%p').split(' ').length, 1, 'one parent');
        ok(sh(a.repo, 'branch', '--list', a.wt.branch).length > 0, 'the branch was kept');

        const b = worked();
        const review = settle(readReview(runGit, b.wt));
        if (!review.ok) throw new Error(review.message);
        const some = review.value.files.filter(f => f.path !== 'web/cart.ts');
        const taken = settle(mergeWorktree(runGit, b.wt, { method: 'merge', files: some, message: 'Two of three', keepBranch: false }));
        if (!taken.ok) throw new Error(taken.message);
        ok(exists(`${b.repo}/web/qris.ts`) && !exists(`${b.repo}/web/old.ts`), 'the chosen ones');
        eq(GLib.file_get_contents(`${b.repo}/web/cart.ts`)[1].length, 'export const cart = [];\n'.length, 'the one left out is as it was');
    });

    test('a merge that would conflict is found before, and refused without leaving a mess', () => {
        const { repo, wt } = worked();
        GLib.file_set_contents(`${repo}/web/cart.ts`, 'export const cart = [9];\n');
        sh(repo, 'commit', '-q', '-a', '-m', 'Main moved on');
        const review = settle(readReview(runGit, wt));
        if (!review.ok) throw new Error(review.message);
        eq([review.value.behind, review.value.conflicts], [1, ['web/cart.ts']]);
        const merged = settle(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'x', keepBranch: false }));
        ok(!merged.ok && /conflicts.*cart\.ts/.test(merged.message), `refused: ${!merged.ok && merged.message}`);
        eq(sh(repo, 'status', '--porcelain'), '', 'the project folder is clean again');
        ok(exists(wt.path), 'the worktree is still there');
        const some = review.value.files.filter(f => f.path === 'web/cart.ts');
        const taken = settle(mergeWorktree(runGit, wt, { method: 'merge', files: some, message: 'x', keepBranch: false }));
        ok(!taken.ok && /changed on main too/.test(taken.message), 'taking a file that main changed too is refused');
    });

    test('the project folder must be on the base branch and clean', () => {
        const { repo, wt } = worked();
        GLib.file_set_contents(`${repo}/web/cart.ts`, 'dirty\n');
        const dirty = settle(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'x', keepBranch: false }));
        ok(!dirty.ok && /not committed/.test(dirty.message), 'uncommitted changes');
        sh(repo, 'checkout', '-q', '--', '.');
        sh(repo, 'checkout', '-q', '-b', 'other');
        const elsewhere = settle(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'x', keepBranch: false }));
        ok(!elsewhere.ok && /switch the project folder to main/.test(elsewhere.message), 'another branch');
    });

    test('comments on the diff become the reply', () => {
        eq(commentsReply([]), '');
        eq(commentsReply([{ path: 'web/cart.ts', line: 2, quote: '+export const total = 0;', text: 'Use the order total.' }]),
            'Please address these review comments on your changes:\n\n- web/cart.ts:2 (`+export const total = 0;`): Use the order total.\n');
    });

    test('RunQueue: cards with worktrees share their lane up to its slots', () => {
        const q = new RunQueue();
        const base = { board: '/p.md', title: 't', agent: 'pi', project: 'shop', prompt: '', session: null, lane: '/shop', slots: 2 };
        const a = q.add({ ...base, card: 'A', folder: '/wt/a' });
        const b = q.add({ ...base, card: 'B', folder: '/wt/b' });
        const c = q.add({ ...base, card: 'C', folder: '/wt/c' });
        const plain = q.add({ board: '/p.md', title: 't', agent: 'pi', project: 'shop', prompt: '', session: null, card: 'P', folder: '/shop' });
        eq([a.status, b.status, c.status, plain.status], ['working', 'working', 'queued', 'queued'], 'the plain run in the project folder waits in the same lane');
        eq(q.end(a, 'done'), [c], 'a freed slot goes to the first in line');
        eq(q.end(b, 'done'), [], 'the plain run needs the lane to itself');
        eq(q.end(c, 'done'), [plain]);
        eq(q.add({ ...base, card: 'D', folder: '/wt/d' }).status, 'working', 'each run counts its own slots: a worktree card may run beside it');
        eq(q.add({ ...base, card: 'E', folder: '/wt/e' }).status, 'queued', 'up to its limit');
    });
}
