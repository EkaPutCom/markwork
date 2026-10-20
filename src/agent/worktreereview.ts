// Reviewing what a harness did in a card's worktree, and merging it into the base branch (pure; git is a
// parameter, as in worktree.ts). The review reads the branch and what was left uncommitted against the commit it
// started from; nothing here trusts the harness's own account of what it changed.
//
// Merging is a Git operation the user starts: the worktree's leftovers are committed on its branch, then the branch is
// merged (or squashed) into the base in the project folder. Only some of the files can be taken: they are then copied
// from the branch and committed as one commit, which is refused for a file that also changed on the base since.

import type { GitRunner, GitRun } from '../forge/contribute.js';
import type { Outcome, Worktree } from './worktree.js';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
    path: string;              // the path now (the new name of a renamed file)
    oldPath: string | null;    // the old name of a renamed file
    status: FileStatus;
    additions: number;
    deletions: number;
    binary: boolean;
    part: string;              // this file's part of the unified diff, header included
}

export interface Commit { hash: string; subject: string }

export interface Review {
    files: ChangedFile[];
    commits: Commit[];         // on the branch since it started, newest first
    uncommitted: boolean;      // the harness left changes it did not commit
    behind: number;            // commits the base got since the worktree started
    conflicts: string[] | null;   // files a merge of the branch would conflict in; null = git could not tell
    mergeBase: string;
}

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
const reason = (run: GitRun | null): string => run ? (run.err.trim() || run.out.trim() || `git exited with ${run.status}`).split('\n')[0] : 'git cannot be run';

async function out(git: GitRunner, cwd: string, args: string[]): Promise<string | null> {
    const run = await git(cwd, args);
    return run?.status === 0 ? run.out : null;
}

// ---------- Reading the diff ----------

const HEADER = /^diff --git a\/(.+) b\/(.+)$/;

// The unified diff of several files, one entry per file.
export function splitDiff(diff: string): ChangedFile[] {
    return diff.split(/^(?=diff --git )/m).filter(part => part.startsWith('diff --git ')).map(fileOf);
}

function fileOf(part: string): ChangedFile {
    const lines = part.split('\n');
    const head = HEADER.exec(lines[0]);
    const renamedFrom = lines.find(l => l.startsWith('rename from '))?.slice('rename from '.length) ?? null;
    const status: FileStatus = lines.some(l => l.startsWith('new file mode')) ? 'added'
        : lines.some(l => l.startsWith('deleted file mode')) ? 'deleted'
        : renamedFrom !== null ? 'renamed' : 'modified';
    let additions = 0, deletions = 0, inHunk = false;
    for (const line of lines) {
        if (line.startsWith('@@')) inHunk = true;
        else if (inHunk && line.startsWith('+')) additions++;
        else if (inHunk && line.startsWith('-')) deletions++;
    }
    return {
        path: head?.[2] ?? lines[0], oldPath: status === 'renamed' ? renamedFrom : null, status, additions, deletions,
        binary: /^Binary files .* differ$|^GIT binary patch$/m.test(part), part,
    };
}

// The line number in the new file of each line of a diff part (null for a header, a hunk line, or a removed line), so a
// comment can name the place it is about.
export function newLineNumbers(lines: readonly { kind: string; text: string }[]): (number | null)[] {
    let next = 0;
    return lines.map(line => {
        if (line.kind === 'hunk') { next = Number(/\+(\d+)/.exec(line.text)?.[1] ?? 0); return null; }
        if (line.kind === 'del') return null;
        return next++;
    });
}

// What the harness did in the worktree. Files it created and did not add are marked "intent to add" in the worktree's
// own index first, so the diff shows them; that changes nothing in the files and nothing in the project folder.
export async function readReview(git: GitRunner, wt: Worktree): Promise<Outcome<Review>> {
    const mergeBase = (await out(git, wt.path, ['merge-base', wt.base, 'HEAD']))?.trim() || wt.baseCommit;
    await git(wt.path, ['add', '--intent-to-add', '--all']);
    const diff = await git(wt.path, ['diff', '--no-color', '--no-ext-diff', '--find-renames', mergeBase]);
    if (diff?.status !== 0) return fail(`cannot read the changes: ${reason(diff)}`);
    const log = await out(git, wt.path, ['log', '--format=%h%x09%s', `${mergeBase}..HEAD`]) ?? '';
    const status = await out(git, wt.path, ['status', '--porcelain']) ?? '';
    const behind = Number((await out(git, wt.repo, ['rev-list', '--count', `${mergeBase}..${wt.base}`]))?.trim() ?? 0) || 0;
    return {
        ok: true,
        value: {
            files: splitDiff(diff.out),
            commits: log.split('\n').filter(Boolean).map(l => { const [hash, ...rest] = l.split('\t'); return { hash, subject: rest.join('\t') }; }),
            uncommitted: status.trim() !== '',
            behind,
            conflicts: behind ? await mergeConflicts(git, wt) : [],
            mergeBase,
        },
    };
}

// The files a merge of the branch into the base would conflict in, worked out without touching any folder
// (`git merge-tree`, Git 2.38 and later). Uncommitted changes are not part of it. null = this git cannot tell.
export async function mergeConflicts(git: GitRunner, wt: Worktree): Promise<string[] | null> {
    const run = await git(wt.repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', wt.base, wt.branch]);
    if (run?.status === 0) return [];
    if (run?.status !== 1) return null;
    return run.out.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
}

// ---------- Merging ----------

export type MergeMethod = 'merge' | 'squash';

export interface MergeOptions {
    method: MergeMethod;
    files: readonly ChangedFile[] | null;   // null = everything; otherwise only these, as one commit
    message: string;                         // the commit message (the merge commit, or the one commit)
    keepBranch: boolean;                     // keep the branch after the worktree is removed
}

// Merges the card's work into the base branch in the project folder, then removes the worktree. Returns the commit
// the base branch is at afterwards.
export async function mergeWorktree(git: GitRunner, wt: Worktree, options: MergeOptions): Promise<Outcome<string>> {
    const committed = await commitLeftovers(git, wt, options.message);
    if (!committed.ok) return committed;
    const ready = await projectReady(git, wt);
    if (!ready.ok) return ready;
    const merged = options.files ? await takeFiles(git, wt, options.files, options.message) : await mergeBranch(git, wt, options.method, options.message);
    if (!merged.ok) return merged;
    const head = (await out(git, wt.repo, ['rev-parse', 'HEAD']))?.trim() ?? '';
    const removed = await git(wt.repo, ['worktree', 'remove', '--force', wt.path]);
    if (removed?.status !== 0) return fail(`merged, but the worktree could not be removed: ${reason(removed)}`);
    if (!options.keepBranch) await git(wt.repo, ['branch', '-D', wt.branch]);
    return { ok: true, value: head };
}

// What the harness left uncommitted becomes a commit on its branch, so the merge takes it too. The value says whether a
// commit was made, so a step that fails afterwards can take it back (uncommitLeftovers).
export async function commitLeftovers(git: GitRunner, wt: Worktree, message: string): Promise<Outcome<boolean>> {
    const status = await out(git, wt.path, ['status', '--porcelain']);
    if (status === null) return fail('cannot read the worktree');
    if (!status.trim()) return { ok: true, value: false };
    const added = await git(wt.path, ['add', '--all']);
    if (added?.status !== 0) return fail(`cannot add the changes: ${reason(added)}`);
    const commit = await git(wt.path, ['commit', '--quiet', '--no-verify', '-m', `${message} (uncommitted work)`]);
    return commit?.status === 0 ? { ok: true, value: true } : fail(`cannot commit the changes in the worktree: ${reason(commit)}`);
}

// Takes the commit commitLeftovers made back: the files stay as they are, uncommitted again.
export async function uncommitLeftovers(git: GitRunner, wt: Worktree): Promise<void> {
    await git(wt.path, ['reset', '--quiet', 'HEAD~1']);
}

// The project folder must be on the base branch, with no change of its own to tracked files and no merge going on.
async function projectReady(git: GitRunner, wt: Worktree): Promise<Outcome<null>> {
    const branch = (await out(git, wt.repo, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
    if (branch !== wt.base) return fail(`switch the project folder to ${wt.base} first (it is on ${branch ?? 'no branch'})`);
    const status = await out(git, wt.repo, ['status', '--porcelain', '--untracked-files=no']);
    if (status === null) return fail('cannot read the project folder');
    if (status.trim()) return fail('the project folder has changes that are not committed; commit or stash them first');
    if (await out(git, wt.repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']) !== null) return fail('a merge is going on in the project folder');
    return { ok: true, value: null };
}

async function mergeBranch(git: GitRunner, wt: Worktree, method: MergeMethod, message: string): Promise<Outcome<null>> {
    const args = method === 'squash' ? ['merge', '--squash', wt.branch] : ['merge', '--no-ff', '--no-edit', '-m', message, wt.branch];
    const run = await git(wt.repo, args);
    if (run?.status !== 0) return undo(git, wt, `the merge conflicts: ${await conflicted(git, wt) || reason(run)}`);
    if (method === 'merge') return { ok: true, value: null };
    const commit = await git(wt.repo, ['commit', '--quiet', '--no-verify', '-m', message]);
    return commit?.status === 0 ? { ok: true, value: null } : undo(git, wt, `cannot commit the squashed changes: ${reason(commit)}`);
}

// Only some files: they are copied from the branch, which is safe only for files the base did not change since.
async function takeFiles(git: GitRunner, wt: Worktree, files: readonly ChangedFile[], message: string): Promise<Outcome<null>> {
    if (!files.length) return fail('no file was chosen');
    const mergeBase = (await out(git, wt.repo, ['merge-base', wt.base, wt.branch]))?.trim();
    if (!mergeBase) return fail(`${wt.branch} has nothing in common with ${wt.base}`);
    const paths = files.flatMap(f => f.oldPath ? [f.path, f.oldPath] : [f.path]);
    const both = (await out(git, wt.repo, ['diff', '--name-only', mergeBase, wt.base, '--', ...paths]))?.trim();
    if (both) return fail(`${both.split('\n').join(', ')} changed on ${wt.base} too; merge everything, or ask the agent to update its branch`);
    const removed = files.filter(f => f.status === 'deleted').map(f => f.path).concat(files.flatMap(f => f.oldPath ? [f.oldPath] : []));
    const taken = files.filter(f => f.status !== 'deleted').map(f => f.path);
    if (taken.length && (await git(wt.repo, ['checkout', wt.branch, '--', ...taken]))?.status !== 0) return undo(git, wt, 'cannot take the files from the branch');
    if (removed.length && (await git(wt.repo, ['rm', '--quiet', '--', ...removed]))?.status !== 0) return undo(git, wt, 'cannot remove the deleted files');
    const commit = await git(wt.repo, ['commit', '--quiet', '--no-verify', '-m', message]);
    return commit?.status === 0 ? { ok: true, value: null } : undo(git, wt, `cannot commit the files: ${reason(commit)}`);
}

async function conflicted(git: GitRunner, wt: Worktree): Promise<string> {
    return (await out(git, wt.repo, ['diff', '--name-only', '--diff-filter=U']))?.trim().split('\n').join(', ') ?? '';
}

// Puts the project folder back where it was before the merge was tried.
async function undo(git: GitRunner, wt: Worktree, message: string): Promise<{ ok: false; message: string }> {
    await git(wt.repo, ['merge', '--abort']);
    await git(wt.repo, ['reset', '--quiet', '--merge']);
    return fail(message);
}

// ---------- Talking back ----------

export interface LineComment { path: string; line: number | null; quote: string; text: string }

// The reply that sends the user's comments on the diff to the harness.
export function commentsReply(comments: readonly LineComment[]): string {
    if (!comments.length) return '';
    const items = comments.map(c => `- ${c.path}${c.line ? `:${c.line}` : ''} (\`${c.quote.trim().slice(0, 120)}\`): ${c.text.trim()}`);
    return ['Please address these review comments on your changes:', '', ...items, ''].join('\n');
}

// The shell commands a harness ran, from its log (pi's `bash` tool), with whether each one succeeded: what it claims
// to have checked, which the user can weigh. Markwork itself runs none of them.
export interface RanCommand { command: string; ok: boolean | null }

export function commandsRun(events: readonly { kind: string; title: string; args?: string; status?: string }[]): RanCommand[] {
    return events.filter(e => e.kind === 'tool' && e.title === 'bash').map(e => {
        let command = '';
        try { command = String((JSON.parse(e.args ?? '{}') as { command?: unknown }).command ?? ''); } catch { /* not JSON */ }
        return { command: command.trim(), ok: e.status === 'ok' ? true : e.status === 'failed' ? false : null };
    }).filter(c => c.command);
}

// ---------- Pull requests ----------

// The description a pull request starts with: what the harness said it did, and the commits of the branch.
export function pullRequestBody(summary: string, commits: readonly Commit[], uncommitted: boolean): string {
    const said = summary.trim();
    const list = [...commits.map(c => `- ${c.subject}`), ...(uncommitted ? ['- Changes the agent did not commit'] : [])];
    return [said.length > 4000 ? `${said.slice(0, 3999)}…` : said, list.length ? `Commits:\n${list.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

// A card's note that says its pull request was opened; the card keeps no other record of it.
export const pullNote = (number: number, url: string, stamp: string): string => `↳ pull request #${number} opened ${stamp}: ${url}`;

export function pullFromNotes(notes: readonly string[]): { number: number; url: string } | null {
    for (const note of [...notes].reverse()) {
        const m = /^↳ pull request #(\d+) opened .*?: (https?:\/\/\S+)$/.exec(note.trim());
        if (m) return { number: Number(m[1]), url: m[2] };
    }
    return null;
}
