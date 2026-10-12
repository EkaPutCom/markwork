// Resolving the conflicts of a pull request on this computer, the way the forge itself suggests for a manual merge: bring the
// local base branch up to date, merge the pull request into it, fix the files that conflict, commit, and push the base branch.
// The forge then sees the pull request's commits in the base branch and marks it merged. Git is a function passed in, so the
// same steps run against local bare repositories in the tests.

import { credentialEnv, type GitRun, type GitRunner } from './contribute.js';
import type { ForgeProvider } from './types.js';

export interface LocalMerge {
    folder: string;
    base: string;             // the branch the pull request asks to merge into
    cloneUrl: string;         // where to fetch from and push to
    pull: number;
    title: string;
    login: string;
    token: string;
}

export type MergeStart =
    | { ok: true; conflicts: string[]; before: string }     // conflicts are absolute paths; empty = it merged cleanly (and is committed)
    | { ok: false; message: string };

export type Step = { ok: true } | { ok: false; message: string };

const reason = (run: GitRun | null): string => (run?.err.trim() || run?.out.trim() || 'git could not be run').split('\n')[0];
const failed = (message: string): { ok: false; message: string } => ({ ok: false, message });

// A conflict marker that git left in a file, as opposed to a line of `=======`, which Markdown uses to underline a heading.
export const hasMarkers = (text: string): boolean => /^(<{7}|>{7})( |$)/m.test(text);

async function out(git: GitRunner, folder: string, args: string[]): Promise<string | null> {
    const run = await git(folder, args);
    return run?.status === 0 ? run.out.trim() : null;
}

// What must be true before a merge is started in the user's folder; null = go ahead.
export async function preflight(git: GitRunner, folder: string, base: string): Promise<string | null> {
    const branch = await out(git, folder, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== base) return `Switch this folder to the branch ${base} first (it is on ${branch ?? 'no branch'}).`;
    if (await out(git, folder, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) return 'A merge is already in progress in this folder. Finish or abort it first.';
    if (await out(git, folder, ['status', '--porcelain', '--untracked-files=no'])) return 'This folder has changes that are not committed. Commit or stash them first.';
    return null;
}

export async function conflictedFiles(git: GitRunner, folder: string): Promise<string[]> {
    const top = await out(git, folder, ['rev-parse', '--show-toplevel']);
    const names = await out(git, folder, ['diff', '--name-only', '--diff-filter=U']);
    if (top === null || !names) return [];
    return names.split('\n').filter(Boolean).map(name => `${top}/${name}`);
}

// Fetches the base branch and the pull request, and merges the second into the first.
export async function startLocalMerge(git: GitRunner, merge: LocalMerge): Promise<MergeStart> {
    const env = credentialEnv(merge.login, merge.token);
    const before = await out(git, merge.folder, ['rev-parse', 'HEAD']);
    if (before === null) return failed('This folder has no commits yet.');
    const base = await git(merge.folder, ['fetch', merge.cloneUrl, merge.base], env);
    if (base?.status !== 0) return failed(`Could not fetch the base branch: ${reason(base)}`);
    const forward = await git(merge.folder, ['merge', '--ff-only', 'FETCH_HEAD']);
    if (forward?.status !== 0) return failed(`Your ${merge.base} has changes the server does not have, or the other way round: bring them together first. (${reason(forward)})`);
    const head = await out(git, merge.folder, ['rev-parse', 'HEAD']);
    const fetched = await git(merge.folder, ['fetch', merge.cloneUrl, `refs/pull/${merge.pull}/head`], env);
    if (fetched?.status !== 0) return failed(`Could not fetch the pull request: ${reason(fetched)}`);
    const merged = await git(merge.folder, ['merge', '--no-ff', '-m', `Merge pull request #${merge.pull}: ${merge.title}`, 'FETCH_HEAD']);
    if (merged?.status === 0) return { ok: true, conflicts: [], before: head ?? before };
    const conflicts = await conflictedFiles(git, merge.folder);
    if (!conflicts.length) return failed(`The merge failed: ${reason(merged)}`);
    return { ok: true, conflicts, before: head ?? before };
}

// The files in `files` that still have conflict markers; `read` returns a file's text (the caller saved the editors first).
export function unresolved(files: readonly string[], read: (path: string) => string): string[] {
    return files.filter(path => hasMarkers(read(path)));
}

// Commits the resolution (when git is still waiting for it) and pushes the base branch.
export async function finishLocalMerge(git: GitRunner, merge: LocalMerge, files: readonly string[]): Promise<Step> {
    if (files.length) {
        const added = await git(merge.folder, ['add', '--', ...files]);
        if (added?.status !== 0) return failed(`Could not stage the files: ${reason(added)}`);
    }
    if (await out(git, merge.folder, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) {
        const left = await conflictedFiles(git, merge.folder);
        if (left.length) return failed(`Git still sees conflicts in ${left.length} file${left.length === 1 ? '' : 's'}.`);
        const committed = await git(merge.folder, ['commit', '--no-edit']);
        if (committed?.status !== 0) return failed(`Could not commit the merge: ${reason(committed)}`);
    }
    const pushed = await git(merge.folder, ['push', merge.cloneUrl, `HEAD:refs/heads/${merge.base}`], credentialEnv(merge.login, merge.token));
    if (pushed?.status !== 0) return failed(`Could not push: ${reason(pushed)}. The merge is committed in this folder.`);
    return { ok: true };
}

// Gives the folder back as it was before the merge: a merge in progress is aborted, a merge that was already committed
// (it had no conflicts) is undone by returning to the commit it started from.
export async function abortLocalMerge(git: GitRunner, folder: string, before: string): Promise<Step> {
    const inProgress = await out(git, folder, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    const run = await git(folder, inProgress ? ['merge', '--abort'] : ['reset', '--hard', before]);
    return run?.status === 0 ? { ok: true } : failed(`Could not undo the merge: ${reason(run)}`);
}

// After the merge was pushed: the pull request has to be recorded as merged. Some repositories notice by themselves
// (autodetect); otherwise the forge is told, which only works where the repository allows manually merged pull requests.
export async function confirmMerged(provider: ForgeProvider, pull: number, commit: string): Promise<Step> {
    const merged = async (): Promise<boolean> => { try { return (await provider.getPull(pull)).state === 'merged'; } catch (e) { return false; } };
    if (await merged()) return { ok: true };
    try {
        await provider.markMerged(pull, commit);
        return { ok: true };
    } catch (e) {
        if (await merged()) return { ok: true };
        const refused = (e as { failure?: string }).failure === 'not-mergeable';
        return failed(refused
            ? 'the repository does not allow manually merged pull requests, so the server still shows it as open. Turn on “Manually merged” in the repository\'s Pull Requests settings, or close the pull request by hand'
            : e instanceof Error ? e.message : String(e));
    }
}
