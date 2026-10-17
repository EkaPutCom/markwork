// A Git worktree per kanban card (pure, no GTK): a harness works on its own branch in its own folder next to the
// project, so cards of one project can run side by side and nothing reaches the project folder until the user merges.
// Git is a function passed in: on this computer it is `git` as a child process, on another machine it is `git`
// started through markworkd there, and in the tests it runs against temporary repositories.
//
// Layout: the project /home/eka/web gets its worktrees in /home/eka/.markwork-worktrees/web/<slug>, on the branch
// markwork/<slug>. Next to the project, never inside it, so the harness does not see the other worktrees and a
// daemon that allows the project's parent folder allows them too. The base branch a worktree started from is kept
// in the branch's own Git config (branch.<name>.markworkBase), so it can be reviewed after Markwork restarted.

import type { GitRun, GitRunner } from '../forge/contribute.js';
import { platform } from '../platform/index.js';

// A worktree folder is absolute on the machine the project is on: a POSIX path (a project on another machine) or one
// that is absolute on this computer (C:\... on Windows).
export const isAbsoluteDir = (dir: string): boolean => dir.startsWith('/') || platform().paths.isAbsolute(dir);

export const BRANCH_PREFIX = 'markwork/';
export const WORKTREES_DIR = '.markwork-worktrees';
const BASE_KEY = 'markworkBase';
const MAX_SLUG = 40;

// How a project's cards are isolated, from the project's settings.
export interface Isolation {
    worktrees: boolean;    // false = cards work in the project folder itself, one at a time
    slots: number;         // cards of the project that may work at the same time
    base: string;          // the branch new worktrees start from; '' = the branch the project folder is on
    dir: string;           // where the project's worktrees go; '' = next to the project (worktreeRoot)
    afterMerge: 'remove' | 'keep-branch';
}

export const DEFAULT_ISOLATION: Isolation = { worktrees: true, slots: 2, base: '', dir: '', afterMerge: 'remove' };
export const MAX_SLOTS = 8;

// The isolation stored for a project (a JSON object in the settings); what is missing or wrong takes the default.
export function parseIsolation(json: string | undefined): Isolation {
    let raw: Record<string, unknown> = {};
    try { raw = json ? JSON.parse(json) as Record<string, unknown> : {}; } catch { /* the default */ }
    const d = DEFAULT_ISOLATION;
    const slots = typeof raw.slots === 'number' && Number.isInteger(raw.slots) ? Math.min(MAX_SLOTS, Math.max(1, raw.slots)) : d.slots;
    return {
        worktrees: typeof raw.worktrees === 'boolean' ? raw.worktrees : d.worktrees,
        slots,
        base: typeof raw.base === 'string' ? raw.base.trim() : d.base,
        dir: typeof raw.dir === 'string' && (raw.dir === '' || isAbsoluteDir(raw.dir)) ? raw.dir : d.dir,
        afterMerge: raw.afterMerge === 'keep-branch' ? 'keep-branch' : d.afterMerge,
    };
}

export const writeIsolation = (isolation: Isolation): string => JSON.stringify(isolation);

// One card's worktree.
export interface Worktree {
    path: string;          // the worktree's top folder
    cwd: string;           // where the harness runs: the project folder's place inside the worktree
    branch: string;        // markwork/<slug>
    base: string;          // the branch it started from, and is merged back into
    baseCommit: string;    // the commit it started from
    repo: string;          // the project repository's top folder (the main worktree)
}

// notRepo: the project folder is not in a Git repository, so its cards work in the folder itself.
export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string; notRepo?: boolean };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
const reason = (run: GitRun | null): string => run ? (run.err.trim() || run.out.trim() || `git exited with ${run.status}`).split('\n')[0] : 'git cannot be run';

async function out(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
    const run = await git(cwd, args);
    return run?.status === 0 ? run.out.trim() : null;
}

// ---------- Paths and names ----------

const trimSlash = (path: string): string => path.replace(/[\\/]+$/, '') || '/';
const parentOf = (path: string): string => trimSlash(path).replace(/[\\/][^\\/]*$/, '') || '/';
const baseName = (path: string): string => trimSlash(path).split(/[\\/]/).pop() ?? '';
const join = (...parts: string[]): string => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');

// The folder the project's worktrees go in.
export function worktreeRoot(repo: string, dir = ''): string {
    return dir ? trimSlash(dir) : join(parentOf(repo), WORKTREES_DIR, baseName(repo));
}

// A short name for the card's branch and folder: lowercase letters, digits, and dashes.
export function slugFor(title: string): string {
    const ascii = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/, '');
    return slug || 'card';
}

// The card's branch name from its `[branch:: …]` field, if it is one of ours.
export const isCardBranch = (branch: string): boolean => branch.startsWith(BRANCH_PREFIX) && /^[\w./-]+$/.test(branch) && !branch.includes('..');

// ---------- The project repository ----------

export interface RepoInfo {
    top: string;           // the repository's top folder
    sub: string;           // the project folder relative to it ('' = the top)
    branch: string | null; // the branch it is on; null = a detached HEAD
}

// The repository the project folder belongs to; a message when it is not one Markwork can make worktrees for.
export async function repoInfo(git: GitRunner, folder: string): Promise<Outcome<RepoInfo>> {
    const run = await git(folder, ['rev-parse', '--show-toplevel', '--show-prefix', '--abbrev-ref', 'HEAD']);
    if (!run) return fail('git cannot be run');
    if (run.status !== 0 && /not a git repository/i.test(run.err)) return { ok: false, message: 'the project folder is not in a Git repository', notRepo: true };
    if (run.status !== 0) return fail(/ambiguous argument 'HEAD'|unknown revision/i.test(run.err) ? 'the repository has no commit yet' : reason(run));
    const [top, prefix, head] = run.out.split('\n');
    if (!top) return { ok: false, message: 'the project folder is not in a Git repository', notRepo: true };
    return { ok: true, value: { top, sub: (prefix ?? '').replace(/\/$/, ''), branch: head && head !== 'HEAD' ? head : null } };
}

// ---------- Creating and finding ----------

export interface CreateOptions {
    folder: string;        // the project folder
    title: string;         // the card title, for the branch name
    isolation: Isolation;
}

// Makes the card's worktree: a new branch markwork/<slug> from the base, checked out in its own folder.
export async function createWorktree(git: GitRunner, options: CreateOptions): Promise<Outcome<Worktree>> {
    const info = await repoInfo(git, options.folder);
    if (!info.ok) return info;
    const { top, sub, branch } = info.value;
    const base = options.isolation.base || branch;
    if (!base) return fail('the project folder is on no branch (a detached HEAD); choose a base branch in its settings');
    const baseCommit = await out(git, top, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`]);
    if (!baseCommit) return fail(`the base branch ${base} does not exist`);
    const root = worktreeRoot(top, options.isolation.dir);
    const slug = await freeSlug(git, top, root, slugFor(options.title));
    const path = join(root, slug), name = `${BRANCH_PREFIX}${slug}`;
    const added = await git(top, ['worktree', 'add', '-b', name, path, baseCommit]);
    if (added?.status !== 0) return fail(`cannot make a worktree: ${reason(added)}`);
    await git(top, ['config', `branch.${name}.${BASE_KEY}`, base]);
    return { ok: true, value: { path, cwd: join(path, sub), branch: name, base, baseCommit, repo: top } };
}

// The slug, or the slug with -2, -3, … when its branch or folder is taken.
async function freeSlug(git: GitRunner, repo: string, root: string, slug: string): Promise<string> {
    const taken = new Set((await listWorktrees(git, repo)).map(w => w.path));
    for (let n = 1; ; n++) {
        const candidate = n === 1 ? slug : `${slug}-${n}`;
        const branchTaken = await out(git, repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH_PREFIX}${candidate}`]);
        if (!branchTaken && !taken.has(join(root, candidate))) return candidate;
    }
}

export interface ListedWorktree { path: string; branch: string | null; head: string }

// Every worktree of the repository (the main one first), from `git worktree list --porcelain`.
export async function listWorktrees(git: GitRunner, repo: string): Promise<ListedWorktree[]> {
    const text = await out(git, repo, ['worktree', 'list', '--porcelain']);
    if (!text) return [];
    return text.split(/\n\n+/).map(block => {
        const lines = block.split('\n');
        const value = (key: string) => lines.find(l => l.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
        const ref = value('branch');
        return { path: value('worktree') ?? '', branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null, head: value('HEAD') ?? '' };
    }).filter(w => w.path);
}

// The worktree of a card's branch, found again from the project folder (after a restart, or on another machine).
export async function findWorktree(git: GitRunner, folder: string, branch: string): Promise<Outcome<Worktree>> {
    const info = await repoInfo(git, folder);
    if (!info.ok) return info;
    const { top, sub } = info.value;
    const listed = (await listWorktrees(git, top)).find(w => w.branch === branch);
    if (!listed) return fail(`the worktree of ${branch} is gone`);
    const base = await out(git, top, ['config', `branch.${branch}.${BASE_KEY}`]) || info.value.branch;
    if (!base) return fail(`the base branch of ${branch} is unknown`);
    const baseCommit = await out(git, top, ['merge-base', base, branch]);
    if (!baseCommit) return fail(`${branch} has nothing in common with ${base}`);
    return { ok: true, value: { path: listed.path, cwd: join(listed.path, sub), branch, base, baseCommit, repo: top } };
}

// Removes the worktree folder (with what is in it) and, unless kept, its branch.
export async function removeWorktree(git: GitRunner, wt: Worktree, keepBranch = false): Promise<Outcome<null>> {
    const removed = await git(wt.repo, ['worktree', 'remove', '--force', wt.path]);
    if (removed?.status !== 0 && !/is not a working tree/.test(removed?.err ?? '')) return fail(`cannot remove the worktree: ${reason(removed)}`);
    if (!keepBranch) {
        const deleted = await git(wt.repo, ['branch', '-D', wt.branch]);
        if (deleted?.status !== 0) return fail(`cannot delete the branch ${wt.branch}: ${reason(deleted)}`);
    }
    return { ok: true, value: null };
}
