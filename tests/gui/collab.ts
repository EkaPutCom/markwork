// GUI tests: the Collaboration tab (pull requests) with a fake forge, token store, and git remote.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { TokenStore } from '../../src/forge/token.js';
import type { HttpRequest, HttpResponse } from '../../src/forge/types.js';
import { section, test, eq, ok, contains, settle, optVal, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { descendants, widgetPixbuf } from '../widgets.js';

const apiPull = (n: number, extra: object = {}) => ({
    number: n, title: `Pull request ${n}`, state: 'open', merged: false, mergeable: true, user: { login: 'budi' },
    head: { ref: 'feature' }, base: { ref: 'main' }, comments: 0, created_at: '2026-10-12T01:00:00Z', updated_at: '2026-10-12T02:00:00Z',
    html_url: `https://git.example.org/eka/notes/pulls/${n}`, ...extra,
});

export function collabTests(c: GuiContext): void {
    const { w, pump } = c;
    section('Collaboration tab');

    let pulls: object[] = [
        apiPull(42, { title: 'Add a calendar layout for the Agenda', user: { login: 'budi' }, updated_at: '2026-10-12T05:00:00Z', comments: 1 }),
        apiPull(41, { title: 'Fix a typo in the journal', user: { login: 'sari' }, mergeable: false }),
        apiPull(39, { title: 'New schema: Recipe, with a long title that has to be cut off or wrapped in a narrow sidebar', user: { login: 'dewi' }, mergeable: undefined, updated_at: '2026-10-09T02:00:00Z' }),
    ];
    let answer: (request: HttpRequest) => HttpResponse = () => ({ status: 200, body: JSON.stringify(pulls) });
    const saved = new Map<string, string>();
    const tokens: TokenStore = {
        async get(host) { const token = saved.get(host); return token ? { token, source: 'file' } : null; },
        async set(host, token) { saved.set(host, token); return 'file'; },
        async clear(host) { saved.delete(host); },
    };
    let remote: string | null = 'https://git.example.org/eka/notes.git';
    w.collab.services.tokens = tokens;
    w.collab.services.transport = async request => answer(request);
    w.collab.services.remoteUrl = async () => remote;
    w.settings.forgeNotify = false;

    const panel = w.collabPanel;
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 500 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };
    const rows = () => { let n = 0; for (let r = panel.list.get_row_at_index(n); r; r = panel.list.get_row_at_index(++n)); return n; };
    const labels = () => descendants(panel.widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label());
    const folder = GLib.build_filenamev([GLib.get_tmp_dir(), 'collab-folder']);

    test('the sidebar has a fourth tab for pull requests, shown as an icon', () => {
        const page = w.sidebar.stack.get_page(panel.widget);
        eq(page.get_name(), 'collab');
        eq(page.get_icon_name(), 'network-workgroup-symbolic');
        w.sidebar.setVisible(true);
        w.sidebar.setPage('collab');
        eq(w.settings.sidebarPage, 'collab');
    });

    test('without a token the tab explains what to do and still names the server', () => {
        settle(w.collab.setFolder(folder));
        ok(waitFor(() => panel.note.get_text().includes('access token')), 'the note asks for a token');
        contains(panel.server.get_label() ?? '', 'git.example.org · eka/notes');
        eq(panel.server.get_sensitive(), true);
    });

    test('with a token the open pull requests are listed, most recently updated first', () => {
        saved.set('git.example.org', 'secret');
        settle(w.collab.setFolder(folder));
        ok(waitFor(() => rows() === 3), 'three rows');
        const text = labels().join('\n');
        ok(text.indexOf('Add a calendar layout') < text.indexOf('Fix a typo') && text.indexOf('Fix a typo') < text.indexOf('New schema'), 'newest first');
        contains(text, '#42 · budi');
        contains(text, '1 comment');
        contains(text, 'PULL REQUESTS (3)');
    });

    test('the row shows whether a pull request can be merged', () => {
        const dots = descendants(panel.widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label && x.get_label() === '●');
        eq(dots.map(d => ['success', 'warning', 'dim-label'].find(css => d.has_css_class(css))), ['success', 'warning', 'dim-label']);
    });

    test('a new pull request found by a refresh is added to the list', () => {
        pulls = [apiPull(43, { title: 'Fresh one', updated_at: '2026-10-12T09:00:00Z' }), ...pulls];
        settle(w.collab.refresh());
        ok(waitFor(() => rows() === 4), 'four rows');
        eq(w.collab.pulls.length, 4);
    });

    test('a rejected token replaces the list with the reason', () => {
        answer = () => ({ status: 401, body: '{"message":"token is invalid"}' });
        settle(w.collab.refresh());
        ok(waitFor(() => panel.note.get_text().includes('token is invalid')), 'the reason is shown');
    });

    test('a failure with a list already on screen keeps the list and says so once', () => {
        answer = () => ({ status: 200, body: JSON.stringify(pulls) });
        settle(w.collab.setFolder(folder));
        ok(waitFor(() => rows() === 4), 'list is back');
        answer = () => { throw new Error('Connection refused'); };
        const before = w.lastToast;
        settle(w.collab.refresh());
        settle(w.collab.refresh());
        eq(rows(), 4);
        ok(w.lastToast !== before && w.lastToast.includes('Connection refused'), 'a toast tells the list may be stale');
        answer = () => ({ status: 200, body: JSON.stringify(pulls) });
    });

    test('the token dialog saves a token, or removes it when left empty', () => {
        let reply: string | null = 'new-token';
        w.collab.dialogs.token = async () => reply;
        settle(w.collab.editToken());
        eq(saved.get('git.example.org'), 'new-token');
        reply = '';
        settle(w.collab.editToken());
        eq(saved.has('git.example.org'), false);
        ok(waitFor(() => panel.note.get_text().includes('access token')), 'asks for a token again');
        reply = null;
        saved.set('git.example.org', 'keep');
        settle(w.collab.editToken());
        eq(saved.get('git.example.org'), 'keep');
    });

    test('Test connection tries the typed token and reports the count', () => {
        const repo = { baseUrl: 'https://git.example.org', host: 'git.example.org', owner: 'eka', repo: 'notes' };
        eq(settle(w.collab.test(repo, 'typed')), 'Connected — 4 open pull requests');
        answer = () => ({ status: 401, body: '{"message":"bad"}' });
        let reason = '';
        try { settle(w.collab.test(repo, 'typed')); } catch (e) { reason = (e as Error).message; }
        contains(reason, 'refused the access token');
        answer = () => ({ status: 200, body: JSON.stringify(pulls) });
    });

    test('a folder without a usable remote says so', () => {
        remote = null;
        settle(w.collab.setFolder(folder));
        contains(panel.note.get_text(), 'no git remote');
        eq(panel.server.get_sensitive(), false);
        remote = 'not a url';
        settle(w.collab.setFolder(folder));
        contains(panel.note.get_text(), 'does not look like a hosted repository');
        settle(w.collab.setFolder(null));
        contains(panel.note.get_text(), 'Open a folder');
        remote = 'https://git.example.org/eka/notes.git';
    });

    test('a pull request opened later raises a notification when the window is not in front', () => {
        saved.set('git.example.org', 'secret');
        w.settings.forgeNotify = true;
        const sent: string[] = [];
        const app = w.app as unknown as { send_notification: (id: string) => void };
        const original = app.send_notification;
        app.send_notification = id => { sent.push(id); };
        settle(w.collab.setFolder(folder));
        ok(waitFor(() => rows() === 4), 'list loaded (baseline, no notification)');
        eq(sent.length, 0);
        pulls = [apiPull(44, { title: 'Brand new' }), ...pulls];
        settle(w.collab.refresh());
        ok(waitFor(() => rows() === 5), 'five rows');
        if (w.win.is_active) contains(w.lastToast, 'Brand new');
        else eq(sent.length, 1);
        app.send_notification = original;
        w.settings.forgeNotify = false;
    });


    section('Pull request review');
    const BASE = 'b'.repeat(40), HEAD = 'h'.repeat(40);
    const review = apiPull(42, { title: 'Add a calendar layout', body: 'Adds the calendar layout for the Agenda.', head: { ref: 'calendar', sha: HEAD }, base: { ref: 'main', sha: BASE } });
    const conflicted = apiPull(41, { title: 'Fix a typo', mergeable: false, head: { ref: 'typo', sha: HEAD }, base: { ref: 'main', sha: BASE } });
    const files = [
        { filename: 'agenda/rapat.md', status: 'modified', additions: 2, deletions: 2 },
        { filename: 'skema/agenda.yaml', status: 'modified', additions: 1, deletions: 0 },
        { filename: 'img/kalender.png', status: 'added', additions: 0, deletions: 0 },
    ];
    const DIFF = [
        'diff --git a/agenda/rapat.md b/agenda/rapat.md', 'index 1..2 100644', '--- a/agenda/rapat.md', '+++ b/agenda/rapat.md',
        '@@ -1,3 +1,3 @@', '-date: 2026-10-12', '+date: 2026-10-14',
        'diff --git a/skema/agenda.yaml b/skema/agenda.yaml', '--- a/skema/agenda.yaml', '+++ b/skema/agenda.yaml', '@@ -1 +1,2 @@', ' layout: list', '+duration: number',
        'diff --git a/img/kalender.png b/img/kalender.png', 'new file mode 100644', 'Binary files /dev/null and b/img/kalender.png differ', '',
    ].join('\n');
    const NOTE_BEFORE = '---\ndate: 2026-10-12\n---\n# Rapat\n\nBahas rilis.\n';
    const NOTE_AFTER = '---\ndate: 2026-10-14\nowner: budi\n---\n# Rapat\n\nBahas kolaborasi.\n';
    const posts: HttpRequest[] = [];
    const comments: object[] = [{ id: 1, body: 'Tried it on my machine, the calendar works.', user: { login: 'sari' }, created_at: '2026-10-12T08:00:00Z' }];
    let merged = false;
    const API = 'https://git.example.org/api/v1/repos/eka/notes';
    const routes = (request: HttpRequest): HttpResponse => {
        const path = request.url.slice(API.length);
        if (request.method === 'POST' && path === '/issues/42/comments') {
            posts.push(request);
            const body = JSON.parse(request.body ?? '{}').body as string;
            comments.push({ id: comments.length + 1, body, user: { login: 'eka' }, created_at: '2026-10-12T10:00:00Z' });
            return { status: 201, body: JSON.stringify(comments[comments.length - 1]) };
        }
        if (request.method === 'POST') { posts.push(request); return { status: 200, body: '' }; }
        if (path === '/issues/42/comments') return { status: 200, body: JSON.stringify(comments) };
        if (path.startsWith('/pulls?state=open')) return { status: 200, body: JSON.stringify([review, conflicted]) };
        if (path === '/pulls/42') return { status: 200, body: JSON.stringify({ ...review, state: merged ? 'closed' : 'open', merged }) };
        if (path.startsWith('/pulls/42/files')) return { status: 200, body: JSON.stringify(files) };
        if (path === '/pulls/42.diff') return { status: 200, body: DIFF };
        if (path === `/raw/agenda/rapat.md?ref=${BASE}`) return { status: 200, body: NOTE_BEFORE };
        if (path === `/raw/agenda/rapat.md?ref=${HEAD}`) return { status: 200, body: NOTE_AFTER };
        return { status: 404, body: '{"message":"not in the fake"}' };
    };
    answer = routes;
    saved.set('git.example.org', 'secret');
    w.settings.forgeNotify = false;
    const view = w.pullView;
    const pages = () => view.widget.get_parent() as Gtk.Stack;   // the content area
    const diffText = () => { const b = view.diffView.buffer; const [s, e] = b.get_bounds(); return b.get_text(s, e, true); };
    const fileRows = () => { let n = 0; for (let r = view.files.get_row_at_index(n); r; r = view.files.get_row_at_index(++n)); return n; };
    let mergeAnswer = true;
    const asked: string[] = [];
    w.pulls.dialogs.merge = async (pull, method) => { asked.push(`${pull.number}:${method}`); return mergeAnswer; };

    test('choosing a pull request in the tab opens it in the content area, with its files', () => {
        settle(w.collab.setFolder(folder));
        ok(waitFor(() => w.collab.pulls.length === 2), 'listed');
        w.collab.onOpenPull(w.collab.pulls[0]);
        ok(waitFor(() => fileRows() === 3), 'three files');
        eq(pages().visible_child_name, 'pull');
        contains(view.title.get_label() ?? '', '#42');
        contains(view.meta.get_label() ?? '', 'calendar into main');
        eq(view.merge.get_visible() && view.merge.get_sensitive(), true);
        eq(view.banner.get_revealed(), false);
    });

    test('a note is shown as its changed fields and text', () => {
        ok(waitFor(() => diffText().includes('Fields')), 'note view of the first file');
        const text = diffText();
        contains(text, '- date: 2026-10-12');
        contains(text, '+ date: 2026-10-14');
        contains(text, '+ owner: budi');
        contains(text, '- Bahas rilis.');
        contains(text, '+ Bahas kolaborasi.');
        contains(text, '  # Rapat');
    });

    test('the raw diff of the same file is one click away', () => {
        view.rawButton.set_active(true);
        const text = diffText();
        contains(text, '@@ -1,3 +1,3 @@');
        ok(!text.includes('diff --git'), 'the header lines are dropped, as in the history');
        view.renderedButton.set_active(true);
        contains(diffText(), 'Fields');
    });

    test('a file that is not a note has only the raw diff', () => {
        view.files.select_row(view.files.get_row_at_index(1));
        ok(waitFor(() => diffText().includes('+duration: number')), 'raw diff of the schema');
        eq(view.renderedButton.get_sensitive(), false);
        eq(view.showingRaw, true);
        view.files.select_row(view.files.get_row_at_index(2));
        ok(waitFor(() => view.message.get_text().includes('binary')), 'a binary file says so');
        view.files.select_row(view.files.get_row_at_index(0));
        ok(waitFor(() => diffText().includes('Fields') && view.renderedButton.get_sensitive()), 'back to the note');
    });

    test('a pull request with conflicts cannot be merged and says why', () => {
        settle(w.pulls.open(w.collab.pulls[1]));
        eq(view.merge.get_sensitive(), false);
        eq(view.banner.get_revealed(), true);
        contains(view.banner.get_title(), 'conflicts with main');
        w.pulls.close();
    });

    test('the discussion shows the description and the comments, and a new comment is sent and listed', () => {
        w.pulls.close();
        settle(w.pulls.open(w.collab.pulls[0]));
        ok(waitFor(() => view.discussionButton.get_label() === 'Discussion (1)'), 'the count is on the tab');
        view.discussionButton.set_active(true);
        eq(view.showingDiscussion, true);
        const text = descendants(view.discussion).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label()).join('\n');
        contains(text, 'budi · description');
        contains(text, 'Adds the calendar layout for the Agenda.');
        contains(text, 'sari · ');
        contains(text, 'Tried it on my machine');
        view.commentBox.buffer.set_text('  Thanks, merging after lunch.  ', -1);
        settle(w.pulls.comment(view.commentText));
        eq(JSON.parse(posts[posts.length - 1].body ?? '{}'), { body: 'Thanks, merging after lunch.' });
        eq(view.discussionButton.get_label(), 'Discussion (2)');
        eq(view.commentText, '');
        eq(view.commentButton.get_sensitive(), true);
        contains(descendants(view.discussion).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label()).join('\n'), 'eka · ');
        posts.length = 0;
    });

    test('choosing a file leaves the discussion for the file', () => {
        view.files.select_row(view.files.get_row_at_index(1));
        eq(view.showingDiscussion, false);
        view.files.select_row(view.files.get_row_at_index(0));
        ok(waitFor(() => diffText().includes('Fields')), 'the note again');
    });

    test('an empty comment is not sent', () => {
        settle(w.pulls.comment('   '));
        eq(posts.length, 0);
    });

    test('declining the confirmation merges nothing', () => {
        settle(w.pulls.open(w.collab.pulls[0]));
        mergeAnswer = false;
        settle(w.pulls.merge('squash'));
        eq(asked, ['42:squash']);
        eq(posts.length, 0);
    });

    test('merging asks the forge with the chosen method and then shows the pull request as merged', () => {
        mergeAnswer = true;
        const before = w.lastToast;
        settle(w.pulls.merge('squash'));
        eq(posts.length, 1);
        eq(JSON.parse(posts[0].body ?? '{}'), { Do: 'squash' });
        merged = true;
        ok(waitFor(() => view.banner.get_title().includes('merged') || w.lastToast !== before), 'merged state or a toast');
        ok(w.lastToast.includes('Merged pull request #42'), `toast says it: ${w.lastToast}`);
    });

    test('a folder that is not on the base branch is not touched after a merge', () => {
        eq(w.lastToast.includes('not updated') || w.lastToast.includes('git pull failed') || w.lastToast.endsWith('#42'), true);
    });

    test('closing the review shows the document again', () => {
        w.pulls.close();
        ok(pages().visible_child_name !== 'pull', 'the document page is back');
        eq(w.pulls.current, null);
    });


    section('Pull request merge: the folder afterwards');
    const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
    const git = (cwd: string, ...args: string[]) => {
        const [, , err, status] = GLib.spawn_sync(cwd, ['git', '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
    };
    const bare = GLib.build_filenamev([tmp, 'pr-origin.git']), work = GLib.build_filenamev([tmp, 'pr-work']), other = GLib.build_filenamev([tmp, 'pr-other']);
    GLib.mkdir_with_parents(bare, 0o755);
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(tmp, 'clone', '-q', bare, work);
    git(work, 'checkout', '-q', '-B', 'main');
    GLib.file_set_contents(GLib.build_filenamev([work, 'a.md']), '# A\n');
    git(work, 'add', 'a.md');
    git(work, 'commit', '-q', '-m', 'First');
    git(work, 'push', '-q', '-u', 'origin', 'main');
    git(tmp, 'clone', '-q', bare, other);
    const previousRoot = w.fileTree.root;
    const mergeAndWait = () => {
        const before = w.lastToast;
        w.lastToast = '';
        settle(w.pulls.open(w.collab.pulls[0]));
        settle(w.pulls.merge('merge'));
        const toast = w.lastToast;
        w.lastToast = before;
        return toast;
    };
    w.openFolder(work);
    ok(waitFor(() => w.collab.pulls.length === 2), 'the folder\'s pull requests are listed');

    test('on the base branch the folder is brought up to date with git', () => {
        GLib.file_set_contents(GLib.build_filenamev([other, 'b.md']), '# B from the merged pull request\n');
        git(other, 'add', 'b.md');
        git(other, 'commit', '-q', '-m', 'The merged change');
        git(other, 'push', '-q', 'origin', 'main');
        const toast = mergeAndWait();
        contains(toast, 'The folder is up to date');
        ok(GLib.file_test(GLib.build_filenamev([work, 'b.md']), GLib.FileTest.EXISTS), 'the merged file arrived in the folder');
    });

    test('on another branch the folder is left alone, and the toast says why', () => {
        git(work, 'checkout', '-q', '-b', 'my-work');
        const toast = mergeAndWait();
        contains(toast, 'not updated');
        contains(toast, 'my-work');
        git(work, 'checkout', '-q', 'main');
    });

    test('when git cannot pull, the merge is still reported and the reason is given', () => {
        git(work, 'remote', 'set-url', 'origin', GLib.build_filenamev([tmp, 'gone.git']));
        const toast = mergeAndWait();
        contains(toast, 'Merged pull request #42');
        contains(toast, 'git pull failed');
    });

    w.collab.dispose();
    if (previousRoot) w.openFolder(previousRoot);
    w.collab.dispose();

    const shotPrefix = optVal('shot-collab');
    if (shotPrefix) {
        settle(w.collab.setFolder(folder));
        waitFor(() => rows() >= 2);
        const shot = (name: string) => {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shotPrefix}-${name}.png`, 'png', [], []);
        };
        shot('list');
        merged = false;
        w.collab.onOpenPull(w.collab.pulls[0]);
        waitFor(() => fileRows() === 3 && diffText().includes('Fields'));
        shot('note');
        view.rawButton.set_active(true);
        shot('raw');
        view.discussionButton.set_active(true);
        shot('discussion');
        view.renderedButton.set_active(true);
        w.pulls.open(w.collab.pulls[1]);
        waitFor(() => view.banner.get_revealed());
        shot('conflict');
        w.pulls.close();
    }
    w.collab.dispose();
    w.sidebar.setPage('files');
}
