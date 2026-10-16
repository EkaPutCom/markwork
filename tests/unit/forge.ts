// Forge layer tests: remote URL parsing, the Forgejo/Gitea client against a fake Transport, the polling monitor, and the platform's
// HTTP transport against a fake server on 127.0.0.1. No real network.

import { GiteaProvider } from '../../src/forge/gitea.js';
import { platform } from '../../src/platform/index.js';
import { diffPulls, PullMonitor } from '../../src/forge/monitor.js';
import { parseRemote } from '../../src/forge/remote.js';
import { ForgeError, type HttpRequest, type HttpResponse, type PullRequest, type RepoRef, type Transport } from '../../src/forge/types.js';
import { section, test, eq, ok, contains, within } from '../framework.js';
import { host } from '../host.js';

const REPO: RepoRef = { baseUrl: 'https://git.example.org', host: 'git.example.org', owner: 'eka', repo: 'notes' };

const apiPull = (n: number, extra: object = {}) => ({
    number: n, title: `PR ${n}`, state: 'open', merged: false, mergeable: true, user: { login: 'budi' },
    head: { ref: 'feature' }, base: { ref: 'main' }, comments: 2, created_at: '2026-10-12T01:00:00Z', updated_at: '2026-10-12T02:00:00Z',
    html_url: `https://git.example.org/eka/notes/pulls/${n}`, ...extra,
});

// A fake forge: records the requests and answers from a table of "METHOD path" → response.
function fakeForge(answers: Record<string, HttpResponse | (() => HttpResponse)>) {
    const seen: HttpRequest[] = [];
    const transport: Transport = async request => {
        seen.push(request);
        const key = `${request.method} ${request.url.replace('https://git.example.org/api/v1/repos/eka/notes', '')}`;
        const answer = answers[key];
        if (!answer) return { status: 404, body: '{"message":"no such route in the fake"}' };
        return typeof answer === 'function' ? answer() : answer;
    };
    return { seen, transport };
}
const json = (status: number, value: unknown): HttpResponse => ({ status, body: JSON.stringify(value) });
const pull = (n: number, extra: Partial<PullRequest> = {}): PullRequest => ({
    number: n, title: `PR ${n}`, author: 'budi', state: 'open', mergeable: true, headRef: 'f', baseRef: 'main', headSha: 'h1', baseSha: 'b1', body: '', comments: 0,
    createdAt: '2026-10-12T01:00:00Z', updatedAt: '2026-10-12T02:00:00Z', url: '', ...extra,
});
const failure = async (promise: Promise<unknown>): Promise<ForgeError> => {
    try { await within(promise); } catch (e) { if (e instanceof ForgeError) return e; throw e; }
    throw new Error('should have failed');
};

export async function forgeTests(): Promise<void> {
    section('Forge: remote URLs');
    await test('https remote, with and without .git', async () => {
        eq(parseRemote('https://git.example.org/eka/notes.git'), REPO);
        eq(parseRemote('https://git.example.org/eka/notes'), REPO);
    });
    await test('credentials and a port in the URL', async () => {
        eq(parseRemote('https://eka:secret@git.example.org:3000/eka/notes.git'), { ...REPO, host: 'git.example.org:3000', baseUrl: 'https://git.example.org:3000' });
    });
    await test('ssh remotes map to https on the same host', async () => {
        eq(parseRemote('git@git.example.org:eka/notes.git'), REPO);
        eq(parseRemote('ssh://git@git.example.org:2222/eka/notes.git'), REPO);
    });
    await test('a forge below a path keeps the prefix', async () => {
        eq(parseRemote('https://example.org/git/eka/notes.git')?.baseUrl, 'https://example.org/git');
    });
    await test('things that are not a remote give null', async () => {
        eq(parseRemote(''), null);
        eq(parseRemote('/home/eka/notes'), null);
        eq(parseRemote('https://git.example.org/notes'), null);
    });

    section('Forge: Forgejo/Gitea client');
    await test('listPulls reads the open pull requests and sends the token', async () => {
        const forge = fakeForge({ 'GET /pulls?state=open&limit=50&page=1': json(200, [apiPull(42), apiPull(41, { mergeable: false, merged: false })]) });
        const pulls = await within(new GiteaProvider(REPO, 'tok', forge.transport).listPulls('open'));
        eq(pulls.map(p => [p.number, p.author, p.state, p.mergeable, p.headRef, p.comments]), [[42, 'budi', 'open', true, 'feature', 2], [41, 'budi', 'open', false, 'feature', 2]]);
        eq(forge.seen[0].headers?.Authorization, 'token tok');
    });
    await test('a merged pull request is told apart from a closed one', async () => {
        const forge = fakeForge({ 'GET /pulls?state=closed&limit=50&page=1': json(200, [apiPull(1, { state: 'closed', merged: true }), apiPull(2, { state: 'closed' })]) });
        eq((await within(new GiteaProvider(REPO, 't', forge.transport).listPulls('closed'))).map(p => p.state), ['merged', 'closed']);
    });
    await test('mergeable that the forge has not computed yet is null', async () => {
        const forge = fakeForge({ 'GET /pulls/7': json(200, apiPull(7, { mergeable: undefined })) });
        eq((await within(new GiteaProvider(REPO, 't', forge.transport).getPull(7))).mergeable, null);
    });
    await test('listPulls follows pages until one is short', async () => {
        const full = Array.from({ length: 50 }, (_, i) => apiPull(i + 1));
        const forge = fakeForge({
            'GET /pulls?state=open&limit=50&page=1': json(200, full),
            'GET /pulls?state=open&limit=50&page=2': json(200, [apiPull(51)]),
        });
        eq((await within(new GiteaProvider(REPO, 't', forge.transport).listPulls('open'))).length, 51);
        eq(forge.seen.length, 2);
    });
    await test('getFiles maps statuses, renames, and counts', async () => {
        const forge = fakeForge({ 'GET /pulls/42/files?limit=50&page=1': json(200, [
            { filename: 'a.md', status: 'modified', additions: 3, deletions: 1 },
            { filename: 'b.md', status: 'added', additions: 5, deletions: 0 },
            { filename: 'c.md', previous_filename: 'old.md', status: 'renamed' },
            { filename: 'd.md', status: 'removed', deletions: 9 },
        ]) });
        eq(await within(new GiteaProvider(REPO, 't', forge.transport).getFiles(42)), [
            { path: 'a.md', status: 'modified', additions: 3, deletions: 1 },
            { path: 'b.md', status: 'added', additions: 5, deletions: 0 },
            { path: 'c.md', previousPath: 'old.md', status: 'renamed', additions: 0, deletions: 0 },
            { path: 'd.md', status: 'deleted', additions: 0, deletions: 9 },
        ]);
    });
    await test('getDiff asks for plain text and returns it as it is', async () => {
        const forge = fakeForge({ 'GET /pulls/42.diff': { status: 200, body: 'diff --git a/x b/x\n' } });
        eq(await within(new GiteaProvider(REPO, 't', forge.transport).getDiff(42)), 'diff --git a/x b/x\n');
        eq(forge.seen[0].headers?.Accept, 'text/plain');
    });
    await test('getContent reads a file at a commit, escapes the path, and gives null when it is not there', async () => {
        const forge = fakeForge({ 'GET /raw/agenda/rapat%20a.md?ref=abc123': { status: 200, body: '# Rapat\n' } });
        const gitea = new GiteaProvider(REPO, 't', forge.transport);
        eq(await within(gitea.getContent('agenda/rapat a.md', 'abc123')), '# Rapat\n');
        eq(await within(gitea.getContent('agenda/missing.md', 'abc123')), null);
    });
    await test('the head and base commits of a pull request are read', async () => {
        const forge = fakeForge({ 'GET /pulls/9': json(200, apiPull(9, { head: { ref: 'f', sha: 'h9' }, base: { ref: 'main', sha: 'b9' } })) });
        const p = await within(new GiteaProvider(REPO, 't', forge.transport).getPull(9));
        eq([p.headSha, p.baseSha], ['h9', 'b9']);
    });
    await test('the description and the discussion of a pull request are read', async () => {
        const forge = fakeForge({
            'GET /pulls/9': json(200, apiPull(9, { body: 'Adds the calendar layout.' })),
            'GET /issues/9/comments': json(200, [{ id: 1, body: 'Looks good', user: { login: 'sari' }, created_at: '2026-10-12T03:00:00Z' }, { id: 2 }]),
        });
        const gitea = new GiteaProvider(REPO, 't', forge.transport);
        eq((await within(gitea.getPull(9))).body, 'Adds the calendar layout.');
        eq(await within(gitea.listComments(9)), [{ id: 1, author: 'sari', body: 'Looks good', createdAt: '2026-10-12T03:00:00Z' }, { id: 2, author: '', body: '', createdAt: '' }]);
    });
    await test('a comment is posted as JSON and comes back', async () => {
        const forge = fakeForge({ 'POST /issues/9/comments': json(201, { id: 7, body: 'Thanks!', user: { login: 'eka' }, created_at: '2026-10-12T04:00:00Z' }) });
        const comment = await within(new GiteaProvider(REPO, 't', forge.transport).addComment(9, 'Thanks!'));
        eq(JSON.parse(forge.seen[0].body ?? '{}'), { body: 'Thanks!' });
        eq([comment.id, comment.author, comment.body], [7, 'eka', 'Thanks!']);
    });
    await test('markMerged records a merge made outside the forge, with the commit that was pushed', async () => {
        const forge = fakeForge({ 'POST /pulls/9/merge': { status: 200, body: '' } });
        await within(new GiteaProvider(REPO, 't', forge.transport).markMerged(9, 'abc123'));
        eq(JSON.parse(forge.seen[0].body ?? '{}'), { Do: 'manually-merged', MergeCommitID: 'abc123' });
        const refused = fakeForge({ 'POST /pulls/9/merge': json(405, { message: 'manually-merged is not an allowed merge style for this repository' }) });
        eq((await failure(new GiteaProvider(REPO, 't', refused.transport).markMerged(9, 'abc123'))).failure, 'not-mergeable');
    });
    await test('merge posts the chosen method', async () => {
        const forge = fakeForge({ 'POST /pulls/42/merge': { status: 200, body: '' } });
        await within(new GiteaProvider(REPO, 't', forge.transport).merge(42, 'squash'));
        eq(JSON.parse(forge.seen[0].body ?? '{}'), { Do: 'squash' });
        eq(forge.seen[0].headers?.['Content-Type'], 'application/json');
    });
    await test('HTTP errors become the failure the interface can act on', async () => {
        const forge = fakeForge({
            'GET /pulls/1': json(401, { message: 'token is invalid' }),
            'GET /pulls/2': json(404, {}),
            'POST /pulls/3/merge': json(405, { message: 'Please try again later' }),
            'POST /pulls/4/merge': json(409, { message: 'merge conflict' }),
            'GET /pulls/5': { status: 502, body: '<html>bad gateway</html>' },
        });
        const gitea = new GiteaProvider(REPO, 't', forge.transport);
        const auth = await failure(gitea.getPull(1));
        eq(auth.failure, 'auth');
        contains(auth.message, 'token is invalid');
        eq((await failure(gitea.getPull(2))).failure, 'not-found');
        eq((await failure(gitea.merge(3, 'merge'))).failure, 'not-mergeable');
        contains((await failure(gitea.merge(4, 'merge'))).message, 'merge conflict');
        eq((await failure(gitea.getPull(5))).failure, 'server');
    });
    await test('a server that explains itself over many lines is reported with its first line', async () => {
        const forge = fakeForge({ 'GET /pulls/1': json(401, { message: 'token is malformed: invalid number of segments\naccess token does not exist [sha: x]\nauthorized integration: parse JWT error' }) });
        const error = await failure(new GiteaProvider(REPO, 't', forge.transport).getPull(1));
        contains(error.message, 'token is malformed: invalid number of segments');
        ok(!error.message.includes('\n') && !error.message.includes('access token does not exist'), 'only the first line');
    });
    await test('no token fails before any request', async () => {
        const forge = fakeForge({});
        eq((await failure(new GiteaProvider(REPO, '', forge.transport).listPulls('open'))).failure, 'auth');
        eq(forge.seen.length, 0);
    });
    await test('a transport that throws is a network failure; a body that is not JSON is a server failure', async () => {
        const down: Transport = async () => { throw new Error('Connection refused'); };
        const net = await failure(new GiteaProvider(REPO, 't', down).getPull(1));
        eq(net.failure, 'network');
        contains(net.message, 'Connection refused');
        const html = fakeForge({ 'GET /pulls/1': { status: 200, body: '<html>login</html>' } });
        eq((await failure(new GiteaProvider(REPO, 't', html.transport).getPull(1))).failure, 'server');
    });

    section('Forge: monitor');
    await test('diffPulls: opened, updated, closed, and nothing when nothing changed', async () => {
        const before = [pull(1), pull(2), pull(3)];
        const after = [pull(1), pull(2, { updatedAt: '2026-10-12T05:00:00Z' }), pull(4)];
        eq(diffPulls(before, after).map(e => [e.kind, e.pull.number]), [['updated', 2], ['opened', 4], ['closed', 3]]);
        eq(diffPulls(before, before), []);
    });
    await test('a pull request that becomes mergeable or is renamed counts as updated', async () => {
        eq(diffPulls([pull(1, { mergeable: null })], [pull(1, { mergeable: true })]).map(e => e.kind), ['updated']);
        eq(diffPulls([pull(1)], [pull(1, { title: 'New title' })]).map(e => e.kind), ['updated']);
    });
    await test('the first poll is a baseline: no events for what was already open', async () => {
        let open = [pull(1), pull(2)];
        const monitor = new PullMonitor({ listPulls: async () => open } as never);
        const seen: string[][] = [];
        monitor.onChange = (pulls, events) => seen.push([String(pulls.length), ...events.map(e => `${e.kind}#${e.pull.number}`)]);
        await within(monitor.poll());
        eq(seen, [['2']]);
        await within(monitor.poll());
        eq(seen.length, 1);              // nothing changed: no callback
        open = [pull(1), pull(2), pull(3)];
        await within(monitor.poll());
        eq(seen[1], ['3', 'opened#3']);
        eq(monitor.pulls.length, 3);
    });
    await test('an error keeps the last known list and is reported once per round', async () => {
        let fail = false;
        const monitor = new PullMonitor({ listPulls: async () => { if (fail) throw new ForgeError('network', 'down'); return [pull(1)]; } } as never);
        const errors: string[] = [];
        monitor.onError = e => errors.push(e.failure);
        await within(monitor.poll());
        fail = true;
        await within(monitor.poll());
        eq(errors, ['network']);
        eq(monitor.pulls.length, 1);
    });
    await test('a poll that is still running is not started twice', async () => {
        let calls = 0;
        const monitor = new PullMonitor({ listPulls: async () => { calls++; return [pull(1)]; } } as never);
        await within(Promise.all([monitor.poll(), monitor.poll()]));
        eq(calls, 1);
    });

    section('Forge: the platform HTTP transport (fake server)');
    // Earlier unit tests run without a main loop and can leave GC pending; a Soup callback that arrives at that time is blocked by GJS.
    host().gc();
    const received: { method: string; auth: string | undefined; contentType: string | undefined; body: string }[] = [];
    const server = await host().serve((request, reply) => {
        received.push({ method: request.method, auth: request.headers.authorization, contentType: request.headers['content-type'], body: request.body });
        reply.status(201);
        reply.write('{"ok":true}');
        reply.end();
    });
    const http = platform().http;
    await test('sends method, headers, and body, and reads status and text', async () => {
        const answer = await within(http({ method: 'POST', url: `http://127.0.0.1:${server.port}/echo`, headers: { Authorization: 'token x', 'Content-Type': 'application/json' }, body: '{"Do":"merge"}' }));
        eq(answer, { status: 201, body: '{"ok":true}' });
        eq(received[0], { method: 'POST', auth: 'token x', contentType: 'application/json', body: '{"Do":"merge"}' });
    });
    await test('a server that is not there rejects (so the client reports a network failure)', async () => {
        const dead = await failure(new GiteaProvider({ ...REPO, baseUrl: 'http://127.0.0.1:1' }, 't', http).getPull(1));
        eq(dead.failure, 'network');
    });
    ok(server.port > 0, 'server listening');
    server.close();
}
