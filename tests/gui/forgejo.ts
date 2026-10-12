// Integration test: the Markwork window against a real Forgejo or Gitea. Nothing is faked: the real libsoup transport, the real
// git, the token from the environment, and the folder is a real clone. It drives the controllers the way the sidebar tab, the review
// page, and the dialogs do (only the confirmation dialogs are answered for the user). NOT part of npm test; run it with
//
//   FORGEJO_TOKEN=<owner token> FORGEJO_CONTRIBUTOR_TOKEN=<another user's token> npm run test:live:forgejo
//
// It needs a server with the repository (see ~/forgejo-local), creates its own files and pull requests with a time stamp in
// their names, and turns on "Allow manual merge" for the repository (a new one has it off; Markwork then says it cannot mark
// a locally merged pull request as merged, which tests/live-forge.ts covers).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { sendChanges, type SendContext } from '../../src/forge/contribute.js';
import type { PullRequest } from '../../src/forge/types.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';
import { CONTRIBUTOR_TOKEN, OWNER_TOKEN, REPO, api, clone, contributor, git, owner, putFile, read, repo, stamp, waitFor } from '../forgejo-support.js';
import type { GuiContext } from './context.js';
import { descendants } from '../widgets.js';

export function forgejoTests(c: GuiContext): void {
    const { w, pump } = c;
    section('Forgejo integration (real server)');
    if (!OWNER_TOKEN || !CONTRIBUTOR_TOKEN) {
        print('  FORGEJO_TOKEN and FORGEJO_CONTRIBUTOR_TOKEN are needed; skipped');
        return;
    }
    const real = <T>(promise: Promise<T>, seconds = 60): T => settle(promise, seconds * 1000);
    const until = (what: string, cond: () => boolean, seconds = 30) => {
        for (let i = 0; i < seconds * 50 && !cond(); i++) { pump(); GLib.usleep(20000); }
        ok(cond(), `${what} did not happen within ${seconds} seconds`);
    };
    // The refresh of the monitor is a network round; poll until the list says what is expected.
    const refreshUntil = (what: string, cond: () => boolean, seconds = 40) => {
        for (let i = 0; i < seconds && !cond(); i++) { real(w.collab.refresh()); if (!cond()) { for (let j = 0; j < 25; j++) { pump(); GLib.usleep(40000); } } }
        ok(cond(), `${what} did not happen within ${seconds} rounds`);
    };
    const toastOf = (run: () => Promise<unknown>): string => { const before = w.lastToast; w.lastToast = ''; real(run()); const toast = w.lastToast; w.lastToast = before; return toast; };
    const pullNamed = (title: string): PullRequest | undefined => w.collab.pulls.find(p => p.title === title);

    // ---- Preparation, with plain API calls and the forge layer as the contributor ----
    GLib.setenv('MARKWORK_FORGE_TOKEN', OWNER_TOKEN, true);
    GLib.setenv('GIT_TERMINAL_PROMPT', '0', true);
    real(api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}`, { allow_manual_merge: true, autodetect_manual_merge: true }));
    const note = `ui-${stamp}.md`;
    real(putFile(OWNER_TOKEN, note, '# UI test\n\nline one\n', `Add ${note}`));
    const titleA = `UI clean ${stamp}`, titleB = `UI conflict ${stamp}`;
    const contrib = real(clone(CONTRIBUTOR_TOKEN, `ui-contrib-${stamp}`));
    const send = (branch: string, title: string, text: string) => {
        real(git(contrib.folder, ['checkout', '-q', 'main']));
        GLib.file_set_contents(GLib.build_filenamev([contrib.folder, note]), text);
        const context: SendContext = { provider: contributor, repo, token: CONTRIBUTOR_TOKEN, git: runGit };
        const result = real(sendChanges(context, { folder: contrib.folder, files: [GLib.build_filenamev([contrib.folder, note])], title, body: `Prepared for the integration test ${stamp}`, branch, via: 'fork' }));
        if (!result.ok) throw new Error(result.message);
    };
    send(`ui-a-${stamp}`, titleA, '# UI test\n\nline A\n');
    send(`ui-b-${stamp}`, titleB, '# UI test\n\nline B\n');
    const mine = real(clone(OWNER_TOKEN, `ui-owner-${stamp}`));
    const previousRoot = w.fileTree.root;
    const view = w.pullView;
    const panel = w.collabPanel;
    const diffText = () => { const b = view.diffView.buffer; const [s, e] = b.get_bounds(); return b.get_text(s, e, true); };
    const labels = (root: Gtk.Widget) => descendants(root).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label()).join('\n');
    w.pulls.dialogs.merge = async () => true;
    w.pulls.dialogs.local = async () => true;
    w.pulls.dialogs.abort = async () => true;

    test('opening the clone connects the tab to the server: the pull requests are listed, and the footer names the repository', () => {
        w.openFolder(mine.folder);
        w.sidebar.setVisible(true);
        w.sidebar.setPage('collab');
        until('the list to load', () => !!pullNamed(titleA) && !!pullNamed(titleB));
        contains(labels(panel.widget), titleA);
        contains(labels(panel.widget), titleB);
        contains(panel.server.get_label() ?? '', REPO);
        eq(w.collab.session()?.repo.host, repo.host);
    });

    test('a pull request opens in the content area with its files, and the note view shows the change', () => {
        const a = pullNamed(titleA)!;
        real(w.pulls.open(a));
        until('the files', () => !!view.files.get_row_at_index(0));
        eq(view.files.get_row_at_index(1), null);
        contains(view.title.get_label() ?? '', titleA);
        contains(view.meta.get_label() ?? '', `into main`);
        until('the note view', () => diffText().includes('line A'));
        contains(diffText(), '- line one');
        contains(diffText(), '+ line A');
        view.rawButton.set_active(true);
        contains(diffText(), '@@');
        view.renderedButton.set_active(true);
    });

    test('a comment written in the discussion tab reaches the server, and the description is shown', () => {
        until('the discussion', () => labels(view.discussion).includes('description'));
        contains(labels(view.discussion), `Prepared for the integration test ${stamp}`);
        real(w.pulls.comment(`Comment from the UI test ${stamp}`));
        const a = pullNamed(titleA)!;
        ok(real(owner.listComments(a.number)).some(cm => cm.body === `Comment from the UI test ${stamp}`), 'the server has the comment');
        contains(view.discussionButton.get_label() ?? '', 'Discussion (1)');
    });

    test('merging asks for confirmation, merges on the server, and brings the folder up to date', () => {
        const a = pullNamed(titleA)!;
        const toast = toastOf(() => w.pulls.merge('squash'));
        contains(toast, `Merged pull request #${a.number}`);
        contains(toast, 'The folder is up to date');
        eq(real(owner.getPull(a.number)).state, 'merged');
        contains(read(GLib.build_filenamev([mine.folder, note])), 'line A');
    });

    test('the list moves on by itself: the merged pull request is gone, and the other now conflicts', () => {
        refreshUntil('the conflict to show', () => !pullNamed(titleA) && pullNamed(titleB)?.mergeable === false);
        ok(!labels(panel.widget).includes(titleA), 'the merged one left the list');
    });

    test('a conflicting pull request offers to resolve it here, and the file opens with git\'s markers', () => {
        const b = pullNamed(titleB)!;
        real(w.pulls.open(b));
        eq(view.banner.get_button_label(), 'Resolve locally…');
        eq(view.merge.get_sensitive(), false);
        contains(toastOf(() => w.pulls.resolve()), '1 file has conflicts');
        eq(w.file, GLib.build_filenamev([mine.folder, note]));
        contains(read(GLib.build_filenamev([mine.folder, note])), '<<<<<<<');
    });

    test('finishing is refused while the markers are there, and pushes the resolution once they are gone', () => {
        real(w.pulls.open(pullNamed(titleB)!));
        contains(view.banner.get_title(), '1 file still has conflict markers');
        contains(toastOf(() => w.pulls.finish()), 'Still has conflict markers');
        w.editor.replaceText('# UI test\n\nline A and line B\n');
        const b = pullNamed(titleB)!;
        const toast = toastOf(() => w.pulls.finish());
        contains(toast, `Pushed. Pull request #${b.number} is merged on the server.`);
        eq(real(owner.getPull(b.number)).state, 'merged');
        contains(real(owner.getContent(note, 'main')) ?? '', 'line A and line B');
    });

    test('sending the owner\'s own changes as a pull request: a branch in the repository, then the pull request', () => {
        GLib.file_set_contents(GLib.build_filenamev([mine.folder, note]), '# UI test\n\nline A and line B\n\nsent from the UI test\n');
        const offered: boolean[] = [];
        w.contribute.dialogs.send = async options => { offered.push(options.canPush); return { title: `UI send ${stamp}`, body: 'From the UI test', branch: `ui-send-${stamp}`, via: 'direct', files: options.changes.map(ch => ch.path) }; };
        const toast = toastOf(() => w.contribute.start());
        eq(offered, [true]);
        contains(toast, 'Opened pull request #');
        contains(toast, `ui-send-${stamp}`);
        const opened = real(owner.listPulls('open')).find(p => p.title === `UI send ${stamp}`);
        ok(opened, 'the pull request exists on the server');
        eq(opened?.headRef, `ui-send-${stamp}`);
        real(api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}/pulls/${opened!.number}`, { state: 'closed' }));
    });

    test('AGit: the push alone opens the pull request', () => {
        real(git(mine.folder, ['checkout', '-q', 'main']));
        GLib.file_set_contents(GLib.build_filenamev([mine.folder, `agit-${stamp}.md`]), `# AGit ${stamp}\n`);
        w.contribute.dialogs.send = async options => ({ title: `UI agit ${stamp}`, body: '', branch: `ui-agit-${stamp}`, via: 'agit', files: options.changes.map(ch => ch.path) });
        contains(toastOf(() => w.contribute.start()), 'Sent.');
        const opened = real(waitFor('the AGit pull request', async () => (await owner.listPulls('open')).find(p => p.title === `UI agit ${stamp}`) ?? null));
        real(api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}/pulls/${opened.number}`, { state: 'closed' }));
    });

    test('opening another folder clears the review', () => {
        w.pulls.close();
        w.openFolder(previousRoot ?? mine.folder);
        eq(w.pulls.current, null);
    });

    w.collab.dispose();
    GLib.unsetenv('MARKWORK_FORGE_TOKEN');
}
