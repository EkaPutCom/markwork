// Tests for sending changes as a pull request: the steps against a fake forge and real local git repositories
// (a bare "upstream", a bare "fork", and a working clone), and the small pure helpers.

import GLib from 'gi://GLib';
import { branchError, credentialEnv, sendChanges, slug, type SendContext, type SendRequest } from '../../src/forge/contribute.js';
import type { ForgeProvider, NewPull, PullRequest, RepoInfo } from '../../src/forge/types.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, contains, settle, tmp } from '../framework.js';

const sh = (cwd: string, ...args: string[]): string => {
    const run = settle(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

export function contributeTests(): void {
    section('Sending changes as a pull request');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) GLib.setenv(name, value, true);
    const dir = GLib.build_filenamev([tmp, 'contribute']);
    const upstream = GLib.build_filenamev([dir, 'upstream.git']), fork = GLib.build_filenamev([dir, 'fork.git']);
    GLib.mkdir_with_parents(upstream, 0o755);
    GLib.mkdir_with_parents(fork, 0o755);
    sh(upstream, 'init', '-q', '--bare', '-b', 'main');
    sh(fork, 'init', '-q', '--bare', '-b', 'main');
    sh(upstream, 'config', 'receive.advertisePushOptions', 'true');   // what a forge with AGit does
    let counter = 0;
    // A fresh working clone with one edited note per test, so the tests do not depend on each other's branches.
    const clone = (): { folder: string; file: string } => {
        const folder = GLib.build_filenamev([dir, `work-${++counter}`]);
        sh(dir, 'clone', '-q', upstream, folder);
        if (counter === 1) {
            sh(folder, 'checkout', '-q', '-B', 'main');
            GLib.file_set_contents(GLib.build_filenamev([folder, 'journal.md']), '# Journal\n\nHello\n');
            sh(folder, 'add', 'journal.md');
            sh(folder, 'commit', '-q', '-m', 'First');
            sh(folder, 'push', '-q', 'origin', 'main');
        }
        const file = GLib.build_filenamev([folder, 'journal.md']);
        GLib.file_set_contents(file, `# Journal\n\nHello, edited ${counter}\n`);
        return { folder, file };
    };
    clone();   // seeds upstream (its edit is thrown away with this folder)

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

    test('fork: the user\'s own copy is created, the branch goes there, and the pull request names it', () => {
        const { folder, file } = clone();
        const result = settle(sendChanges(context(), request(folder, file)));
        ok(result.ok, `sent: ${!result.ok && result.message}`);
        if (!result.ok) return;
        eq(result.pull?.number, 7);
        eq(pulls[pulls.length - 1], { title: 'Fix a typo in the journal', body: 'It said “Hallo”.', head: 'eka:fix-typo', base: 'main' });
        eq(calls.includes('fork'), true);
        contains(refs(fork), 'refs/heads/fix-typo');
        ok(!refs(upstream).includes('fix-typo'), 'upstream was not touched');
        eq(sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix-typo');
        eq(sh(folder, 'log', '-1', '--format=%s%n%b'), 'Fix a typo in the journal\nIt said “Hallo”.');
    });

    test('fork: an existing fork is used, not created again', () => {
        forkExists = true; calls.length = 0;
        const { folder, file } = clone();
        const result = settle(sendChanges(context(), request(folder, file, { branch: 'second' })));
        ok(result.ok, 'sent');
        eq(calls.includes('fork'), false);
        contains(refs(fork), 'refs/heads/second');
    });

    test('fork: a repository of the same name that is not a fork stops before anything is pushed', () => {
        forkIsFork = false;
        const { folder, file } = clone();
        const result = settle(sendChanges(context(), request(folder, file, { branch: 'third' })));
        ok(!result.ok && result.message.includes('is not a fork'), 'refused');
        ok(!refs(fork).includes('third'), 'nothing pushed');
        forkIsFork = true;
    });

    test('direct: the branch goes to the repository itself', () => {
        canPush = true;
        const { folder, file } = clone();
        const result = settle(sendChanges(context(), request(folder, file, { via: 'direct', branch: 'direct-branch' })));
        ok(result.ok, 'sent');
        contains(refs(upstream), 'refs/heads/direct-branch');
        eq(pulls[pulls.length - 1].head, 'direct-branch');
    });

    test('AGit: the commit goes to refs/for/<base> and no pull request is created here', () => {
        const before = pulls.length;
        const { folder, file } = clone();
        const result = settle(sendChanges(context(), request(folder, file, { via: 'agit', branch: 'agit-topic', body: 'Line one\nLine two' })));
        ok(result.ok && result.pull === null, 'sent without a pull object');
        contains(refs(upstream), 'refs/for/main');
        eq(pulls.length, before);
    });

    test('a push that fails says so and where the commit is', () => {
        const { folder, file } = clone();
        const broken: SendContext = { ...context(), provider: { ...provider, repoInfo: async (o?: string) => (o === undefined ? { owner: 'team', repo: 'notes', cloneUrl: GLib.build_filenamev([dir, 'missing.git']), defaultBranch: 'main', canPush: true, isFork: false } : null) } as ForgeProvider };
        const result = settle(sendChanges(broken, request(folder, file, { via: 'direct', branch: 'lost' })));
        ok(!result.ok, 'failed');
        if (!result.ok) { contains(result.message, 'Could not push'); contains(result.message, 'local branch lost'); }
    });

    test('a branch that already exists is not overwritten', () => {
        const { folder, file } = clone();
        const result = settle(sendChanges(context(), request(folder, file, { branch: 'main' })));
        ok(!result.ok && result.message.includes('Could not create the branch'), 'refused');
    });

    test('nothing is done for a missing title, no files, or a bad branch name', () => {
        const { folder, file } = clone();
        const bad = (extra: Partial<SendRequest>) => { const r = settle(sendChanges(context(), request(folder, file, extra))); return r.ok ? '' : r.message; };
        contains(bad({ title: '  ' }), 'title');
        contains(bad({ files: [] }), 'no changes');
        contains(bad({ branch: 'has space' }), 'branch');
        eq(sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    });

    test('branch names: what git accepts', () => {
        for (const good of ['fix-typo', 'markwork/fix-typo', 'a.b', 'v2']) eq(branchError(good), null, good);
        for (const bad of ['', '-x', '/x', 'x/', 'x.', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'a//b', '@', 'x.lock']) ok(branchError(bad) !== null, `${JSON.stringify(bad)} is refused`);
    });

    test('slug: a branch name from a title', () => {
        eq(slug('Fix the typo in Journal!'), 'fix-the-typo-in-journal');
        eq(slug('  Résumé — café  '), 'resume-cafe');
        eq(slug('!!!'), '');
        eq(slug('a'.repeat(80)).length, 48);
    });

    test('the token travels in the environment as a Basic header, never in the arguments', () => {
        const env = credentialEnv('eka', 'sekret');
        eq(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
        eq(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${GLib.base64_encode(new TextEncoder().encode('eka:sekret'))}`);
        const { folder } = clone();
        ok(!sh(folder, 'config', '--list').includes('Authorization'), 'not written to the git config');
    });

    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) GLib.unsetenv(name);
}
