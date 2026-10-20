// Tests for sending changes as a pull request: the steps against a fake forge and real local git repositories
// (a bare "upstream", a bare "fork", and a working clone), and the small pure helpers.

import { branchError, credentialEnv, sendChanges, slug, type SendContext, type SendRequest } from '../../src/forge/contribute.js';
import type { ForgeProvider, NewPull, PullRequest, RepoInfo } from '../../src/forge/types.js';
import { runGit } from '../../src/base/git.js';
import { section, test, eq, ok, contains, within, tmp, disk } from '../core/framework.js';
import { host } from '../core/host.js';

const sh = async (cwd: string, ...args: string[]): Promise<string> => {
    const run = await within(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

export async function contributeTests(): Promise<void> {
    section('Sending changes as a pull request');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) host().setenv(name, value);
    const dir = disk.join(tmp, 'contribute');
    const upstream = disk.join(dir, 'upstream.git'), fork = disk.join(dir, 'fork.git');
    disk.mkdirs(upstream);
    disk.mkdirs(fork);
    await sh(upstream, 'init', '-q', '--bare', '-b', 'main');
    await sh(fork, 'init', '-q', '--bare', '-b', 'main');
    await sh(upstream, 'config', 'receive.advertisePushOptions', 'true');   // what a forge with AGit does
    let counter = 0;
    // A fresh working clone with one edited note per test, so the tests do not depend on each other's branches.
    const clone = async (): Promise<{ folder: string; file: string }> => {
        const folder = disk.join(dir, `work-${++counter}`);
        await sh(dir, 'clone', '-q', upstream, folder);
        if (counter === 1) {
            await sh(folder, 'checkout', '-q', '-B', 'main');
            disk.write(disk.join(folder, 'journal.md'), '# Journal\n\nHello\n');
            await sh(folder, 'add', 'journal.md');
            await sh(folder, 'commit', '-q', '-m', 'First');
            await sh(folder, 'push', '-q', 'origin', 'main');
        }
        const file = disk.join(folder, 'journal.md');
        disk.write(file, `# Journal\n\nHello, edited ${counter}\n`);
        return { folder, file };
    };
    await clone();   // seeds upstream (its edit is thrown away with this folder)

    const pulls: NewPull[] = [];
    const calls: string[] = [];
    let forkExists = false, forkIsFork = true, canPush = false;
    const fake: Pick<ForgeProvider, 'currentUser' | 'repoInfo' | 'fork' | 'createPull'> = {
        async currentUser() { return 'eka'; },
        async repoInfo(owner, repo) {
            if (owner === undefined) return { owner: 'team', repo: 'notes', cloneUrl: upstream, defaultBranch: 'main', canPush, isFork: false } satisfies RepoInfo;
            calls.push(`repoInfo ${owner}/${repo}`);
            return forkExists ? { owner: 'eka', repo: 'notes', cloneUrl: fork, defaultBranch: 'main', canPush: true, isFork: forkIsFork } : null;
        },
        async fork() { calls.push('fork'); return { owner: 'eka', repo: 'notes', cloneUrl: fork, defaultBranch: 'main', canPush: true, isFork: true }; },
        async createPull(p) { pulls.push(p); return { number: 7, title: p.title, state: 'open' } as PullRequest; },
    };
    const provider = fake as ForgeProvider;
    const context = (): SendContext => ({ provider, repo: { baseUrl: 'https://git.example.org', host: 'git.example.org', owner: 'team', repo: 'notes' }, token: 'sekret', git: runGit });
    const request = (folder: string, file: string, extra: Partial<SendRequest> = {}): SendRequest =>
        ({ folder, files: [file], title: 'Fix a typo in the journal', body: 'It said “Hallo”.', branch: 'fix-typo', via: 'fork', ...extra });
    const refs = (repo: string) => sh(repo, 'for-each-ref', '--format=%(refname)');

    await test('fork: the user\'s own copy is created, the branch goes there, and the pull request names it', async () => {
        const { folder, file } = await clone();
        const result = await within(sendChanges(context(), request(folder, file)));
        ok(result.ok, `sent: ${!result.ok && result.message}`);
        if (!result.ok) return;
        eq(result.pull?.number, 7);
        eq(pulls[pulls.length - 1], { title: 'Fix a typo in the journal', body: 'It said “Hallo”.', head: 'eka:fix-typo', base: 'main' });
        eq(calls.includes('fork'), true);
        contains(await refs(fork), 'refs/heads/fix-typo');
        ok(!(await refs(upstream)).includes('fix-typo'), 'upstream was not touched');
        eq(await sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix-typo');
        eq(await sh(folder, 'log', '-1', '--format=%s%n%b'), 'Fix a typo in the journal\nIt said “Hallo”.');
    });

    await test('fork: an existing fork is used, not created again', async () => {
        forkExists = true; calls.length = 0;
        const { folder, file } = await clone();
        const result = await within(sendChanges(context(), request(folder, file, { branch: 'second' })));
        ok(result.ok, 'sent');
        eq(calls.includes('fork'), false);
        contains(await refs(fork), 'refs/heads/second');
    });

    await test('fork: a repository of the same name that is not a fork stops before anything is pushed', async () => {
        forkIsFork = false;
        const { folder, file } = await clone();
        const result = await within(sendChanges(context(), request(folder, file, { branch: 'third' })));
        ok(!result.ok && result.message.includes('is not a fork'), 'refused');
        ok(!(await refs(fork)).includes('third'), 'nothing pushed');
        forkIsFork = true;
    });

    await test('direct: the branch goes to the repository itself', async () => {
        canPush = true;
        const { folder, file } = await clone();
        const result = await within(sendChanges(context(), request(folder, file, { via: 'direct', branch: 'direct-branch' })));
        ok(result.ok, 'sent');
        contains(await refs(upstream), 'refs/heads/direct-branch');
        eq(pulls[pulls.length - 1].head, 'direct-branch');
    });

    await test('AGit: the commit goes to refs/for/<base> and no pull request is created here', async () => {
        const before = pulls.length;
        const { folder, file } = await clone();
        const result = await within(sendChanges(context(), request(folder, file, { via: 'agit', branch: 'agit-topic', body: 'Line one\nLine two' })));
        ok(result.ok && result.pull === null, 'sent without a pull object');
        contains(await refs(upstream), 'refs/for/main');
        eq(pulls.length, before);
    });

    await test('a push that fails says so and where the commit is', async () => {
        const { folder, file } = await clone();
        const broken: SendContext = { ...context(), provider: { ...provider, repoInfo: async (o?: string) => (o === undefined ? { owner: 'team', repo: 'notes', cloneUrl: disk.join(dir, 'missing.git'), defaultBranch: 'main', canPush: true, isFork: false } : null) } as ForgeProvider };
        const result = await within(sendChanges(broken, request(folder, file, { via: 'direct', branch: 'lost' })));
        ok(!result.ok, 'failed');
        if (!result.ok) { contains(result.message, 'Could not push'); contains(result.message, 'local branch lost'); }
    });

    await test('a branch that already exists is not overwritten', async () => {
        const { folder, file } = await clone();
        const result = await within(sendChanges(context(), request(folder, file, { branch: 'main' })));
        ok(!result.ok && result.message.includes('Could not create the branch'), 'refused');
    });

    await test('nothing is done for a missing title, no files, or a bad branch name', async () => {
        const { folder, file } = await clone();
        const bad = async (extra: Partial<SendRequest>) => { const r = await within(sendChanges(context(), request(folder, file, extra))); return r.ok ? '' : r.message; };
        contains(await bad({ title: '  ' }), 'title');
        contains(await bad({ files: [] }), 'no changes');
        contains(await bad({ branch: 'has space' }), 'branch');
        eq(await sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    });

    await test('branch names: what git accepts', async () => {
        for (const good of ['fix-typo', 'markwork/fix-typo', 'a.b', 'v2']) eq(branchError(good), null, good);
        for (const bad of ['', '-x', '/x', 'x/', 'x.', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'a//b', '@', 'x.lock']) ok(branchError(bad) !== null, `${JSON.stringify(bad)} is refused`);
    });

    await test('slug: a branch name from a title', async () => {
        eq(slug('Fix the typo in Journal!'), 'fix-the-typo-in-journal');
        eq(slug('  Résumé — café  '), 'resume-cafe');
        eq(slug('!!!'), '');
        eq(slug('a'.repeat(80)).length, 48);
    });

    await test('the token travels in the environment as a Basic header, never in the arguments', async () => {
        const env = credentialEnv('eka', 'sekret');
        eq(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
        eq(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ZWthOnNla3JldA==`);
        const { folder } = await clone();
        ok(!(await sh(folder, 'config', '--list')).includes('Authorization'), 'not written to the git config');
    });

    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) host().setenv(name, null);
}
