// GUI tests: the git History tab.

import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import type { WriteResult } from '../../src/agent/commitmessage.js';
import type { ChatResult } from '../../src/agent/provider.js';
import { setStatus } from '../../src/ui/messagewriter.js';
import type { HistoryViewer } from '../../src/ui/historyviewer.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';
import { childrenOf } from '../../src/gtkutil.js';
import { listRows, widgetPixbuf } from '../widgets.js';
import type { Cancellable } from '../../src/cancel.js';

export function historyTests(c: GuiContext): void {
    const { w, pump, setText } = c;

    section('Git history');
    const repo = GLib.build_filenamev([tmp, 'repo-history']);
    const plain = GLib.build_filenamev([tmp, 'no-git']);
    GLib.mkdir_with_parents(repo, 0o755);
    GLib.mkdir_with_parents(plain, 0o755);
    const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
    const git = (...args: string[]) => {
        const [, , err, status] = GLib.spawn_sync(repo, ['git', '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
    };
    const write = (path: string, text: string) => GLib.file_set_contents(path, text);
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 500 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };
    const rows = () => w.history.store.n_items;
    const history = w.session.history;
    const dialogs = { ...history.dialogs };
    // The viewer the controller opened last; a test closes it in its finally.
    const opened = (): HistoryViewer => {
        const viewer = w.historyViewers.last;
        if (!viewer) throw new Error('no history viewer was opened');
        return viewer;
    };
    const text = (view: Gtk.TextView) => view.buffer.get_text(view.buffer.get_start_iter(), view.buffer.get_end_iter(), false);
    // --shot-commit=<prefix>: save the commit form with the assistant button (<prefix>-<state>.png) for visual inspection.
    const shotPrefix = optVal('shot-commit');
    const shot = (name: string, widget: Gtk.Widget = w.win) => {
        if (!shotPrefix) return;
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        widgetPixbuf(widget)?.savev(`${shotPrefix}-${name}.png`, 'png', [], []);
    };

    const a = GLib.build_filenamev([repo, 'a.md']);
    const untracked = GLib.build_filenamev([repo, 'new.md']);
    const outside = GLib.build_filenamev([plain, 'x.md']);
    const V1 = '# Title\n\none\n', V2 = '# Title\n\none\ntwo\n';
    git('init', '-q');
    write(a, V1);
    git('add', 'a.md');
    git('commit', '-q', '-m', 'Create note');
    write(a, V2);
    git('commit', '-q', '-a', '-m', 'Add line two');
    write(untracked, '# Not in git yet\n');
    write(outside, '# Outside the repo\n');

    w.sidebar.setVisible(true);
    w.sidebar.setPage('history');

    test('the history tab does not make the sidebar expand (the sidebar stays at the left edge, 300 wide)', () => {
        ok(!w.sidebar.panel.compute_expand(Gtk.Orientation.HORIZONTAL), 'the sidebar demands spare space');
        ok(!w.history.widget.compute_expand(Gtk.Orientation.HORIZONTAL), 'the history tab demands spare space');
        w.win.set_default_size(1600, 700);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        const a = w.sidebar.panel.get_allocation();
        ok(a.width <= 320, `sidebar width  ${a.width}`);
        // Relative to the window contents: on a desktop, the window manager's decorations/shadow shift the toplevel allocation.
        const x = w.sidebar.panel.translate_coordinates(w.win.get_child()!, 0, 0)[1];
        // Restore the size: a window wider than the Xvfb screen puts buttons outside
        // the monitor, and a popover from such a button triggers Gdk-CRITICAL in GTK 4 (X11).
        w.win.set_default_size(1100, 700);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(15000); }
        ok(x < 20, `the sidebar shifted to x=${x}`);
    });
    test('the uncommitted list with a message field does not make the sidebar expand', () => {
        ok(!w.history.commitBar.compute_expand(Gtk.Orientation.HORIZONTAL), 'the commit field demands spare space');
        ok(!w.history.changedBox.compute_expand(Gtk.Orientation.HORIZONTAL), 'the change list demands spare space');
    });
    test('the file history is shown newest first', () => {
        w.load(a);
        ok(waitFor(() => rows() === 2), 'number of history rows');
        const label = (i: number) => (w.history.store.get_item(i) as unknown as { commit: { subject: string } }).commit.subject;
        eq([label(0), label(1)], ['Add line two', 'Create note']);
    });
    test('a file that is not committed yet shows the empty message', () => {
        w.load(untracked);
        ok(waitFor(() => rows() === 0 && w.history.note.label.includes('There are no commits')), `message: ${w.history.note.label}`);
        // The list is emptied first (clear()); the message replaces the list and must be shown.
        ok(w.history.note.get_mapped(), 'the message is not shown');
    });
    test('a file outside a git repository shows a message', () => {
        w.load(outside);
        ok(waitFor(() => w.history.note.label.includes('is not in a git repository')), `message: ${w.history.note.label}`);
    });
    test('a document without a file shows a hint to save', () => {
        history.show(null);
        ok(w.history.note.label.includes('Save the document'), `message: ${w.history.note.label}`);
        ok(w.history.note.get_mapped(), 'the message is not shown');
    });
    test('the history is not loaded while another tab is open', () => {
        w.sidebar.setPage('outline');
        w.load(a);
        pump();
        eq(rows(), 0, 'history rows');
        w.sidebar.setPage('history');
        ok(waitFor(() => rows() === 2), 'the history is loaded when the tab is opened');
    });
    test('reloading picks up the new commit', () => {
        write(a, V2 + 'three\n');
        git('commit', '-q', '-a', '-m', 'Add line three');
        history.refresh();
        ok(waitFor(() => rows() === 3), 'the new commit did not appear');
    });

    test('clicking a commit opens the viewer with the diff and the contents of that version', () => {
        w.history.list.emit('activate', 1);
        const viewer = opened();
        try {
            eq(viewer.commit?.subject, 'Add line two', 'the commit opened');
            const diff = () => text(viewer.diffView);
            ok(waitFor(() => diff().includes('+two')), `diff: ${diff()}`);
            ok(!diff().includes('diff --git'), 'the diff header was not removed');
            const table = viewer.diffView.buffer.get_tag_table();
            const lineTags = (n: number) => iterAtLine(viewer.diffView.buffer, n).get_tags().map(t => t.name);
            eq(lineTags(0), ['hunk'], 'hunk line tag');
            const added = diff().split('\n').findIndex(l => l === '+two');
            eq(lineTags(added), ['add'], 'added line tag');
            ok(table.lookup('del') !== null, 'the delete tag exists');
            ok(waitFor(() => text(viewer.contentView) === V2), `contents of that version: ${JSON.stringify(text(viewer.contentView))}`);
            ok(!viewer.contentView.editable, 'the contents are editable');
            eq(viewer.diffView.wrap_mode, Gtk.WrapMode.WORD_CHAR, 'the diff is not wrapped');
            eq(viewer.contentView.wrap_mode, Gtk.WrapMode.WORD_CHAR, 'the contents are not wrapped');
        } finally {
            viewer.window.destroy();
        }
        ok(w.historyViewers.last === undefined, 'the closed viewer is still known');
    });
    test('the viewer shows the contents of the first version for the initial commit', () => {
        w.history.list.emit('activate', 2);
        const viewer = opened();
        try {
            eq(viewer.commit?.subject, 'Create note', 'the initial commit was not opened');
            ok(waitFor(() => text(viewer.contentView) === V1), `contents of the initial version: ${JSON.stringify(text(viewer.contentView))}`);
            ok(waitFor(() => text(viewer.diffView).includes('+# Title')), `diff of the initial commit:  ${text(viewer.diffView)}`);
        } finally {
            viewer.window.destroy();
        }
    });

    test('uncommitted changes appear as a button and a diff against HEAD', () => {
        w.load(a);
        ok(waitFor(() => rows() === 3), 'the history was loaded');
        ok(waitFor(() => !w.history.changes.get_visible()), 'the changes button is shown although the file is clean');
        write(a, V2 + 'three\nfour\n');
        history.refresh();
        ok(waitFor(() => w.history.changes.get_visible()), 'the changes button is not shown');
        ok(w.history.changes.label!.includes('Uncommitted changes'), String(w.history.changes.label));
        w.history.changes.emit('clicked');
        const viewer = opened();
        try {
            eq(viewer.file, a, 'the file of the viewer');
            const diff = () => text(viewer.diffView);
            ok(waitFor(() => diff().includes('+four')), `diff: ${diff()}`);
            ok(!diff().includes('+three'), 'a committed line was shown as an addition');
            ok(viewer.stack.get_child_by_name('content') === null, 'the version contents tab appeared too');
        } finally {
            viewer.window.destroy();
        }
        git('commit', '-q', '-a', '-m', 'Add line four');
        history.refresh();
        ok(waitFor(() => !w.history.changes.get_visible()), 'the button did not vanish after the commit');
    });
    test('the diff of an untracked new file is its entire contents', () => {
        w.load(untracked);
        ok(waitFor(() => w.history.changes.get_visible()), 'the button is not shown');
        ok(w.history.changes.label!.includes('New file'), String(w.history.changes.label));
        w.history.changes.emit('clicked');
        const viewer = opened();
        try {
            ok(waitFor(() => text(viewer.diffView).includes('+# Not in git yet')), `diff: ${text(viewer.diffView)}`);
        } finally {
            viewer.window.destroy();
        }
    });

    test('committing from the changes window takes only that file', () => {
        write(a, V2 + 'three\nfour\nfive\n');
        write(untracked, '# Not in git yet\nchange\n');
        git('add', 'new.md');
        w.load(a);
        ok(waitFor(() => w.history.changes.get_visible()), 'changes button');
        history.openChanges(a);
        const viewer = opened();
        try {
            w.lastToast = '';
            viewer.commitButton.emit('clicked');
            ok(waitFor(() => viewer.status.get_text().includes('message')), 'an empty message was not rejected');
            ok(!viewer.closed && w.lastToast === '', 'commit without a message');
            viewer.message.text = 'Add line five';
            viewer.commitButton.emit('clicked');
            ok(waitFor(() => viewer.closed), `commit failed: ${viewer.closed ? '' : viewer.status.get_text()}`);
            eq(w.lastToast, 'Committed successfully');
        } finally {
            if (!viewer.closed) viewer.window.destroy();   // a successful commit closes its own window
        }
        history.refresh();
        ok(waitFor(() => rows() === 5 && !w.history.changes.get_visible()), 'the history did not load the new commit');
        ok(waitFor(() => !w.history.changedBox.get_visible() || !listRows(w.history.changedList).some(r => r.get_tooltip_text() === a)), 'a.md is still uncommitted');
        w.load(untracked);
        ok(waitFor(() => w.history.changes.get_visible()), 'the other file was committed too');
    });
    test('commit an untracked new file', () => {
        history.openChanges(untracked);
        const viewer = opened();
        try {
            eq(viewer.file, untracked);
            viewer.message.text = 'Add a new note';
            viewer.commitButton.emit('clicked');
            ok(waitFor(() => viewer.closed), `commit failed: ${viewer.closed ? '' : viewer.status.get_text()}`);
        } finally {
            if (!viewer.closed) viewer.window.destroy();   // a successful commit closes its own window
        }
        history.refresh();
        ok(waitFor(() => rows() === 1 && !w.history.changes.get_visible()), 'history of the new file');
    });

    test('the list of all uncommitted files is shown and opens the diff of the clicked file', () => {
        const b = GLib.build_filenamev([repo, 'b.md']);
        write(b, '# B\n');
        git('add', 'b.md');
        git('commit', '-q', '-m', 'Add b');
        write(b, '# B\nchange\n');
        write(GLib.build_filenamev([repo, 'c.md']), '# C\n');
        w.load(a);
        history.refresh();
        const names = () => listRows(w.history.changedList).map(r => (childrenOf(r.get_child()!)[2] as Gtk.Label).label);
        ok(waitFor(() => names().length === 2), `list: ${names()}`);
        eq(names().sort(), ['b.md', 'c.md']);
        ok(w.history.changedBox.get_visible() && (w.history.changedBox.label ?? '').includes('(2)'), `label: ${w.history.changedBox.label}`);
        const idx = names().indexOf('b.md');
        w.history.changedList.emit('row-activated', w.history.changedList.get_row_at_index(idx)!);
        const viewer = opened();
        try {
            eq(viewer.file, b, 'the opened file');
            ok(waitFor(() => text(viewer.diffView).includes('+change')), `diff: ${text(viewer.diffView)}`);
        } finally {
            viewer.window.destroy();
        }
        git('add', '-A');
        git('commit', '-q', '-m', 'Clean up');
        history.refresh();
        ok(waitFor(() => !w.history.changedBox.get_visible()), 'the list did not vanish after everything was committed');
    });

    test('several files are checked and then committed at once', () => {
        const b = GLib.build_filenamev([repo, 'b.md']);
        const c2 = GLib.build_filenamev([repo, 'c.md']);
        const e = GLib.build_filenamev([repo, 'e.md']);
        write(b, '# B\nagain\n');
        write(c2, '# C\nagain\n');
        write(e, '# E\n');
        git('add', 'c.md');
        w.load(a);
        history.refresh();
        const names = () => listRows(w.history.changedList).map(r => (childrenOf(r.get_child()!)[2] as Gtk.Label).label);
        ok(waitFor(() => names().length >= 3 && w.history.commitButton.label === 'Commit 3 files'), `list: ${names()} / ${w.history.commitButton.label}`);
        const check = (name: string) => (w.history.changedList.get_row_at_index(names().indexOf(name))!.get_child()!.get_first_child() as Gtk.CheckButton);
        check('e.md').active = false;
        eq(w.history.commitButton.label, 'Commit 2 files');
        w.history.commitButton.emit('clicked');
        ok(waitFor(() => w.history.commitStatus.get_text().includes('message')), 'an empty message was not rejected');
        w.lastToast = '';
        w.history.message.text = 'Commit b and c';
        w.history.commitButton.emit('clicked');
        ok(waitFor(() => w.lastToast === 'Committed successfully'), `commit failed: ${w.history.commitStatus.get_text()}`);
        history.refresh();
        ok(waitFor(() => names().join() === 'e.md'), `rest of the list: ${names()}`);
        ok(!check('e.md').active, 'the e.md check vanished after reloading');
        eq(w.history.message.text, '', 'the message was not cleared');
        git('add', '-A');
        git('commit', '-q', '-m', 'Clean up e');
        history.refresh();
        ok(waitFor(() => !w.history.changedBox.get_visible()), 'the list did not vanish');
    });

    section('Discarding changes');
    const read = (path: string) => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    const names = () => listRows(w.history.changedList).map(r => (childrenOf(r.get_child()!)[2] as Gtk.Label).label);
    const undoButton = (name: string) => childrenOf(w.history.changedList.get_row_at_index(names().indexOf(name))!.get_child()!).pop() as Gtk.Button;
    test('the undo button on a row asks first; declining leaves the file alone', () => {
        w.load(a);
        const committed = read(a);
        write(a, committed + 'junk\n');
        history.refresh();
        ok(waitFor(() => names().includes('a.md')), `list: ${names()}`);
        eq(undoButton('a.md').get_tooltip_text(), 'Discard the changes to this file');
        shot('discard');
        let asked = '';
        history.dialogs.discard = (kind, path, viewer) => { asked = `${kind} ${GLib.path_get_basename(path)} ${viewer}`; return Promise.resolve(false); };
        undoButton('a.md').emit('clicked');
        ok(waitFor(() => asked !== ''), 'the question was not asked');
        eq(asked, 'modified a.md null');
        eq(read(a), committed + 'junk\n');
    });
    test('confirming goes back to the last commit, and the open document takes the file again as one undo step', () => {
        const committed = (() => { const t = read(a); return t.slice(0, t.length - 'junk\n'.length); })();
        history.dialogs.discard = () => true;
        setText(committed + 'typed in the editor\n');
        undoButton('a.md').emit('clicked');
        ok(waitFor(() => read(a) === committed), `file: ${read(a)}`);
        ok(waitFor(() => c.text() === committed), `editor: ${c.text()}`);
        ok(!w.editor.buffer.get_modified(), 'the document is still marked as unsaved');
        ok(waitFor(() => !names().includes('a.md')), 'the row is still listed');
        w.editor.buffer.undo();
        eq(c.text(), committed + 'typed in the editor\n');
        w.editor.buffer.redo();
    });
    test('a new file is moved to the Trash and its open document loses its file', () => {
        const f = GLib.build_filenamev([repo, 'discard-new.md']);
        write(f, '# New\n');
        w.load(f);
        history.refresh();
        ok(waitFor(() => names().includes('discard-new.md')), `list: ${names()}`);
        eq(undoButton('discard-new.md').get_tooltip_text(), 'Delete this new file');
        let kind = '';
        history.dialogs.discard = k => { kind = k; return Promise.resolve(true); };
        undoButton('discard-new.md').emit('clicked');
        ok(waitFor(() => !GLib.file_test(f, GLib.FileTest.EXISTS)), 'the file is still there');
        eq(kind, 'untracked');
        ok(waitFor(() => w.file === null), `the document still has the file ${w.file}`);
        history.dialogs.discard = dialogs.discard;
    });
    test('the changes window has a Discard Changes button too', () => {
        w.load(a);
        const committed = read(a);
        write(a, committed + 'junk\n');
        history.openChanges(a);
        const viewer = opened();
        let asked: number | null = null;
        history.dialogs.discard = (_kind, _path, from) => { asked = from; return Promise.resolve(true); };
        try {
            eq(viewer.discardButton.get_label(), 'Discard Changes');
            viewer.discardButton.emit('clicked');
            ok(waitFor(() => viewer.closed), 'the window stayed open');
            eq(read(a), committed, 'the changes were not discarded');
            ok(asked !== null && w.historyViewers.get(asked) === undefined, 'the question was not asked over the viewer');
            eq(w.lastToast, 'The changes were discarded');
        } finally {
            history.dialogs.discard = dialogs.discard;
            if (!viewer.closed) viewer.window.destroy();
        }
    });

    test('without a file, the opened folder still shows the uncommitted files', () => {
        write(GLib.build_filenamev([repo, 'd.md']), '# D\n');
        w.file = null; setText('');
        history.show(null, repo, true);
        ok(waitFor(() => listRows(w.history.changedList).length === 1), 'the list is empty although the folder has a new file');
        ok(w.history.note.label.includes('Save the document'), 'the save hint vanished');
        history.show(null, null, true);
        ok(waitFor(() => listRows(w.history.changedList).length === 0), 'the list was not emptied without a folder');
    });

    test('the message box wraps a long message in the sidebar and keeps it on one line', () => {
        const box = w.history.message;
        const height = () => box.widget.measure(Gtk.Orientation.VERTICAL, 210)[1];
        const placeholder = () => box.widget.get_last_child()!.get_visible();
        try {
            box.text = '';
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(5000); }
            const empty = height();
            ok(placeholder(), 'the placeholder is hidden while the box is empty');
            // Two lines fit the empty box; this one needs three or more at the sidebar's width.
            box.text = 'docs(samples): misspell the first heading so the editor shows a spelling mark, and fix the second one';
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(5000); }
            ok(height() > empty, `a long message does not grow the box (${empty} → ${height()})`);
            ok(!placeholder(), 'the placeholder is shown over the text');
            box.text = '';
            box.view.buffer.insert_at_cursor('Fix the date\nin the plan', -1);
            eq(box.text, 'Fix the date in the plan', 'a pasted line break stayed');
            let activated = 0;
            const before = box.onActivate;
            box.onActivate = () => { activated++; };
            box.onActivate();
            box.onActivate = before;
            eq(activated, 1);
        } finally {
            box.text = '';
        }
    });
    test('the assistant writes the message from the checked files, streaming it into the box', () => {
        const writer = w.history.writer;
        const real = writer.write;
        ok(real !== null && writer.button.get_visible(), 'the window did not connect the assistant button');
        git('add', '-A');
        git('commit', '-q', '-m', 'Add d');
        const e = GLib.build_filenamev([repo, 'e.md']);
        write(e, '# E\nnew line\n');
        w.load(a);
        history.refresh();
        ok(waitFor(() => listRows(w.history.changedList).length === 1), 'the changed file is not listed');
        const calls: string[][] = [];
        let onText: (m: string) => void = () => {};
        let finish: (r: WriteResult) => void = () => {};
        let cancellable: Cancellable | null = null;
        writer.write = (files, text, cancel) => {
            calls.push(files); onText = text; cancellable = cancel;
            return new Promise(resolve => { finish = resolve; });
        };
        try {
            w.history.message.text = 'my draft';
            writer.button.emit('clicked');
            eq(calls, [[e]], 'the files sent');
            onText('Add a line');
            eq(w.history.message.text, 'Add a line', 'the streamed text');
            ok(!w.history.message.sensitive && !w.history.commitButton.sensitive, 'the box and Commit are not locked');
            const check = listRows(w.history.changedList)[0].get_child()!.get_first_child() as Gtk.CheckButton;
            ok(!check.sensitive, 'the checkbox is not locked');
            eq(writer.button.get_tooltip_text(), 'Stop writing');
            eq(w.history.commitStatus.get_text(), 'Writing from the changes in e.md…');
            shot('writing');
            finish({ ok: true, message: 'Add a line to E', shortened: false, cancelled: false });
            ok(waitFor(() => w.history.message.sensitive), 'still locked');
            eq(w.history.message.text, 'Add a line to E');
            ok(w.history.commitButton.sensitive && check.sensitive, 'not unlocked');
            eq(w.history.commitStatus.get_text(), 'Written by the assistant from 1 file. Check it before committing.');
            const [start, end] = w.history.message.selection();
            eq([start, end], [0, 'Add a line to E'.length], 'the message is not selected');
            shot('done');
            if (shotPrefix) { const dark = w.dark; w.setDark(true); shot('done-dark'); w.setDark(dark); }
            // Ctrl+Z right after puts back the draft; GTK's own undo does not see text set by the program.
            ok((writer as unknown as { undo(k: number, s: number): boolean }).undo(Gdk.KEY_z, Gdk.ModifierType.CONTROL_MASK), 'Ctrl+Z was not handled');
            eq(w.history.message.text, 'my draft');

            // Stop keeps what was written so far.
            writer.button.emit('clicked');
            onText('Half');
            writer.button.emit('clicked');
            ok(cancellable!.cancelled, 'Stop did not cancel');
            finish({ ok: true, message: 'Half', shortened: false, cancelled: true });
            ok(waitFor(() => !writer.busy), 'still busy');
            eq(w.history.message.text, 'Half');
            ok(w.history.commitStatus.get_text().startsWith('Stopped'), w.history.commitStatus.get_text());

            // A failure puts back the text and says why; no key links to the settings.
            w.history.message.text = 'typed';
            writer.button.emit('clicked');
            onText('Partial');
            finish({ ok: false, reason: 'failed', message: 'Cannot connect to DeepSeek.' });
            ok(waitFor(() => !writer.busy), 'still busy');
            eq(w.history.message.text, 'typed');
            ok(w.history.commitStatus.has_css_class('error'), 'the failure is not an error');
            ok(w.history.commitStatus.get_text().includes('Cannot connect to DeepSeek. The box'), w.history.commitStatus.get_text());
            writer.button.emit('clicked');
            finish({ ok: false, reason: 'no-key', message: '' });
            ok(waitFor(() => !writer.busy), 'still busy');
            ok(w.history.commitStatus.get_label().includes('<a href="settings">'), w.history.commitStatus.get_label());
            shot('no-key');

            // While a commit runs, a new message cannot start (and so cannot unlock Commit when it ends).
            const before = calls.length;
            writer.locked = true;
            ok(!writer.button.sensitive, 'the button can write during a commit');
            eq(writer.button.get_tooltip_text(), 'Committing…');
            writer.button.emit('clicked');
            eq(calls.length, before, 'a message was written during a commit');
            writer.locked = false;
            ok(writer.button.sensitive, 'the button stays locked after the commit');

            w.history.message.text = 'docs(samples): misspell the first heading so the editor shows a spelling mark';
            shot('long');

            check.active = false;
            ok(!writer.button.sensitive, 'the button can write without checked files');
            eq(writer.button.get_tooltip_text(), 'Check the files to describe first');
            check.active = true;
        } finally {
            writer.write = real;
            w.history.message.text = '';
            setStatus(w.history.commitStatus, '');
        }
        git('add', '-A');
        git('commit', '-q', '-m', 'Add e');
        history.refresh();
        ok(waitFor(() => !w.history.changedBox.get_visible()), 'the list did not vanish');
    });
    test('the changes window has the same assistant button; the controller writes from only its file', () => {
        write(a, V2 + 'three\nfour\nfive\nsix\n');
        const chat = w.session.assistant.chat;
        const { keyStore, makeProvider } = chat;
        const asked: string[] = [];
        chat.keyStore = { get: async () => ({ key: 'test', source: 'env' }), set: async () => 'env', clear: async () => {} };
        chat.makeProvider = () => ({
            chat: async (req): Promise<ChatResult> => {
                asked.push(String(req.messages[req.messages.length - 1].content));
                req.onText('Add line ');
                req.onText('six');
                return { usage: null, cancelled: false, toolCalls: [], reasoning: '' };
            },
        });
        history.openChanges(a);
        const viewer = opened();
        try {
            ok(viewer.writer.button.get_visible() && viewer.writer.button.sensitive, 'the button is not usable');
            viewer.writer.button.emit('clicked');
            ok(waitFor(() => !viewer.writer.busy), 'still busy');
            eq(viewer.message.text, 'Add line six');
            eq(asked.length, 1, 'the model was not asked once');
            ok(asked[0].includes('+six') && !asked[0].includes('e.md'), 'the prompt is not the diff of a.md alone');
            ok(viewer.status.get_text().includes('from 1 file'), viewer.status.get_text());
            shot('viewer', viewer.window);
        } finally {
            chat.keyStore = keyStore;
            chat.makeProvider = makeProvider;
            viewer.window.destroy();
        }
        git('commit', '-q', '-a', '-m', 'Add line six');
    });

    // Restore the state for the next tests.
    Object.assign(history.dialogs, dialogs);
    w.sidebar.setPage('outline');
    w.file = null; setText('');
}
