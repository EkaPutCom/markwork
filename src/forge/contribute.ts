// Sending the changes of a folder to a repository as a pull request: a branch, a commit, a push, and then the pull request
// itself. The forge is a ForgeProvider and git is a function, both passed in, so the same steps run against a fake forge and
// local repositories in the tests. A step that fails stops the rest and says which step it was.

import type { ForgeProvider, PullRequest, RepoInfo, RepoRef } from './types.js';

// fork: push to the user's own copy; direct: push a branch to the repository itself (needs the right to);
// agit: push to refs/for/<branch>, and the server opens the pull request without any fork or branch.
export type SendVia = 'fork' | 'direct' | 'agit';

export interface GitRun { status: number; out: string; err: string }
export type GitRunner = (cwd: string, args: string[], env?: Record<string, string>) => Promise<GitRun | null>;

export interface SendRequest {
    folder: string;
    files: string[];          // absolute paths of the changes to send
    title: string;            // also the commit subject
    body: string;
    branch: string;
    via: SendVia;
}

export interface SendContext {
    provider: ForgeProvider;
    repo: RepoRef;
    token: string;
    git: GitRunner;
}

export type SendResult =
    | { ok: true; pull: PullRequest | null; branch: string; message: string }   // pull null = AGit, which does not hand it back
    | { ok: false; message: string };

const fail = (message: string): SendResult => ({ ok: false, message });

// A branch name git accepts, and that cannot be mistaken for an option or a ref of another kind.
export function branchError(name: string): string | null {
    if (!name) return 'The branch needs a name';
    if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return 'That is not a usable branch name';
    if (/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|^@$/.test(name)) return 'That is not a usable branch name';
    return null;
}

// "Fix the typo in Journal!" → "fix-the-typo-in-journal"; empty when nothing usable is left.
export function slug(text: string): string {
    return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Standard base64 with padding (RFC 4648), so the header does not depend on the runtime.
export function base64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const n = bytes[i] << 16 | (bytes[i + 1] ?? 0) << 8 | (bytes[i + 2] ?? 0);
        out += BASE64[n >> 18 & 63] + BASE64[n >> 12 & 63];
        out += i + 1 < bytes.length ? BASE64[n >> 6 & 63] : '=';
        out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
    }
    return out;
}

// The token goes to git in the environment, as the password of a Basic header: not in the arguments, which `ps` shows to
// everybody, and not in the remote URL, which git writes to .git/config.
export function credentialEnv(login: string, token: string): Record<string, string> {
    const basic = base64(new TextEncoder().encode(`${login}:${token}`));
    return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

const reason = (run: GitRun | null): string => (run?.err.trim() || run?.out.trim() || 'git could not be run').split('\n')[0];

async function commitOnBranch(ctx: SendContext, request: SendRequest): Promise<string | null> {
    const { git } = ctx;
    const steps: [string, string[]][] = [
        ['create the branch', ['checkout', '-b', request.branch]],
        ['stage the changes', ['add', '-A', '--', ...request.files]],
        ['commit', ['commit', '-m', request.title, ...(request.body.trim() ? ['-m', request.body.trim()] : [])]],
    ];
    for (const [what, args] of steps) {
        const run = await git(request.folder, args);
        if (run?.status !== 0) return `Could not ${what}: ${reason(run)}`;
    }
    return null;
}

// The user's own copy of the repository: the one that exists, or a new fork.
export async function ownCopy(ctx: SendContext, login: string): Promise<RepoInfo | string> {
    const existing = await ctx.provider.repoInfo(login, ctx.repo.repo);
    if (!existing) return ctx.provider.fork();
    return existing.isFork ? existing : `${login}/${ctx.repo.repo} exists and is not a fork of this repository`;
}

async function push(ctx: SendContext, request: SendRequest, login: string, args: string[]): Promise<string | null> {
    const run = await ctx.git(request.folder, ['push', ...args], credentialEnv(login, ctx.token));
    return run?.status === 0 ? null : `Could not push: ${reason(run)}`;
}

// The push options with which the server opens the pull request itself. A line break would end an option, so the
// description goes in as one line.
export function agitOptions(topic: string, title: string, body: string): string[] {
    const options = ['-o', `topic=${topic}`, '-o', `title=${title}`];
    if (body.trim()) options.push('-o', `description=${body.trim().replace(/\s*\n\s*/g, ' ')}`);
    return options;
}

async function viaAgit(ctx: SendContext, request: SendRequest, login: string, target: RepoInfo): Promise<SendResult> {
    const options = agitOptions(request.branch, request.title, request.body);
    const error = await push(ctx, request, login, [target.cloneUrl, `HEAD:refs/for/${target.defaultBranch}`, ...options]);
    if (error) return fail(error);
    return { ok: true, pull: null, branch: request.branch, message: 'Sent. The pull request appears in the list shortly.' };
}

export async function sendChanges(ctx: SendContext, request: SendRequest): Promise<SendResult> {
    const invalid = branchError(request.branch);
    if (invalid) return fail(invalid);
    if (!request.title.trim()) return fail('The pull request needs a title');
    if (!request.files.length) return fail('There are no changes to send');
    let login: string, target: RepoInfo | null;
    try {
        [login, target] = await Promise.all([ctx.provider.currentUser(), ctx.provider.repoInfo()]);
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
    if (!target) return fail('The server does not know this repository, or the token cannot see it');
    const committed = await commitOnBranch(ctx, request);
    if (committed) return fail(committed);
    try {
        if (request.via === 'agit') return await viaAgit(ctx, request, login, target);
        return await viaBranch(ctx, request, login, target);
    } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
    }
}

// fork and direct differ only in where the branch goes and how the pull request names it.
async function viaBranch(ctx: SendContext, request: SendRequest, login: string, target: RepoInfo): Promise<SendResult> {
    let home = target;
    if (request.via === 'fork') {
        const copy = await ownCopy(ctx, login);
        if (typeof copy === 'string') return fail(copy);
        home = copy;
    }
    const error = await push(ctx, request, login, [home.cloneUrl, `HEAD:refs/heads/${request.branch}`]);
    if (error) return fail(`${error}. The commit is on the local branch ${request.branch}.`);
    const head = request.via === 'fork' ? `${home.owner}:${request.branch}` : request.branch;
    const pull = await ctx.provider.createPull({ title: request.title.trim(), body: request.body.trim(), head, base: target.defaultBranch });
    return { ok: true, pull, branch: request.branch, message: `Opened pull request #${pull.number}` };
}
