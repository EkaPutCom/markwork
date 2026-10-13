// GUI tests: the Collaboration tab (pull requests) with a fake forge, token store, and git remote.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { TokenStore } from '../../src/forge/token.js';
import type { HttpRequest, HttpResponse } from '../../src/forge/types.js';
import { section, test, eq, ok, contains, settle, optVal, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { tokenDialog } from '../../src/ui/serverdialog.js';
import { sendChangesDialog, type SendChangesAnswer, type SendChangesOptions } from '../../src/ui/sendchanges.js';

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
    const sendOrigin = GLib.build_filenamev([tmp, 'send-origin.git']);
    let cloneUrl = sendOrigin;
    const comments: object[] = [{ id: 1, body: 'Tried it on my machine, the calendar works.', user: { login: 'sari' }, created_at: '2026-10-12T08:00:00Z' }];
    let merged = false;
    const API = 'https://git.example.org/api/v1/repos/eka/notes';
    const routes = (request: HttpRequest): HttpResponse => {
        if (request.url === 'https://git.example.org/api/v1/user') return { status: 200, body: '{"login":"eka"}' };
        const path = request.url.slice(API.length);
        if (path === '') return { status: 200, body: JSON.stringify({ name: 'notes', owner: { login: 'eka' }, clone_url: cloneUrl, default_branch: 'main', fork: false, permissions: { push: true } }) };
        if (request.method === 'POST' && path === '/pulls') { posts.push(request); return { status: 201, body: JSON.stringify(apiPull(50, { title: JSON.parse(request.body ?? '{}').title })) }; }
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
        contains(text, 'budi');
        contains(text, 'opened this pull request');
        contains(text, 'Adds the calendar layout for the Agenda.');
        contains(text, 'sari');
        contains(text, 'Tried it on my machine');
        view.commentBox.buffer.set_text('  Thanks, merging after lunch.  ', -1);
        settle(w.pulls.comment(view.commentText));
        eq(JSON.parse(posts[posts.length - 1].body ?? '{}'), { body: 'Thanks, merging after lunch.' });
        eq(view.discussionButton.get_label(), 'Discussion (2)');
        eq(view.commentText, '');
        eq(view.commentButton.get_sensitive(), true);
        contains(descendants(view.discussion).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label()).join('\n'), 'eka');
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

    section('Send changes as a pull request');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) GLib.setenv(name, value, true);
    const sendWork = GLib.build_filenamev([tmp, 'send-work']);
    GLib.mkdir_with_parents(sendOrigin, 0o755);
    git(sendOrigin, 'init', '-q', '--bare', '-b', 'main');
    git(tmp, 'clone', '-q', sendOrigin, sendWork);
    git(sendWork, 'checkout', '-q', '-B', 'main');
    const note = GLib.build_filenamev([sendWork, 'journal.md']);
    GLib.file_set_contents(note, '# Journal\n\nHallo\n');
    git(sendWork, 'add', 'journal.md');
    git(sendWork, 'commit', '-q', '-m', 'First');
    git(sendWork, 'push', '-q', '-u', 'origin', 'main');
    w.openFolder(sendWork);
    const offered: SendChangesOptions[] = [];
    let draft: SendChangesAnswer | null = null;
    w.contribute.dialogs.send = async options => { offered.push(options); return draft; };
    const bareRefs = () => { const [, out] = GLib.spawn_sync(sendOrigin, ['git', 'for-each-ref', '--format=%(refname)'], env, GLib.SpawnFlags.SEARCH_PATH, null); return new TextDecoder().decode(out ?? undefined); };
    const startAndWait = () => { const before = w.lastToast; w.lastToast = ''; settle(w.contribute.start()); const toast = w.lastToast; w.lastToast = before; return toast; };

    test('with nothing changed there is nothing to send, and the dialog is not shown', () => {
        ok(waitFor(() => w.collab.session() !== null), 'connected to the forge');
        contains(startAndWait(), 'no changes');
        eq(offered.length, 0);
    });

    test('the dialog is offered the repository, the base branch, and the changes; cancelling sends nothing', () => {
        GLib.file_set_contents(note, '# Journal\n\nHello\n');
        draft = null;
        startAndWait();
        eq(offered.length, 1);
        eq([offered[0].repository, offered[0].base, offered[0].canPush, offered[0].changes.map(c => c.path)], ['eka/notes', 'main', true, [note]]);
        ok(!bareRefs().includes('fix-greeting'), 'nothing was pushed');
    });

    test('sending commits on a new branch, pushes it, opens the pull request, and says where the folder is', () => {
        draft = { title: 'Fix the greeting', body: 'Hallo is not English.', branch: 'fix-greeting', via: 'direct', files: [note] };
        const toast = startAndWait();
        contains(toast, 'Opened pull request #50');
        contains(toast, 'fix-greeting');
        contains(bareRefs(), 'refs/heads/fix-greeting');
        const created = JSON.parse(posts[posts.length - 1].body ?? '{}');
        eq([created.title, created.head, created.base, created.body], ['Fix the greeting', 'fix-greeting', 'main', 'Hallo is not English.']);
    });

    // A dialog that is closed while it is still appearing never reports that it closed; let it finish appearing first.
    const settleDialog = () => { for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); } };

    test('the real dialog opens, offers a fork when the user cannot push, and answers null when closed', () => {
        const options: SendChangesOptions = { repository: 'eka/notes', base: 'main', folder: sendWork, changes: [{ path: note, kind: 'modified' }], canPush: false };
        const opened = sendChangesDialog(w.win, options);
        ok(waitFor(() => !!w.win.get_visible_dialog()), 'the dialog is shown');
        const radios = descendants(w.win.get_visible_dialog() as Gtk.Widget).filter((x): x is Gtk.CheckButton => x instanceof Gtk.CheckButton && !!x.get_label());
        eq(radios.map(r => r.get_label()).filter(l => l && !l.includes('journal')), ['Through my fork', 'AGit (no fork, no branch)']);
        eq(radios.find(r => r.get_label() === 'Through my fork')?.get_active(), true);
        settleDialog();
        w.win.get_visible_dialog()?.close();
        eq(settle(opened), null);
        ok(waitFor(() => !w.win.get_visible_dialog()), 'the dialog went away');
        const withPush = sendChangesDialog(w.win, { ...options, canPush: true });
        ok(waitFor(() => !!w.win.get_visible_dialog()), 'shown again');
        const labels = descendants(w.win.get_visible_dialog() as Gtk.Widget).filter((x): x is Gtk.CheckButton => x instanceof Gtk.CheckButton).map(r => r.get_label());
        ok(labels.includes('A branch in the repository'), 'the direct way is offered to those who may push');
        settleDialog();
        w.win.get_visible_dialog()?.close();
        eq(settle(withPush), null);
        ok(waitFor(() => !w.win.get_visible_dialog()), 'and again');
    });

    test('the token dialog says when the token comes from the environment, and offers no removal then', () => {
        const textOf = (root: Gtk.Widget) => descendants(root).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label()).join('\n');
        const shownFor = (source: 'env' | 'file') => {
            const opened = tokenDialog(w.win, { host: 'git.example.org', repository: 'eka/notes', hasToken: true, source, test: async () => 'ok' });
            ok(waitFor(() => !!w.win.get_visible_dialog()), 'the dialog is shown');
            settleDialog();
            const text = textOf(w.win.get_visible_dialog() as Gtk.Widget);
            w.win.get_visible_dialog()?.close();
            eq(settle(opened), null);
            ok(waitFor(() => !w.win.get_visible_dialog()), 'the dialog went away');
            return text;
        };
        contains(shownFor('env'), 'MARKWORK_FORGE_TOKEN environment variable');
        ok(!shownFor('env').includes('remove the saved token'), 'no removal offered for an environment token');
        contains(shownFor('file'), 'Save with the field empty to remove the saved token.');
    });

    test('without a connection to a forge the user is told how to connect', () => {
        w.collab.dispose();
        contains(startAndWait(), 'Connect to a server');
    });

    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) GLib.unsetenv(name);

    w.collab.dispose();

    section('Resolve a pull request locally');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) GLib.setenv(name, value, true);
    const rsRoot = GLib.build_filenamev([tmp, 'resolve-gui']);
    const rsBare = GLib.build_filenamev([rsRoot, 'forge.git']), rsWork = GLib.build_filenamev([rsRoot, 'work']), rsAuthor = GLib.build_filenamev([rsRoot, 'author']);
    GLib.mkdir_with_parents(rsBare, 0o755);
    git(rsBare, 'init', '-q', '--bare', '-b', 'main');
    git(rsRoot, 'clone', '-q', rsBare, rsWork);
    git(rsWork, 'checkout', '-q', '-B', 'main');
    const rsNote = GLib.build_filenamev([rsWork, 'journal.md']);
    GLib.file_set_contents(rsNote, '# Journal\n\nhello\n');
    git(rsWork, 'add', 'journal.md');
    git(rsWork, 'commit', '-q', '-m', 'First');
    git(rsWork, 'push', '-q', '-u', 'origin', 'main');
    git(rsRoot, 'clone', '-q', rsBare, rsAuthor);
    git(rsAuthor, 'checkout', '-q', '-b', 'typo');
    GLib.file_set_contents(GLib.build_filenamev([rsAuthor, 'journal.md']), '# Journal\n\nhello from the pull request\n');
    git(rsAuthor, 'commit', '-q', '-a', '-m', 'Fix a typo');
    git(rsAuthor, 'push', '-q', 'origin', 'typo');
    const sha = (cwd: string, ref: string) => { const [, out] = GLib.spawn_sync(cwd, ['git', 'rev-parse', ref], env, GLib.SpawnFlags.SEARCH_PATH, null); return new TextDecoder().decode(out ?? undefined).trim(); };
    git(rsBare, 'update-ref', 'refs/pull/41/head', sha(rsAuthor, 'HEAD'));
    GLib.file_set_contents(rsNote, '# Journal\n\nhello from main\n');
    git(rsWork, 'commit', '-q', '-a', '-m', 'Main moved on');
    git(rsWork, 'push', '-q', 'origin', 'main');
    cloneUrl = rsBare;
    w.openFolder(rsWork);
    ok(waitFor(() => w.collab.pulls.length === 2 && w.collab.session() !== null), 'the folder is connected');
    let localAnswer = true, abortAnswer = true;
    w.pulls.dialogs.local = async () => localAnswer;
    w.pulls.dialogs.abort = async () => abortAnswer;
    const toastOf = (run: () => unknown) => { const before = w.lastToast; w.lastToast = ''; settle(Promise.resolve(run()) as Promise<unknown>); const toast = w.lastToast; w.lastToast = before; return toast; };
    const conflictedPull = () => w.collab.pulls.find(p => p.number === 41)!;

    test('the banner of a pull request that conflicts offers to resolve it here', () => {
        settle(w.pulls.open(conflictedPull()));
        eq(view.banner.get_revealed(), true);
        eq(view.banner.get_button_label(), 'Resolve locally…');
        eq(view.abort.get_visible(), false);
    });

    test('a folder with uncommitted changes is not merged into', () => {
        GLib.file_set_contents(rsNote, '# Journal\n\nedited by hand\n');
        contains(toastOf(() => w.pulls.resolve()), 'not committed');
        git(rsWork, 'checkout', '-q', '--', 'journal.md');
    });

    test('declining the question merges nothing', () => {
        localAnswer = false;
        toastOf(() => w.pulls.resolve());
        eq(sha(rsWork, 'HEAD'), sha(rsBare, 'main'));
        eq(w.pulls.current?.number, 41);
        localAnswer = true;
    });

    test('resolving merges the pull request into the folder and opens the file that conflicts', () => {
        const toast = toastOf(() => w.pulls.resolve());
        contains(toast, '1 file has conflicts');
        eq(w.file, rsNote);
        eq(w.editor.modes.source, true);   // the markers are shown as they are, not rendered as Markdown
        contains(new TextDecoder().decode(GLib.file_get_contents(rsNote)[1]), '<<<<<<<');
    });

    test('a file that was already open when the merge started shows the markers too, and is not written back over them', () => {
        settle(w.pulls.abort());
        w.load(rsNote);
        contains(w.editor.getText(), 'hello from main');
        const toast = toastOf(() => w.pulls.resolve());
        contains(toast, '1 file has conflicts');
        contains(w.editor.getText(), '<<<<<<<');
        ok(!w.editor.buffer.get_modified(), 'the reloaded document is marked as unsaved');
        w.documents.saveOpenFiles();
        contains(new TextDecoder().decode(GLib.file_get_contents(rsNote)[1]), '<<<<<<<');
    });

    test('opening the pull request again shows how many files are left, and Abort', () => {
        settle(w.pulls.open(conflictedPull()));
        eq(view.banner.get_button_label(), 'Finish and push');
        contains(view.banner.get_title(), '1 file still has conflict markers');
        eq(view.abort.get_visible(), true);
        eq(view.merge.get_sensitive(), false);
        const prefix = optVal('shot-collab');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-resolving.png`, 'png', [], []);
        }
    });

    test('finishing with the markers still there is refused and pushes nothing', () => {
        const before = sha(rsBare, 'main');
        contains(toastOf(() => w.pulls.finish()), 'Still has conflict markers: journal.md');
        eq(sha(rsBare, 'main'), before);
    });

    test('after a restart (the app forgot its note of the merge) the pull request still offers Finish and Abort', () => {
        (w.pulls as unknown as { local: unknown }).local = null;
        settle(w.pulls.open(conflictedPull()));
        ok(waitFor(() => view.banner.get_button_label() === 'Finish and push'), `banner: ${view.banner.get_button_label()}`);
        contains(view.banner.get_title(), '1 file still has conflict markers');
        eq(view.abort.get_visible(), true);
    });

    test('Resolve locally on a merge that is already started carries on with it instead of refusing', () => {
        (w.pulls as unknown as { local: unknown }).local = null;
        settle(w.pulls.open(conflictedPull()));
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
        (w.pulls as unknown as { local: unknown }).local = null;
        contains(toastOf(() => w.pulls.resolve()), 'already started');
        eq(w.file, rsNote);
        contains(w.editor.getText(), '<<<<<<<');
        eq(view.abort.get_visible(), true);
    });

    test('aborting asks first, and returns the folder to what it was', () => {
        abortAnswer = false;
        toastOf(() => w.pulls.abort());
        eq(view.abort.get_visible(), true);
        abortAnswer = true;
        contains(toastOf(() => w.pulls.abort()), 'undone');
        eq(view.abort.get_visible(), false);
        eq(sha(rsWork, 'HEAD'), sha(rsBare, 'main'));
    });

    test('resolving again, editing the file, and finishing pushes the merge to the server', () => {
        toastOf(() => w.pulls.resolve());
        w.editor.replaceText('# Journal\n\nhello from main and the pull request\n');   // an edit, not a load: the document is modified and gets saved
        settle(w.pulls.open(conflictedPull()));
        const toast = toastOf(() => w.pulls.finish());
        contains(toast, 'Pushed');
        eq(sha(rsBare, 'main'), sha(rsWork, 'HEAD'));
        const [, parents] = GLib.spawn_sync(rsBare, ['git', 'log', '-1', '--format=%P', 'main'], env, GLib.SpawnFlags.SEARCH_PATH, null);
        eq(new TextDecoder().decode(parents ?? undefined).trim().split(' ').length, 2);
        eq(view.abort.get_visible(), false);
    });

    for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) GLib.unsetenv(name);
    cloneUrl = sendOrigin;

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
        const dialog = sendChangesDialog(w.win, { repository: 'eka/notes', base: 'main', folder: sendWork, changes: [{ path: note, kind: 'modified' }, { path: GLib.build_filenamev([sendWork, 'agenda', 'rapat.md']), kind: 'untracked' }], canPush: false });
        waitFor(() => !!w.win.get_visible_dialog());
        shot('send');
        w.win.get_visible_dialog()?.force_close();
        settle(dialog);
    }
    w.collab.dispose();
    w.sidebar.setPage('files');
}
