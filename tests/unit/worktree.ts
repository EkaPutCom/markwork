// Tests for a worktree per kanban card: real git in temporary repositories (no network).

import { createWorktree, DEFAULT_ISOLATION, findWorktree, listWorktrees, parseIsolation, removeWorktree, repoInfo, slugFor, worktreeRoot, writeIsolation, type Isolation } from '../../src/agent/worktree.js';
import { buildPrompt, RunQueue } from '../../src/agent/harness.js';
import { commentsReply, mergeWorktree, newLineNumbers, readReview, splitDiff } from '../../src/agent/worktreereview.js';
import { parseDiff } from '../../src/gitlog.js';
import { cardBranch, setCardBranch } from '../../src/markdown/kanban.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, contains, within, tmp, disk, slash } from '../framework.js';
import { host } from '../host.js';

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const run = await within(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

export async function worktreeTests(): Promise<void> {
    section('A worktree per card');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) host().setenv(name, value);
    const dir = disk.join(tmp, 'worktrees');
    let counter = 0;
    const exists = (path: string) => disk.exists(path);

    // A project repository on main with one commit, in a folder of its own so its worktrees land next to it.
    const project = async () => {
        const root = disk.join(dir, `case-${++counter}`);
        const repo = disk.join(root, 'shop');
        disk.mkdirs(`${repo}/web`);
        await sh(repo, 'init', '-q', '-b', 'main');
        disk.write(`${repo}/web/cart.ts`, 'export const cart = [];\n');
        await sh(repo, 'add', '-A');
        await sh(repo, 'commit', '-q', '-m', 'First');
        return { root, repo };
    };
    const iso = (patch: Partial<Isolation> = {}): Isolation => ({ ...DEFAULT_ISOLATION, ...patch });

    await test('slugs and paths', async () => {
        eq(slugFor('Checkout with QRIS!'), 'checkout-with-qris');
        eq(slugFor('Café über naïve'), 'cafe-uber-naive', 'accents are dropped');
        eq(slugFor('???'), 'card', 'nothing left → a fallback');
        ok(slugFor('a'.repeat(100)).length <= 40, 'short');
        eq(worktreeRoot('/home/eka/shop'), '/home/eka/.markwork-worktrees/shop', 'next to the project');
        eq(worktreeRoot('/home/eka/shop/', '/srv/wt/'), '/srv/wt', 'a folder chosen in the settings');
    });

    await test('the isolation of a project is read with defaults', async () => {
        eq(parseIsolation(undefined), DEFAULT_ISOLATION);
        eq(parseIsolation('not json'), DEFAULT_ISOLATION);
        eq(parseIsolation('{"worktrees":false,"slots":50,"base":" dev ","dir":"relative","afterMerge":"keep-branch"}'),
            { worktrees: false, slots: 8, base: 'dev', dir: '', afterMerge: 'keep-branch' }, 'clamped, trimmed, a relative folder ignored');
        eq(parseIsolation(writeIsolation(iso({ slots: 3, dir: '/srv/wt' }))), iso({ slots: 3, dir: '/srv/wt' }), 'round trip');
    });

    await test('the card notes its branch', async () => {
        const text = setCardBranch('Checkout with QRIS [agent:: pi] #feature', 'markwork/checkout-with-qris');
        eq(text, 'Checkout with QRIS [agent:: pi] #feature [branch:: markwork/checkout-with-qris]');
        eq(cardBranch(text), 'markwork/checkout-with-qris');
        eq(cardBranch('No branch [agent:: pi]'), null);
        eq(setCardBranch(text, null), 'Checkout with QRIS [agent:: pi] #feature');
    });

    await test('a worktree is made next to the project on a branch of its own', async () => {
        const { root, repo } = await project();
        const made = await within(createWorktree(runGit, { folder: `${repo}/web`, title: 'Checkout with QRIS', isolation: iso() }));
        if (!made.ok) throw new Error(made.message);
        const wt = made.value;
        eq(slash(wt.path), slash(`${root}/.markwork-worktrees/shop/checkout-with-qris`));
        eq(wt.cwd, `${wt.path}/web`, 'the harness runs where the project folder is inside the repository');
        eq([wt.branch, wt.base, slash(wt.repo)], ['markwork/checkout-with-qris', 'main', slash(repo)]);
        eq(wt.baseCommit, await sh(repo, 'rev-parse', 'main'));
        ok(exists(`${wt.cwd}/cart.ts`), 'checked out');
        eq(await sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the project folder stays on its branch');
        eq(await sh(repo, 'config', 'branch.markwork/checkout-with-qris.markworkBase'), 'main', 'the base is remembered');

        const again = await within(createWorktree(runGit, { folder: repo, title: 'Checkout with QRIS', isolation: iso() }));
        ok(again.ok && again.value.branch === 'markwork/checkout-with-qris-2', 'a taken name gets a number');
        eq((await within(listWorktrees(runGit, repo))).map(w => w.branch), ['main', 'markwork/checkout-with-qris', 'markwork/checkout-with-qris-2']);
    });

    await test('a worktree is found again from its branch, and removed', async () => {
        const { repo } = await project();
        const made = await within(createWorktree(runGit, { folder: repo, title: 'Fix', isolation: iso() }));
        if (!made.ok) throw new Error(made.message);
        disk.write(`${repo}/web/cart.ts`, 'export const cart = [1];\n');
        await sh(repo, 'commit', '-q', '-a', '-m', 'Main moved on');
        const found = await within(findWorktree(runGit, repo, 'markwork/fix'));
        if (!found.ok) throw new Error(found.message);
        eq({ ...found.value }, { ...made.value }, 'the same worktree, with the commit it started from');
        eq((await within(findWorktree(runGit, repo, 'markwork/none'))).ok, false);

        eq((await within(removeWorktree(runGit, made.value, true))).ok, true);
        ok(!exists(made.value.path), 'the folder is gone');
        ok((await sh(repo, 'branch', '--list', 'markwork/fix')).length > 0, 'the branch is kept when asked');
        const again = await within(createWorktree(runGit, { folder: repo, title: 'Other', isolation: iso() }));
        if (!again.ok) throw new Error(again.message);
        eq((await within(removeWorktree(runGit, again.value))).ok, true);
        eq(await sh(repo, 'branch', '--list', 'markwork/other'), '', 'and deleted otherwise');
    });

    await test('what cannot get a worktree says why', async () => {
        const plain = disk.join(dir, `plain-${++counter}`);
        disk.mkdirs(plain);
        const none = await within(repoInfo(runGit, plain));
        ok(!none.ok && none.notRepo === true, 'not a repository → work in the folder');
        const empty = disk.join(dir, `empty-${++counter}`);
        disk.mkdirs(empty);
        await sh(empty, 'init', '-q', '-b', 'main');
        const fresh = await within(createWorktree(runGit, { folder: empty, title: 'x', isolation: iso() }));
        ok(!fresh.ok && !fresh.notRepo && /no commit/.test(fresh.message), `no commit yet: ${!fresh.ok && fresh.message}`);
        const { repo } = await project();
        const missing = await within(createWorktree(runGit, { folder: repo, title: 'x', isolation: iso({ base: 'develop' }) }));
        ok(!missing.ok && /develop does not exist/.test(missing.message), 'an unknown base branch');
        await sh(repo, 'checkout', '-q', '--detach');
        const detached = await within(createWorktree(runGit, { folder: repo, title: 'x', isolation: iso() }));
        ok(!detached.ok && /detached/.test(detached.message), 'a detached HEAD needs a base branch');
        ok((await within(createWorktree(runGit, { folder: repo, title: 'x', isolation: iso({ base: 'main' }) }))).ok, 'which is then used');
    });

    await test('the prompt tells the harness about its branch', async () => {
        const card = { text: 'Checkout [agent:: pi]', done: false, notes: [] };
        const wt = { path: '/w/checkout', cwd: '/w/checkout', branch: 'markwork/checkout', base: 'main', baseCommit: 'abc', repo: '/r' };
        const prompt = buildPrompt(card, 'shop', 'board.md', [], wt);
        contains(prompt, 'on the branch markwork/checkout (from main)');
        contains(prompt, 'do not switch branches');
        ok(!prompt.includes('Do not make commits'), 'commits on its own branch are fine');
    });

    // A worktree where the "harness" committed one change, left another uncommitted, made a new file, and deleted one.
    const worked = async () => {
        const p = await project();
        disk.write(`${p.repo}/web/old.ts`, 'old\n');
        await sh(p.repo, 'add', '-A');
        await sh(p.repo, 'commit', '-q', '-m', 'Old file');
        const made = await within(createWorktree(runGit, { folder: `${p.repo}/web`, title: 'Checkout', isolation: iso() }));
        if (!made.ok) throw new Error(made.message);
        const wt = made.value;
        disk.write(`${wt.cwd}/cart.ts`, 'export const cart = [];\nexport const total = 0;\n');
        await sh(wt.path, 'commit', '-q', '-a', '-m', 'Add a total');
        disk.write(`${wt.cwd}/qris.ts`, 'export const qris = 1;\n');
        disk.remove(`${wt.cwd}/old.ts`);
        return { ...p, wt };
    };

    await test('the review shows committed, uncommitted, new, and deleted changes against the start', async () => {
        const { repo, wt } = await worked();
        const read = await within(readReview(runGit, wt));
        if (!read.ok) throw new Error(read.message);
        const r = read.value;
        eq(r.files.map(f => [f.path, f.status, f.additions, f.deletions]), [['web/cart.ts', 'modified', 1, 0], ['web/old.ts', 'deleted', 0, 1], ['web/qris.ts', 'added', 1, 0]]);
        eq(r.commits.map(c => c.subject), ['Add a total']);
        eq([r.uncommitted, r.behind, r.conflicts], [true, 0, []]);
        eq(await sh(repo, 'status', '--porcelain'), '', 'the project folder is untouched');
        const lines = parseDiff(r.files[0].part);
        eq(newLineNumbers(lines), [null, 1, 2], 'line numbers in the new file');
    });

    await test('splitDiff: renames and binary files', async () => {
        const files = splitDiff('diff --git a/a.md b/b.md\nsimilarity index 90%\nrename from a.md\nrename to b.md\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n');
        eq(files.map(f => [f.path, f.oldPath, f.status, f.binary]), [['b.md', 'a.md', 'renamed', false], ['i.png', null, 'modified', true]]);
    });

    await test('merging takes everything into the base and removes the worktree', async () => {
        const { repo, wt } = await worked();
        const merged = await within(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'Checkout with QRIS', keepBranch: false }));
        if (!merged.ok) throw new Error(merged.message);
        eq(await sh(repo, 'log', '-1', '--format=%s'), 'Checkout with QRIS');
        eq((await sh(repo, 'log', '-1', '--format=%p')).split(' ').length, 2, 'a merge commit');
        ok(exists(`${repo}/web/qris.ts`) && !exists(`${repo}/web/old.ts`), 'the uncommitted work came along');
        ok(!exists(wt.path), 'the worktree is gone');
        eq(await sh(repo, 'branch', '--list', wt.branch), '', 'and its branch');
    });

    await test('squashing makes one commit; taking some files leaves the others out', async () => {
        const a = await worked();
        const squashed = await within(mergeWorktree(runGit, a.wt, { method: 'squash', files: null, message: 'Squashed', keepBranch: true }));
        if (!squashed.ok) throw new Error(squashed.message);
        eq((await sh(a.repo, 'log', '-1', '--format=%p')).split(' ').length, 1, 'one parent');
        ok((await sh(a.repo, 'branch', '--list', a.wt.branch)).length > 0, 'the branch was kept');

        const b = await worked();
        const review = await within(readReview(runGit, b.wt));
        if (!review.ok) throw new Error(review.message);
        const some = review.value.files.filter(f => f.path !== 'web/cart.ts');
        const taken = await within(mergeWorktree(runGit, b.wt, { method: 'merge', files: some, message: 'Two of three', keepBranch: false }));
        if (!taken.ok) throw new Error(taken.message);
        ok(exists(`${b.repo}/web/qris.ts`) && !exists(`${b.repo}/web/old.ts`), 'the chosen ones');
        eq(disk.read(`${b.repo}/web/cart.ts`).length, 'export const cart = [];\n'.length, 'the one left out is as it was');
    });

    await test('a merge that would conflict is found before, and refused without leaving a mess', async () => {
        const { repo, wt } = await worked();
        disk.write(`${repo}/web/cart.ts`, 'export const cart = [9];\n');
        await sh(repo, 'commit', '-q', '-a', '-m', 'Main moved on');
        const review = await within(readReview(runGit, wt));
        if (!review.ok) throw new Error(review.message);
        eq([review.value.behind, review.value.conflicts], [1, ['web/cart.ts']]);
        const merged = await within(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'x', keepBranch: false }));
        ok(!merged.ok && /conflicts.*cart\.ts/.test(merged.message), `refused: ${!merged.ok && merged.message}`);
        eq(await sh(repo, 'status', '--porcelain'), '', 'the project folder is clean again');
        ok(exists(wt.path), 'the worktree is still there');
        const some = review.value.files.filter(f => f.path === 'web/cart.ts');
        const taken = await within(mergeWorktree(runGit, wt, { method: 'merge', files: some, message: 'x', keepBranch: false }));
        ok(!taken.ok && /changed on main too/.test(taken.message), 'taking a file that main changed too is refused');
    });

    await test('the project folder must be on the base branch and clean', async () => {
        const { repo, wt } = await worked();
        disk.write(`${repo}/web/cart.ts`, 'dirty\n');
        const dirty = await within(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'x', keepBranch: false }));
        ok(!dirty.ok && /not committed/.test(dirty.message), 'uncommitted changes');
        await sh(repo, 'checkout', '-q', '--', '.');
        await sh(repo, 'checkout', '-q', '-b', 'other');
        const elsewhere = await within(mergeWorktree(runGit, wt, { method: 'merge', files: null, message: 'x', keepBranch: false }));
        ok(!elsewhere.ok && /switch the project folder to main/.test(elsewhere.message), 'another branch');
    });

    await test('comments on the diff become the reply', async () => {
        eq(commentsReply([]), '');
        eq(commentsReply([{ path: 'web/cart.ts', line: 2, quote: '+export const total = 0;', text: 'Use the order total.' }]),
            'Please address these review comments on your changes:\n\n- web/cart.ts:2 (`+export const total = 0;`): Use the order total.\n');
    });

    await test('RunQueue: cards with worktrees share their lane up to its slots', async () => {
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
