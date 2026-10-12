// GUI tests: the Collaboration tab (pull requests) with a fake forge, token store, and git remote.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { TokenStore } from '../../src/forge/token.js';
import type { HttpRequest, HttpResponse } from '../../src/forge/types.js';
import { section, test, eq, ok, contains, settle, optVal } from '../framework.js';
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

    const shotPrefix = optVal('shot-collab');
    if (shotPrefix) {
        settle(w.collab.setFolder(folder));
        waitFor(() => rows() >= 3);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        widgetPixbuf(w.win)?.savev(`${shotPrefix}-window.png`, 'png', [], []);
    }
    w.collab.dispose();
    w.sidebar.setPage('files');
}
