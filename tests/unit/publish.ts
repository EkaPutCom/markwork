// Tests for publishing a reviewed branch as a pull request: the steps against a fake forge and real local git repositories
// (a bare "upstream", a bare "fork", and a clone with the branch), and the small pure helpers around it.

import { commitLeftovers, pullFromNotes, pullNote, pullRequestBody, uncommitLeftovers } from '../../src/agent/worktreereview.js';
import type { Worktree } from '../../src/agent/worktree.js';
import type { SendContext } from '../../src/forge/contribute.js';
import { GiteaProvider, isGiteaServer } from '../../src/forge/gitea.js';
import { publishBranch, pushFailure, type PublishRequest } from '../../src/forge/publish.js';
import { forgeKind } from '../../src/forge/remote.js';
import { ForgeError, type ForgeProvider, type NewPull, type PullRequest, type RepoInfo } from '../../src/forge/types.js';
import { runGit } from '../../src/base/git.js';
import { section, test, eq, ok, contains, within, tmp, disk } from '../core/framework.js';
import { host } from '../core/host.js';

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const run = await within(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

export async function publishTests(): Promise<void> {
    section('Publishing a card branch as a pull request');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) host().setenv(name, value);
    const dir = disk.join(tmp, 'publish');
    const upstream = disk.join(dir, 'upstream.git'), fork = disk.join(dir, 'fork.git');
    disk.mkdirs(upstream);
    disk.mkdirs(fork);
    await sh(upstream, 'init', '-q', '--bare', '-b', 'main');
    await sh(fork, 'init', '-q', '--bare', '-b', 'main');
    await sh(upstream, 'config', 'receive.advertisePushOptions', 'true');
    let counter = 0;
    // A clone on a branch of its own with one commit and one file the "agent" left uncommitted.
    const clone = async (): Promise<{ folder: string; branch: string }> => {
        const folder = disk.join(dir, `work-${++counter}`);
        await sh(dir, 'clone', '-q', upstream, folder);
        if (counter === 1) {
            await sh(folder, 'checkout', '-q', '-B', 'main');
            disk.write(disk.join(folder, 'a.md'), 'one\n');
            await sh(folder, 'add', '-A');
            await sh(folder, 'commit', '-q', '-m', 'First');
            await sh(folder, 'push', '-q', 'origin', 'main');
        }
        const branch = `markwork/card-${counter}`;
        await sh(folder, 'checkout', '-q', '-b', branch);
        disk.write(disk.join(folder, 'b.md'), `two ${counter}\n`);
        await sh(folder, 'add', '-A');
        await sh(folder, 'commit', '-q', '-m', 'Add b');
        return { folder, branch };
    };
    await clone();   // seeds upstream

    const pulls: NewPull[] = [];
    let canPush = true, forkExists = false, open: PullRequest[] = [], createFails: Error | null = null;
    const fake: Pick<ForgeProvider, 'currentUser' | 'repoInfo' | 'fork' | 'createPull' | 'listPulls'> = {
        async currentUser() { return 'eka'; },
        async repoInfo(owner) {
            if (owner === undefined) return { owner: 'team', repo: 'notes', cloneUrl: upstream, defaultBranch: 'main', canPush, isFork: false } satisfies RepoInfo;
            return forkExists ? { owner: 'eka', repo: 'notes', cloneUrl: fork, defaultBranch: 'main', canPush: true, isFork: true } : null;
        },
        async fork() { forkExists = true; return { owner: 'eka', repo: 'notes', cloneUrl: fork, defaultBranch: 'main', canPush: true, isFork: true }; },
        async listPulls() { return open; },
        async createPull(p) { if (createFails) throw createFails; pulls.push(p); return { number: 7, title: p.title, state: 'open', url: 'https://forge.example.org/team/notes/pulls/7' } as PullRequest; },
    };
    const context = (): SendContext => ({ provider: fake as ForgeProvider, repo: { baseUrl: 'https://forge.example.org', host: 'forge.example.org', owner: 'team', repo: 'notes' }, token: 'sekret', git: runGit });
    const request = (folder: string, branch: string, extra: Partial<PublishRequest> = {}): PublishRequest =>
        ({ cwd: folder, branch, base: 'main', title: 'Add b', body: 'Adds b.', via: 'direct', ...extra });
    const refs = (repo: string) => sh(repo, 'for-each-ref', '--format=%(refname)');

    await test('direct: the branch is pushed as it is and the pull request names it and the base', async () => {
        const { folder, branch } = await clone();
        const head = await sh(folder, 'rev-parse', 'HEAD');
        const result = await within(publishBranch(context(), request(folder, branch)));
        ok(result.ok, `sent: ${!result.ok && result.message}`);
        if (!result.ok) return;
        eq(result.pull?.number, 7);
        eq(pulls[pulls.length - 1], { title: 'Add b', body: 'Adds b.', head: branch, base: 'main' });
        eq(await sh(upstream, 'rev-parse', `refs/heads/${branch}`), head, 'the very commit the user reviewed');
        eq(await sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'the worktree is left where it was');
        ok(!disk.read(disk.join(folder, '.git', 'config')).includes('sekret'), 'the token is not in the repository config');
    });

    await test('direct: a token that may not push is told so before anything is pushed', async () => {
        canPush = false;
        const { folder, branch } = await clone();
        const result = await within(publishBranch(context(), request(folder, branch)));
        ok(!result.ok, 'refused');
        if (!result.ok) { contains(result.message, 'may not push'); eq(result.pushed, false); }
        ok(!(await refs(upstream)).includes(branch), 'nothing was pushed');
        canPush = true;
    });

    await test('direct: a branch that exists on the server with other commits is not overwritten', async () => {
        const { folder, branch } = await clone();
        const tree = await sh(upstream, 'rev-parse', 'main^{tree}');
        await sh(upstream, 'update-ref', `refs/heads/${branch}`, await sh(upstream, 'commit-tree', tree, '-m', 'Somebody else'));
        const before = await sh(upstream, 'rev-parse', `refs/heads/${branch}`);
        const count = pulls.length;
        const result = await within(publishBranch(context(), request(folder, branch)));
        ok(!result.ok, 'refused');
        if (!result.ok) { contains(result.message, `the branch ${branch} already exists on the server`); eq(result.pushed, false); }
        eq(await sh(upstream, 'rev-parse', `refs/heads/${branch}`), before);
        eq(pulls.length, count, 'no pull request');
    });

    await test('direct: a pull request that is already open for the branch is reported, and nothing is pushed', async () => {
        const { folder, branch } = await clone();
        open = [{ number: 3, headRef: branch, url: 'https://forge.example.org/team/notes/pulls/3' } as PullRequest];
        const result = await within(publishBranch(context(), request(folder, branch)));
        ok(!result.ok, 'refused');
        if (!result.ok) contains(result.message, `Pull request #3 is already open for ${branch}: https://forge.example.org/team/notes/pulls/3`);
        ok(!(await refs(upstream)).includes(branch), 'nothing was pushed');
        open = [];
    });

    await test('direct: when the pull request cannot be opened the branch is still pushed, and the message says so', async () => {
        const { folder, branch } = await clone();
        createFails = new ForgeError('server', 'forge.example.org answered HTTP 422: pull request already exists for these targets', 422);
        const result = await within(publishBranch(context(), request(folder, branch)));
        createFails = null;
        ok(!result.ok, 'failed');
        if (!result.ok) { eq(result.pushed, true); contains(result.message, `The branch ${branch} was pushed, but the pull request was not opened`); contains(result.message, 'may already exist'); }
        contains(await refs(upstream), `refs/heads/${branch}`);
    });

    await test('fork: the branch goes to the user\'s own copy and the pull request names it', async () => {
        const { folder, branch } = await clone();
        const result = await within(publishBranch(context(), request(folder, branch, { via: 'fork' })));
        ok(result.ok, `sent: ${!result.ok && result.message}`);
        contains(await refs(fork), `refs/heads/${branch}`);
        ok(!(await refs(upstream)).includes(branch), 'upstream was not touched');
        eq(pulls[pulls.length - 1].head, `eka:${branch}`);
    });

    await test('AGit: the branch goes to refs/for/<base> and no pull request is created here', async () => {
        const { folder, branch } = await clone();
        const count = pulls.length;
        const result = await within(publishBranch(context(), request(folder, branch, { via: 'agit', body: 'Line one\nLine two' })));
        ok(result.ok && result.pull === null, 'sent without a pull object');
        contains(await refs(upstream), 'refs/for/main');
        eq(pulls.length, count);
    });

    await test('a server that cannot be reached from where the repository is says so', async () => {
        const { folder, branch } = await clone();
        const broken: SendContext = { ...context(), provider: { ...fake, repoInfo: async (o?: string) => (o === undefined ? { owner: 'team', repo: 'notes', cloneUrl: disk.join(dir, 'missing.git'), defaultBranch: 'main', canPush: true, isFork: false } : null) } as ForgeProvider };
        const result = await within(publishBranch(broken, request(folder, branch)));
        ok(!result.ok, 'failed');
        if (!result.ok) contains(result.message, 'Could not push');
    });

    await test('nothing is done for a missing title or a bad branch name', async () => {
        const { folder, branch } = await clone();
        const bad = async (extra: Partial<PublishRequest>) => { const r = await within(publishBranch(context(), request(folder, branch, extra))); return r.ok ? '' : r.message; };
        contains(await bad({ title: '  ' }), 'title');
        contains(await bad({ branch: 'has space' }), 'branch');
    });

    await test('a failed push is told in words: rejected, refused token, no right, no variables on the daemon', async () => {
        const run = (err: string) => ({ status: 1, out: '', err });
        contains(pushFailure(run('! [rejected] x -> x (non-fast-forward)'), 'x'), 'already exists on the server');
        contains(pushFailure(run("fatal: unable to access 'https://h/r.git/': The requested URL returned error: 401"), 'x'), 'refused the access token');
        contains(pushFailure(run("remote: User permission denied for writing.\nfatal: unable to access 'https://h/r.git/': The requested URL returned error: 403"), 'x'), 'may not push');
        contains(pushFailure(run('environment variable "GIT_CONFIG_COUNT" is not allowed'), 'x'), 'env_allow');
        contains(pushFailure(run("fatal: unable to access 'https://h/r.git/': Could not resolve host: h"), 'x'), 'cannot be reached');
        eq(pushFailure(run('fatal: something odd\nmore'), 'x'), 'fatal: something odd');
        eq(pushFailure(null, 'x'), 'git could not be run');
    });

    await test('the hosts that are not Forgejo or Gitea are known by name', async () => {
        eq(['github.com', 'www.github.com', 'GitHub.com:443', 'gitlab.com', 'codeberg.org', 'git.example.org:3000', 'notgithub.com'].map(forgeKind), ['github', 'github', 'github', 'gitlab', 'gitea', 'gitea', 'gitea']);
    });

    await test('a Forgejo or Gitea server is told from other servers by its version endpoint', async () => {
        const repo = { baseUrl: 'https://forge.example.org', host: 'forge.example.org', owner: 'a', repo: 'b' };
        const seen: string[] = [];
        const server = (status: number, body: string) => async (r: { url: string; headers?: Record<string, string> }) => { seen.push(`${r.url} ${r.headers?.Authorization ?? ''}`); return { status, body }; };
        eq(await within(isGiteaServer(repo, 'tok', server(200, '{"version":"11.0.0"}'))), true);
        eq(seen, ['https://forge.example.org/api/v1/version token tok']);
        eq(await within(isGiteaServer(repo, '', server(200, '{"version":"1.22"}'))), true);
        eq(await within(isGiteaServer(repo, '', server(403, '{"message":"sign in required"}'))), true, 'a server that wants a sign-in even there');
        eq(await within(isGiteaServer(repo, '', server(404, '<html>Not found</html>'))), false);
        eq(await within(isGiteaServer(repo, '', server(200, '{"x":1}'))), false);
        eq(await within(isGiteaServer(repo, '', async () => { throw new Error('offline'); })), false);
    });

    await test('a Gitea provider created for the review works with the same transport', async () => {
        const provider = new GiteaProvider({ baseUrl: 'https://forge.example.org', host: 'forge.example.org', owner: 'team', repo: 'notes' }, 't', async () => ({ status: 200, body: '{"login":"eka"}' }));
        eq(await within(provider.currentUser()), 'eka');
    });

    await test('what the agent left uncommitted becomes a commit, and can be taken back', async () => {
        const { folder, branch } = await clone();
        const wt = { path: folder, repo: folder, branch, base: 'main' } as Worktree;
        eq((await within(commitLeftovers(runGit, wt, 'Card'))), { ok: true, value: false }, 'nothing to commit');
        disk.write(disk.join(folder, 'c.md'), 'left\n');
        disk.write(disk.join(folder, 'b.md'), 'changed\n');
        const before = await sh(folder, 'rev-parse', 'HEAD');
        eq((await within(commitLeftovers(runGit, wt, 'Card'))), { ok: true, value: true });
        eq(await sh(folder, 'log', '-1', '--format=%s'), 'Card (uncommitted work)');
        eq(await sh(folder, 'status', '--porcelain'), '');
        await within(uncommitLeftovers(runGit, wt));
        eq(await sh(folder, 'rev-parse', 'HEAD'), before, 'the commit is gone');
        eq(disk.read(disk.join(folder, 'b.md')), 'changed\n', 'and the files are as they were');
        contains(await sh(folder, 'status', '--porcelain'), 'c.md');
    });

    await test('the description starts from what the agent said and the commits, and the card remembers the pull request', async () => {
        eq(pullRequestBody('Added QRIS.\n', [{ hash: 'a1', subject: 'Add QRIS' }, { hash: 'b2', subject: 'Fix tests' }], true),
            'Added QRIS.\n\nCommits:\n- Add QRIS\n- Fix tests\n- Changes the agent did not commit');
        eq(pullRequestBody('', [], false), '');
        eq(pullRequestBody('', [{ hash: 'a1', subject: 'Only' }], false), 'Commits:\n- Only');
        ok(pullRequestBody('x'.repeat(9000), [], false).length <= 4000, 'a long summary is cut');
        const note = pullNote(7, 'https://forge.example.org/team/notes/pulls/7', '18/10 20:21');
        eq(note, '↳ pull request #7 opened 18/10 20:21: https://forge.example.org/team/notes/pulls/7');
        eq(pullFromNotes(['Use the SDK.', '↳ pi done 18/10 20:00: finished', note]), { number: 7, url: 'https://forge.example.org/team/notes/pulls/7' });
        eq(pullFromNotes(['↳ pi done 18/10 20:00: a pull request #3 opened 1: http://x']), null, 'only Markwork\'s own note counts');
        eq(pullFromNotes([]), null);
    });
}
