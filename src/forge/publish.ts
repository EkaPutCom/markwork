// Publishing a branch that already exists as a pull request: the branch of a card's worktree, which holds the commits
// the user reviewed. Like sendChanges (contribute.ts) it takes the forge and git as parameters; unlike it, it makes no
// branch and no commit, it only pushes and opens the pull request. git runs wherever the repository is (a GitRunner on
// this computer or through markworkd), the forge is called from here.

import { ForgeError, type PullRequest, type RepoInfo } from './types';
import { agitOptions, branchError, credentialEnv, ownCopy, type GitRun, type SendContext, type SendVia } from './contribute';

export interface PublishRequest {
    cwd: string;           // a folder of the repository that has the branch checked out
    branch: string;        // the local branch to publish
    base: string;          // the branch the pull request asks to merge into
    title: string;
    body: string;
    via: SendVia;
}

export type PublishResult =
    | { ok: true; pull: PullRequest | null; message: string }    // pull null = AGit, which does not hand it back
    | { ok: false; message: string; pushed: boolean };           // pushed = the branch is on the server although the pull request is not

const fail = (message: string, pushed = false): PublishResult => ({ ok: false, message, pushed });
const text = (e: unknown): string => e instanceof Error ? e.message : String(e);

// What a failed push says, in words for the user. `branch` is the one that was pushed.
export function pushFailure(run: GitRun | null, branch: string): string {
    const said = (run?.err.trim() || run?.out.trim() || '');
    if (!run) return 'git could not be run';
    if (/env_not_allowed|environment variable .* is not allowed/i.test(said)) {
        return 'markworkd on that machine does not allow the variables the access token travels in; add "GIT_CONFIG_*" to env_allow in its config';
    }
    if (/non-fast-forward|\[rejected\]|fetch first|already exists/i.test(said)) {
        return `the branch ${branch} already exists on the server with other commits; rename it or delete it there first`;
    }
    if (/\b401\b|authentication failed|invalid credentials|bad credentials/i.test(said)) return 'the server refused the access token';
    if (/\b403\b|permission denied|not allowed to push|unauthorized/i.test(said)) return 'the access token may not push to this repository';
    if (/could not resolve host|couldn't connect|connection (refused|timed out)|unable to access/i.test(said)) return `the server cannot be reached from where the repository is (${said.split('\n').pop()?.trim()})`;
    return said.split('\n')[0] || `git exited with ${run.status}`;
}

async function push(ctx: SendContext, request: PublishRequest, login: string, args: string[]): Promise<string | null> {
    const run = await ctx.git(request.cwd, ['push', ...args], credentialEnv(login, ctx.token));
    return run?.status === 0 ? null : `Could not push: ${pushFailure(run, request.branch)}`;
}

export async function publishBranch(ctx: SendContext, request: PublishRequest): Promise<PublishResult> {
    const invalid = branchError(request.branch);
    if (invalid) return fail(invalid);
    if (!request.title.trim()) return fail('The pull request needs a title');
    let login: string, target: RepoInfo | null;
    try {
        [login, target] = await Promise.all([ctx.provider.currentUser(), ctx.provider.repoInfo()]);
    } catch (e) {
        return fail(text(e));
    }
    if (!target) return fail('The server does not know this repository, or the token cannot see it');
    if (request.via === 'direct' && !target.canPush) return fail('The access token may not push branches to this repository; send it through a fork instead');
    try {
        if (request.via === 'direct') {
            const open = (await ctx.provider.listPulls('open')).find(p => p.headRef === request.branch);
            if (open) return fail(`Pull request #${open.number} is already open for ${request.branch}: ${open.url}`);
        }
        if (request.via === 'agit') return await viaAgit(ctx, request, login, target);
        return await viaBranch(ctx, request, login, target);
    } catch (e) {
        return fail(text(e));
    }
}

async function viaAgit(ctx: SendContext, request: PublishRequest, login: string, target: RepoInfo): Promise<PublishResult> {
    const error = await push(ctx, request, login, [target.cloneUrl, `HEAD:refs/for/${request.base}`, ...agitOptions(request.branch, request.title.trim(), request.body)]);
    return error ? fail(error) : { ok: true, pull: null, message: 'Sent. The pull request appears in the list shortly.' };
}

async function viaBranch(ctx: SendContext, request: PublishRequest, login: string, target: RepoInfo): Promise<PublishResult> {
    let home = target;
    if (request.via === 'fork') {
        const copy = await ownCopy(ctx, login);
        if (typeof copy === 'string') return fail(copy);
        home = copy;
    }
    const ref = `refs/heads/${request.branch}`;
    const error = await push(ctx, request, login, [home.cloneUrl, `${ref}:${ref}`]);
    if (error) return fail(error);
    const head = request.via === 'fork' ? `${home.owner}:${request.branch}` : request.branch;
    try {
        const pull = await ctx.provider.createPull({ title: request.title.trim(), body: request.body.trim(), head, base: request.base });
        return { ok: true, pull, message: `Opened pull request #${pull.number}` };
    } catch (e) {
        const detail = e instanceof ForgeError && (e.status === 409 || e.status === 422) ? `a pull request for ${request.branch} may already exist (${e.message})` : text(e);
        return fail(`The branch ${request.branch} was pushed, but the pull request was not opened: ${detail}`, true);
    }
}
