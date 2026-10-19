// A fake forge for the Electron tests (tests/electron-git.mjs): the core loads it when MARKWORK_TEST_FORGE names this file,
// so no test reaches a server. It holds one open pull request (#7) that changes plan.md, its discussion, and what was done to it.

const base = 'https://git.example.org/api/v1/repos/eka/notes';
const state = { merged: false, comments: [{ id: 1, body: 'Looks fine', user: { login: 'budi' }, created_at: '2026-10-12T03:00:00Z' }] };

const pull = () => ({
    number: 7, title: 'Move the release', state: state.merged ? 'closed' : 'open', merged: state.merged, mergeable: true, user: { login: 'sari' },
    head: { ref: 'moved', sha: 'h7' }, base: { ref: 'main', sha: 'b7' }, body: 'Moves it by a week.', comments: state.comments.length,
    created_at: '2026-10-12T01:00:00Z', updated_at: '2026-10-12T02:00:00Z', html_url: 'https://git.example.org/eka/notes/pulls/7',
});
const ok = body => ({ status: 200, body: typeof body === 'string' ? body : JSON.stringify(body) });

const routes = {
    'GET /pulls?state=open&limit=50&page=1': () => ok(state.merged ? [] : [pull()]),
    'GET /pulls/7': () => ok(pull()),
    'GET /pulls/7/files?limit=50&page=1': () => ok([{ filename: 'plan.md', status: 'modified', additions: 1, deletions: 1 }, { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }]),
    'GET /pulls/7.diff': () => ok('diff --git a/plan.md b/plan.md\n--- a/plan.md\n+++ b/plan.md\n@@ -1 +1 @@\n-Ship 15 November\n+Ship 22 November\n'),
    'GET /raw/plan.md?ref=b7': () => ok('Ship 15 November\n'),
    'GET /raw/plan.md?ref=h7': () => ok('Ship 22 November\n'),
    'GET /issues/7/comments': () => ok(state.comments),
    'POST /issues/7/comments': () => {
        const comment = { id: state.comments.length + 1, body: 'Thanks', user: { login: 'eka' }, created_at: '2026-10-12T04:00:00Z' };
        state.comments.push(comment);
        return { status: 201, body: JSON.stringify(comment) };
    },
    'POST /pulls/7/merge': () => { state.merged = true; return ok(''); },
    'GET ': () => ok({ name: 'notes', owner: { login: 'eka' }, clone_url: 'https://git.example.org/eka/notes.git', default_branch: 'main', permissions: { push: true }, fork: false }),
};

export const services = {
    tokens: { get: async () => ({ token: 'secret', source: 'keyring' }), set: async () => 'keyring', clear: async () => {} },
    transport: async request => {
        const path = request.url.replace(base, '');
        return routes[`${request.method} ${path}`]?.() ?? { status: 404, body: '{"message":"no route in the fake"}' };
    },
    remoteUrl: async () => 'https://git.example.org/eka/notes.git',
};
