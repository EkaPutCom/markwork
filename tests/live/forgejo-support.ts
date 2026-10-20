// Shared by the tests that run against a real Forgejo or Gitea (tests/live/live-forge.ts): the server, the
// tokens, and the small helpers to talk to it with plain API calls and git. Tokens are never printed.

import { base64, credentialEnv } from '../../src/forge/contribute.js';
import { GiteaProvider } from '../../src/forge/gitea.js';
import { parseRemote } from '../../src/forge/remote.js';
import { runGit } from '../../src/git.js';
import { disk, errorMessage, tmp } from '../core/framework.js';
import { platform } from '../../src/platform/index.js';

export const SERVER_URL = platform().env('FORGEJO_URL') ?? 'http://localhost:3000';
export const REPO = platform().env('FORGEJO_REPO') ?? 'eka/notes';
export const OWNER_TOKEN = platform().env('FORGEJO_TOKEN') ?? '';
export const CONTRIBUTOR_TOKEN = platform().env('FORGEJO_CONTRIBUTOR_TOKEN') ?? '';

export const repo = parseRemote(`${SERVER_URL}/${REPO}.git`)!;
export const owner = new GiteaProvider(repo, OWNER_TOKEN, platform().http);
export const contributor = new GiteaProvider(repo, CONTRIBUTOR_TOKEN, platform().http);
export const stamp = String(Math.floor(Date.now() / 1000));

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function check(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
export const write = (path: string, text: string) => disk.write(path, text);
export const read = (path: string) => disk.read(path);

// The server's own API, for what the forge layer does not offer (editing a file on the base branch, closing a pull request, settings).
export async function api(token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: object): Promise<{ status: number; json: any }> {
    const response = await platform().http({
        method, url: `${SERVER_URL}/api/v1${path}`, headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: response.body ? JSON.parse(response.body) : null };
}

export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
    const run = await runGit(cwd, args, env);
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err.trim()}`);
    return run.out.trim();
}

// A clone of the repository made as the owner of `token`, with that user as the committer.
export async function clone(token: string, name: string): Promise<{ folder: string; login: string }> {
    const login = await new GiteaProvider(repo, token, platform().http).currentUser();
    const folder = disk.join(tmp, name);
    await git(tmp, ['clone', '-q', `${SERVER_URL}/${REPO}.git`, folder], credentialEnv(login, token));
    await git(folder, ['config', 'user.name', login]);
    await git(folder, ['config', 'user.email', `${login}@example.com`]);
    return { folder, login };
}

export async function waitFor<T>(what: string, probe: () => Promise<T | null | false>, seconds = 20): Promise<T> {
    for (let i = 0; i < seconds * 2; i++) {
        const value = await probe();
        if (value) return value;
        await sleep(500);
    }
    throw new Error(`${what} did not happen within ${seconds} seconds`);
}

// Changes the file `path` on the base branch of the repository through the server's API (create or update).
export async function putFile(token: string, path: string, text: string, message: string): Promise<void> {
    const existing = await api(token, 'GET', `/repos/${REPO}/contents/${path}?ref=main`);
    const body = { content: base64(new TextEncoder().encode(text)), message, branch: 'main', ...(existing.status === 200 ? { sha: existing.json.sha } : {}) };
    const done = await api(token, existing.status === 200 ? 'PUT' : 'POST', `/repos/${REPO}/contents/${path}`, body);
    check(done.status === 200 || done.status === 201, `could not write ${path}: HTTP ${done.status} ${errorMessage(done.json?.message ?? '')}`);
}
