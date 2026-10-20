// The git history in the application session: AppSession owns the history controller, recording views stand
// in for the History tab and its viewer, and git runs for real in a temporary repository. The views only see plain
// data and report; what is committed or thrown away is decided by the core.

import { AppSession } from '../../src/app/session.js';
import type { HistoryChanges, HistoryLog, HistoryTabView, HistoryText, HistoryViewerSpec, HistoryViewersView } from '../../src/app/history.js';
import type { KeyStore } from '../../src/agent/apikey.js';
import type { ChatResult } from '../../src/agent/provider.js';
import type { Cancellable } from '../../src/cancel.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, within, until, pause, tmp, disk } from '../framework.js';
import { host } from '../host.js';
import { fakeFrontend, FakeEditor, LaggingEditor, memorySettings, quiet } from './appsession.js';

const KEY: KeyStore = { get: async () => ({ key: 'test', source: 'env' }), set: async () => 'env', clear: async () => {} };
const V1 = '# Title\n\none\n', V2 = '# Title\n\none\ntwo\n';

const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const run = await within(runGit(cwd, args));
    if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
    return run.out.trim();
};

// The tab and the viewers: every notice is kept, as data.
function recordingViews() {
    const logs: HistoryLog[] = [];
    const changes: HistoryChanges[] = [];
    const streamed: string[] = [];
    const tab = quiet<HistoryTabView>({
        showLog: log => { logs.push(log); },
        showChanges: c => { changes.push(c); },
        messageText: text => { streamed.push(text); },
    });
    const opened = new Map<number, HistoryViewerSpec>();
    const diffs = new Map<number, HistoryText>();
    const contents = new Map<number, string>();
    const closed: number[] = [];
    const viewers = quiet<HistoryViewersView>({
        open: (id, spec) => { opened.set(id, spec); },
        showDiff: (id, diff) => { diffs.set(id, diff); },
        showContent: (id, text) => { contents.set(id, text); },
        messageText: (_id, text) => { streamed.push(text); },
        close: id => { closed.push(id); },
    });
    return { tab, viewers, logs, changes, streamed, opened, diffs, contents, closed, lastLog: () => logs.at(-1)!, lastChanges: () => changes.at(-1)! };
}

export async function historyControllerTests(): Promise<void> {
    section('History in the application session');
    for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' })) host().setenv(name, value);
    let n = 0;
    // A repository with a.md in two commits, and a session whose History tab shows it.
    const setup = async (makeEditor: () => FakeEditor = () => new FakeEditor()) => {
        const root = disk.join(tmp, `history-${++n}`);
        disk.mkdirs(root);
        const a = disk.join(root, 'a.md');
        await git(root, 'init', '-q');
        disk.write(a, V1);
        await git(root, 'add', 'a.md');
        await git(root, 'commit', '-q', '-m', 'Create note');
        disk.write(a, V2);
        await git(root, 'commit', '-q', '-a', '-m', 'Add line two');
        const rec = recordingViews();
        const toasts: string[] = [];
        const settings = memorySettings();
        const session = new AppSession(fakeFrontend(settings, toasts, makeEditor, { historyTab: rec.tab, historyViewers: rec.viewers }));
        session.files.root = root;   // the work folder without the Files tab: nothing is listed or watched
        session.start();
        const asked: string[] = [];
        session.history.dialogs.discard = async (kind, path, viewer) => { asked.push(`${kind} ${path.slice(root.length + 1)} ${viewer}`); return true; };
        return { session, root, a, toasts, asked, history: session.history, ...rec };
    };
    const read = (path: string) => disk.read(path);

    await test('the tab gets the file\'s commits and the uncommitted files as plain data', async () => {
        const { session, root, a, history, logs, changes, lastLog, lastChanges } = await setup();
        history.show(a, root);
        eq(lastLog().note, 'Loading…', 'a new file empties the list first');
        await until(() => lastLog().commits.length === 2);
        eq(lastLog().commits.map(c => c.subject), ['Add line two', 'Create note']);
        eq(lastLog().more, false);
        disk.write(disk.join(root, 'b.md'), '# B\n');
        disk.write(a, V2 + 'three\n');
        const sent = changes.length;
        history.refresh();
        await until(() => changes.length > sent && lastChanges().changed.length === 2);
        eq(lastChanges().state, 'modified', 'the active file');
        eq(lastChanges().changed.map(c => `${c.kind} ${c.name}`).sort(), ['modified a.md', 'untracked b.md']);
        // The same commits again: nothing new is sent, so the view keeps its rows.
        const before = logs.length;
        history.refresh();
        await pause(300);
        eq(logs.length, before, 'an unchanged log was sent again');
        for (const notice of [...logs, ...changes]) eq(JSON.parse(JSON.stringify(notice)), notice, 'a notice is not plain data');
        history.show(null, root, true);
        eq(lastLog().note, 'Save the document to a file, and its git history will show up here');
        await within(history.settled());
        session.dispose();
    });

    await test('a file outside a repository says so', async () => {
        const { session, history, lastLog } = await setup();
        const plain = disk.join(tmp, 'history-plain');
        disk.mkdirs(plain);
        disk.write(disk.join(plain, 'x.md'), '# x\n');
        history.show(disk.join(plain, 'x.md'), null);
        await until(() => lastLog().note.includes('not in a git repository'));
        await within(history.settled());
        session.dispose();
    });

    await test('a commit opens in a viewer with its diff and the file at that commit', async () => {
        const { session, root, a, history, lastLog, opened, diffs, contents } = await setup();
        history.show(a, root);
        await until(() => lastLog().commits.length === 2);
        const [second, first] = lastLog().commits;
        session.host.historyTab.onOpen(second.hash);
        eq([...opened.values()], [{ file: a, commit: second }]);
        await until(() => diffs.has(1) && contents.has(1));
        const diff = diffs.get(1)!;
        ok('lines' in diff && diff.lines.some(l => l.kind === 'add' && l.text === '+two'), JSON.stringify(diff));
        eq(contents.get(1), V2);
        session.host.historyTab.onOpen(first.hash);
        await until(() => contents.has(2));
        eq(contents.get(2), V1);
        session.host.historyTab.onOpen('0000000');
        eq(opened.size, 2, 'an unknown commit opened a viewer');
        // A window closed before its git answer arrives is not drawn on.
        session.host.historyTab.onOpen(second.hash);
        session.host.historyViewers.onClosed(3);
        await within(history.settled());   // the git answers for it have arrived
        ok(!diffs.has(3) && !contents.has(3), 'a closed viewer was drawn on');
        session.dispose();
    });

    await test('the tab commits only the files it was shown, after saving the open documents', async () => {
        const { session, root, a, history, toasts, lastLog, lastChanges } = await setup();
        const b = disk.join(root, 'b.md'), c = disk.join(root, 'c.md');
        disk.write(b, '# B\n');
        disk.write(c, '# C\n');
        disk.write(a, V2 + 'on disk\n');
        ok(session.host.openInTab(a), 'openInTab');
        const editor = session.documents.active.editor as FakeEditor;
        editor.text = V2 + 'typed\n';
        editor.modified = true;
        history.show(a, root);
        await until(() => lastChanges().changed.length === 3);
        const tab = session.host.historyTab;
        eq(await tab.onCommit([disk.join(root, 'elsewhere.md')], 'Sneak'), 'Select the files to commit', 'a path the tab was not shown');
        eq(await tab.onCommit([a, b], '  '), 'Enter a commit message first');
        eq(await tab.onCommit([a, b], 'Commit a and b'), null);
        eq(toasts.at(-1), 'Committed successfully');
        eq(read(a), V2 + 'typed\n', 'the open document was not saved first');
        await until(() => lastLog().commits.length === 3 && lastChanges().changed.length === 1);
        eq(lastLog().commits[0].subject, 'Commit a and b');
        eq(lastChanges().changed.map(f => f.name), ['c.md'], 'c.md was committed too');
        await within(history.settled());
        session.dispose();
    });

    await test('the uncommitted changes of a file open with a form; its commit closes the viewer', async () => {
        const { session, root, a, history, opened, diffs, closed, lastLog } = await setup();
        disk.write(a, V2 + 'three\n');
        history.show(a, root);
        await until(() => lastLog().commits.length === 2);
        history.openChanges(disk.join(root, 'not-shown.md'));
        eq(opened.size, 0, 'a path the tab was not shown opened a viewer');
        session.host.historyTab.onOpenChanges(a);
        eq(opened.get(1), { file: a, commit: null });
        await until(() => diffs.has(1));
        const diff = diffs.get(1)!;
        ok('lines' in diff && diff.lines.some(l => l.text === '+three') && !diff.lines.some(l => l.text === '+two'), JSON.stringify(diff));
        const viewers = session.host.historyViewers;
        eq(await viewers.onCommit(1, ''), 'Enter a commit message first');
        eq(closed, [], 'closed without a commit');
        eq(await viewers.onCommit(1, 'Add line three'), null);
        eq(closed, [1]);
        await until(() => lastLog().commits.length === 3);
        eq(await viewers.onCommit(1, 'Again'), 'There is nothing to commit here', 'a closed viewer committed');
        eq(await git(root, 'status', '--porcelain'), '');
        await within(history.settled());
        session.dispose();
    });

    await test('a discard asks first, saves, restores the file, and the open document follows a turn later', async () => {
        const { session, root, a, history, asked, toasts, lastChanges } = await setup(() => new LaggingEditor());
        ok(session.host.openInTab(a), 'openInTab');
        const editor = session.documents.active.editor as LaggingEditor;
        // The file has changes on disk, and the user's typing since has landed in the editor; the discard throws both away.
        disk.write(a, V2 + 'junk\n');
        editor.text = V2 + 'junk\ntyped\n';
        editor.modified = true;
        history.show(a, root);
        await until(() => lastChanges().changed.length === 1);
        const tab = session.host.historyTab;
        history.dialogs.discard = async (kind, path, viewer) => { asked.push(`${kind} ${path.slice(root.length + 1)} ${viewer}`); return false; };
        eq(await tab.onDiscard(a), 'declined');
        eq(read(a), V2 + 'junk\n', 'declining saved or restored the file');
        eq(editor.getText(), V2 + 'junk\ntyped\n', 'declining changed the document');
        history.dialogs.discard = async (kind, path, viewer) => { asked.push(`${kind} ${path.slice(root.length + 1)} ${viewer}`); return true; };
        eq(await tab.onDiscard(a), 'done');
        eq(asked, ['modified a.md null', 'modified a.md null']);
        eq(read(a), V2, 'the file was not restored');
        await pause(5);
        eq(editor.getText(), V2, 'the document did not take the file again');
        ok(!editor.isModified(), 'the document is still marked as unsaved');
        eq(toasts.at(-1), 'The changes were discarded');
        await until(() => lastChanges().changed.length === 0);
        eq(await tab.onDiscard(a), { error: 'The file is no longer in the list of changes' });
        await within(history.settled());
        session.dispose();
    });

    await test('the viewer discards with the state git reports now, asked over the viewer', async () => {
        const { session, root, a, history, asked, closed, lastLog } = await setup();
        history.show(a, root);
        await until(() => lastLog().commits.length === 2);
        disk.write(a, V2 + 'junk\n');
        history.openChanges(a);
        eq(await session.host.historyViewers.onDiscard(1), 'done');
        eq(asked, ['modified a.md 1']);
        eq(closed, [1]);
        eq(read(a), V2);
        await within(history.settled());
        session.dispose();
    });

    await test('the commit message writer streams into the form that asked, from the files it was shown', async () => {
        const { session, root, a, history, streamed, lastChanges } = await setup();
        disk.write(a, V2 + 'three\n');
        history.show(a, root);
        await until(() => lastChanges().changed.length === 1);
        const chat = session.assistant.chat;
        chat.keyStore = KEY;
        const prompts: string[] = [];
        let stop: Cancellable | undefined;
        let release: () => void = () => {};
        chat.makeProvider = () => ({
            async chat(req): Promise<ChatResult> {
                prompts.push(String(req.messages.at(-1)!.content));
                req.onText('Add line ');
                if (prompts.length === 2) { stop = req.cancellable; await new Promise<void>(resolve => { release = resolve; }); }
                req.onText('three');
                return { usage: null, cancelled: !!req.cancellable?.cancelled, reasoning: '', toolCalls: [] };
            },
        });
        const tab = session.host.historyTab;
        const result = await within(tab.onWrite([a, disk.join(root, 'secret.md')]));
        eq(result, { ok: true, message: 'Add line three', shortened: false, cancelled: false });
        eq(streamed, ['Add line', 'Add line three']);
        ok(prompts[0].includes('+three') && !prompts[0].includes('secret'), prompts[0]);
        // Stop cancels the request the controller made.
        const second = tab.onWrite([a]);
        await until(() => stop !== undefined);
        tab.onStopWriting();
        ok(stop!.cancelled, 'Stop did not cancel the request');
        release();
        const stopped = await within(second);
        ok(stopped.ok && stopped.cancelled, JSON.stringify(stopped));
        eq(await tab.onWrite([disk.join(root, 'secret.md')]), { ok: false, reason: 'failed', message: 'there is nothing to describe' });
        await within(history.settled());
        session.dispose();
    });
}
