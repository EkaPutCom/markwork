// Forge layer tests: remote URL parsing, the Forgejo/Gitea client against a fake Transport, the polling monitor, and the libsoup
// transport against a fake server on 127.0.0.1. No real network.

import Soup from 'gi://Soup?version=3.0';
import System from 'system';
import { GiteaProvider } from '../../src/forge/gitea.js';
import { soupTransport } from '../../src/forge/http.js';
import { diffPulls, PullMonitor } from '../../src/forge/monitor.js';
import { parseRemote } from '../../src/forge/remote.js';
import { ForgeError, type HttpRequest, type HttpResponse, type PullRequest, type RepoRef, type Transport } from '../../src/forge/types.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

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
const failure = (promise: Promise<unknown>): ForgeError => {
    try { settle(promise); } catch (e) { if (e instanceof ForgeError) return e; throw e; }
    throw new Error('should have failed');
};

export function forgeTests(): void {
    section('Forge: remote URLs');
    test('https remote, with and without .git', () => {
        eq(parseRemote('https://git.example.org/eka/notes.git'), REPO);
        eq(parseRemote('https://git.example.org/eka/notes'), REPO);
    });
    test('credentials and a port in the URL', () => {
        eq(parseRemote('https://eka:secret@git.example.org:3000/eka/notes.git'), { ...REPO, host: 'git.example.org:3000', baseUrl: 'https://git.example.org:3000' });
    });
    test('ssh remotes map to https on the same host', () => {
        eq(parseRemote('git@git.example.org:eka/notes.git'), REPO);
        eq(parseRemote('ssh://git@git.example.org:2222/eka/notes.git'), REPO);
    });
    test('a forge below a path keeps the prefix', () => {
        eq(parseRemote('https://example.org/git/eka/notes.git')?.baseUrl, 'https://example.org/git');
    });
    test('things that are not a remote give null', () => {
        eq(parseRemote(''), null);
        eq(parseRemote('/home/eka/notes'), null);
        eq(parseRemote('https://git.example.org/notes'), null);
    });

    section('Forge: Forgejo/Gitea client');
    test('listPulls reads the open pull requests and sends the token', () => {
        const forge = fakeForge({ 'GET /pulls?state=open&limit=50&page=1': json(200, [apiPull(42), apiPull(41, { mergeable: false, merged: false })]) });
        const pulls = settle(new GiteaProvider(REPO, 'tok', forge.transport).listPulls('open'));
        eq(pulls.map(p => [p.number, p.author, p.state, p.mergeable, p.headRef, p.comments]), [[42, 'budi', 'open', true, 'feature', 2], [41, 'budi', 'open', false, 'feature', 2]]);
        eq(forge.seen[0].headers?.Authorization, 'token tok');
    });
    test('a merged pull request is told apart from a closed one', () => {
        const forge = fakeForge({ 'GET /pulls?state=closed&limit=50&page=1': json(200, [apiPull(1, { state: 'closed', merged: true }), apiPull(2, { state: 'closed' })]) });
        eq(settle(new GiteaProvider(REPO, 't', forge.transport).listPulls('closed')).map(p => p.state), ['merged', 'closed']);
    });
    test('mergeable that the forge has not computed yet is null', () => {
        const forge = fakeForge({ 'GET /pulls/7': json(200, apiPull(7, { mergeable: undefined })) });
        eq(settle(new GiteaProvider(REPO, 't', forge.transport).getPull(7)).mergeable, null);
    });
    test('listPulls follows pages until one is short', () => {
        const full = Array.from({ length: 50 }, (_, i) => apiPull(i + 1));
        const forge = fakeForge({
            'GET /pulls?state=open&limit=50&page=1': json(200, full),
            'GET /pulls?state=open&limit=50&page=2': json(200, [apiPull(51)]),
        });
        eq(settle(new GiteaProvider(REPO, 't', forge.transport).listPulls('open')).length, 51);
        eq(forge.seen.length, 2);
    });
    test('getFiles maps statuses, renames, and counts', () => {
        const forge = fakeForge({ 'GET /pulls/42/files?limit=50&page=1': json(200, [
            { filename: 'a.md', status: 'modified', additions: 3, deletions: 1 },
            { filename: 'b.md', status: 'added', additions: 5, deletions: 0 },
            { filename: 'c.md', previous_filename: 'old.md', status: 'renamed' },
            { filename: 'd.md', status: 'removed', deletions: 9 },
        ]) });
        eq(settle(new GiteaProvider(REPO, 't', forge.transport).getFiles(42)), [
            { path: 'a.md', status: 'modified', additions: 3, deletions: 1 },
            { path: 'b.md', status: 'added', additions: 5, deletions: 0 },
            { path: 'c.md', previousPath: 'old.md', status: 'renamed', additions: 0, deletions: 0 },
            { path: 'd.md', status: 'deleted', additions: 0, deletions: 9 },
        ]);
    });
    test('getDiff asks for plain text and returns it as it is', () => {
        const forge = fakeForge({ 'GET /pulls/42.diff': { status: 200, body: 'diff --git a/x b/x\n' } });
        eq(settle(new GiteaProvider(REPO, 't', forge.transport).getDiff(42)), 'diff --git a/x b/x\n');
        eq(forge.seen[0].headers?.Accept, 'text/plain');
    });
    test('getContent reads a file at a commit, escapes the path, and gives null when it is not there', () => {
        const forge = fakeForge({ 'GET /raw/agenda/rapat%20a.md?ref=abc123': { status: 200, body: '# Rapat\n' } });
        const gitea = new GiteaProvider(REPO, 't', forge.transport);
        eq(settle(gitea.getContent('agenda/rapat a.md', 'abc123')), '# Rapat\n');
        eq(settle(gitea.getContent('agenda/missing.md', 'abc123')), null);
    });
    test('the head and base commits of a pull request are read', () => {
        const forge = fakeForge({ 'GET /pulls/9': json(200, apiPull(9, { head: { ref: 'f', sha: 'h9' }, base: { ref: 'main', sha: 'b9' } })) });
        const p = settle(new GiteaProvider(REPO, 't', forge.transport).getPull(9));
        eq([p.headSha, p.baseSha], ['h9', 'b9']);
    });
    test('the description and the discussion of a pull request are read', () => {
        const forge = fakeForge({
            'GET /pulls/9': json(200, apiPull(9, { body: 'Adds the calendar layout.' })),
            'GET /issues/9/comments': json(200, [{ id: 1, body: 'Looks good', user: { login: 'sari' }, created_at: '2026-10-12T03:00:00Z' }, { id: 2 }]),
        });
        const gitea = new GiteaProvider(REPO, 't', forge.transport);
        eq(settle(gitea.getPull(9)).body, 'Adds the calendar layout.');
        eq(settle(gitea.listComments(9)), [{ id: 1, author: 'sari', body: 'Looks good', createdAt: '2026-10-12T03:00:00Z' }, { id: 2, author: '', body: '', createdAt: '' }]);
    });
    test('a comment is posted as JSON and comes back', () => {
        const forge = fakeForge({ 'POST /issues/9/comments': json(201, { id: 7, body: 'Thanks!', user: { login: 'eka' }, created_at: '2026-10-12T04:00:00Z' }) });
        const comment = settle(new GiteaProvider(REPO, 't', forge.transport).addComment(9, 'Thanks!'));
        eq(JSON.parse(forge.seen[0].body ?? '{}'), { body: 'Thanks!' });
        eq([comment.id, comment.author, comment.body], [7, 'eka', 'Thanks!']);
    });
    test('merge posts the chosen method', () => {
        const forge = fakeForge({ 'POST /pulls/42/merge': { status: 200, body: '' } });
        settle(new GiteaProvider(REPO, 't', forge.transport).merge(42, 'squash'));
        eq(JSON.parse(forge.seen[0].body ?? '{}'), { Do: 'squash' });
        eq(forge.seen[0].headers?.['Content-Type'], 'application/json');
    });
    test('HTTP errors become the failure the interface can act on', () => {
        const forge = fakeForge({
            'GET /pulls/1': json(401, { message: 'token is invalid' }),
            'GET /pulls/2': json(404, {}),
            'POST /pulls/3/merge': json(405, { message: 'Please try again later' }),
            'POST /pulls/4/merge': json(409, { message: 'merge conflict' }),
            'GET /pulls/5': { status: 502, body: '<html>bad gateway</html>' },
        });
        const gitea = new GiteaProvider(REPO, 't', forge.transport);
        const auth = failure(gitea.getPull(1));
        eq(auth.failure, 'auth');
        contains(auth.message, 'token is invalid');
        eq(failure(gitea.getPull(2)).failure, 'not-found');
        eq(failure(gitea.merge(3, 'merge')).failure, 'not-mergeable');
        contains(failure(gitea.merge(4, 'merge')).message, 'merge conflict');
        eq(failure(gitea.getPull(5)).failure, 'server');
    });
    test('no token fails before any request', () => {
        const forge = fakeForge({});
        eq(failure(new GiteaProvider(REPO, '', forge.transport).listPulls('open')).failure, 'auth');
        eq(forge.seen.length, 0);
    });
    test('a transport that throws is a network failure; a body that is not JSON is a server failure', () => {
        const down: Transport = async () => { throw new Error('Connection refused'); };
        const net = failure(new GiteaProvider(REPO, 't', down).getPull(1));
        eq(net.failure, 'network');
        contains(net.message, 'Connection refused');
        const html = fakeForge({ 'GET /pulls/1': { status: 200, body: '<html>login</html>' } });
        eq(failure(new GiteaProvider(REPO, 't', html.transport).getPull(1)).failure, 'server');
    });

    section('Forge: monitor');
    test('diffPulls: opened, updated, closed, and nothing when nothing changed', () => {
        const before = [pull(1), pull(2), pull(3)];
        const after = [pull(1), pull(2, { updatedAt: '2026-10-12T05:00:00Z' }), pull(4)];
        eq(diffPulls(before, after).map(e => [e.kind, e.pull.number]), [['updated', 2], ['opened', 4], ['closed', 3]]);
        eq(diffPulls(before, before), []);
    });
    test('a pull request that becomes mergeable or is renamed counts as updated', () => {
        eq(diffPulls([pull(1, { mergeable: null })], [pull(1, { mergeable: true })]).map(e => e.kind), ['updated']);
        eq(diffPulls([pull(1)], [pull(1, { title: 'New title' })]).map(e => e.kind), ['updated']);
    });
    test('the first poll is a baseline: no events for what was already open', () => {
        let open = [pull(1), pull(2)];
        const monitor = new PullMonitor({ listPulls: async () => open } as never);
        const seen: string[][] = [];
        monitor.onChange = (pulls, events) => seen.push([String(pulls.length), ...events.map(e => `${e.kind}#${e.pull.number}`)]);
        settle(monitor.poll());
        eq(seen, [['2']]);
        settle(monitor.poll());
        eq(seen.length, 1);              // nothing changed: no callback
        open = [pull(1), pull(2), pull(3)];
        settle(monitor.poll());
        eq(seen[1], ['3', 'opened#3']);
        eq(monitor.pulls.length, 3);
    });
    test('an error keeps the last known list and is reported once per round', () => {
        let fail = false;
        const monitor = new PullMonitor({ listPulls: async () => { if (fail) throw new ForgeError('network', 'down'); return [pull(1)]; } } as never);
        const errors: string[] = [];
        monitor.onError = e => errors.push(e.failure);
        settle(monitor.poll());
        fail = true;
        settle(monitor.poll());
        eq(errors, ['network']);
        eq(monitor.pulls.length, 1);
    });
    test('a poll that is still running is not started twice', () => {
        let calls = 0;
        const monitor = new PullMonitor({ listPulls: async () => { calls++; return [pull(1)]; } } as never);
        settle(Promise.all([monitor.poll(), monitor.poll()]));
        eq(calls, 1);
    });

    section('Forge: libsoup transport (fake server)');
    // Earlier unit tests run without a main loop and can leave GC pending; a Soup callback that arrives at that time is blocked by GJS.
    System.gc();
    const server = new Soup.Server();
    const received: { method: string; auth: string | null; contentType: string | null; body: string }[] = [];
    server.add_handler('/echo', (_server, msg) => {
        const headers = msg.get_request_headers();
        received.push({ method: msg.get_method(), auth: headers.get_one('Authorization'), contentType: headers.get_one('Content-Type'),
            body: new TextDecoder().decode(msg.get_request_body()?.data ?? new Uint8Array()) });
        msg.set_status(201, null);
        msg.get_response_body().append(new TextEncoder().encode('{"ok":true}'));
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const port = server.get_uris()[0].get_port();
    test('sends method, headers, and body, and reads status and text', () => {
        const answer = settle(soupTransport({ method: 'POST', url: `http://127.0.0.1:${port}/echo`, headers: { Authorization: 'token x', 'Content-Type': 'application/json' }, body: '{"Do":"merge"}' }));
        eq(answer, { status: 201, body: '{"ok":true}' });
        eq(received[0], { method: 'POST', auth: 'token x', contentType: 'application/json', body: '{"Do":"merge"}' });
    });
    test('a server that is not there rejects (so the client reports a network failure)', () => {
        const dead = failure(new GiteaProvider({ ...REPO, baseUrl: 'http://127.0.0.1:1' }, 't', soupTransport).getPull(1));
        eq(dead.failure, 'network');
    });
    ok(server.get_uris().length > 0, 'server listening');
    server.disconnect();
}
