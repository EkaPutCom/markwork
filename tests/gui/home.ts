// GUI tests: the Home tab (due dates, inbox, recent files, agents) in a separate window with a temporary work folder.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import { localDate } from '../../src/markdown/home.js';
import { AppSettings } from '../../src/settings.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';

export function homeTests(c: GuiContext): void {
    const { w, pump } = c;

    section('Home');
    const ws = GLib.build_filenamev([tmp, 'home']);
    GLib.mkdir_with_parents(GLib.build_filenamev([ws, 'projects', 'delta']), 0o755);
    GLib.mkdir_with_parents(GLib.build_filenamev([ws, 'journal']), 0o755);
    const path = (name: string) => GLib.build_filenamev([ws, ...name.split('/')]);
    const put = (name: string, text: string) => { GLib.file_set_contents(path(name), text); return path(name); };
    const day = (offset: number) => localDate(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
    const BOARD = `---\nkanban: true\n---\n\n## Plan\n\n- [ ] Implement search #project/nyerat [due:: ${day(0)}]\n- [ ] Review architecture [due:: ${day(1)}]\n- [ ] Old report [due:: ${day(-2)}]\n- [ ] Later [due:: ${day(10)}]\n\n## Done\n\n- [x] Already done [due:: ${day(0)}]\n`;
    const board = put('board.md', BOARD);
    put('inbox.md', '---\ninbox: true\n---\n\n- Idea one\n- Idea two\n- [x] Already processed\n');
    const architecture = put('projects/delta/architecture.md', '# Architecture\n');
    const summary = put('projects/delta/summary.md', '# Summary\n');
    const journal = put('journal/2026-10-06.md', '# Journal\n');

    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(8000); } };
    const labels = (win: MainWindow) => descendants(win.home.widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label && x.get_mapped()).map(l => l.get_label());
    const rowTitles = (win: MainWindow) => descendants(win.home.widget).filter((x): x is Adw.ActionRow => x instanceof Adw.ActionRow).map(r => r.title);
    const actionEnabled = (name: string) => c.app.lookup_action(name)?.get_enabled();
    const open = (extra: Partial<AppSettings> = {}) => {
        const s = AppSettings.inMemory({ welcomed: true, dark: false, autosave: false, folder: ws, sidebar: false, ...extra });
        const win = new MainWindow(c.app, s, null);
        settle();
        return { win, s };
    };
    const close = (win: MainWindow) => {
        win.win.destroy();
        settle();
        registerActions(c.app, w);
    };

    test('without a saved tab, the window opens on Home', () => {
        const { win } = open();
        ok(win.homeMode, 'Home is not shown');
        eq(win.documentName, 'Home', 'tab name');
        ok(!win.statusBar.get_visible(), 'the status bar is still shown');
        ok(!actionEnabled('save') && !actionEnabled('bold') && !actionEnabled('undo'), 'document actions are still enabled');
        ok(win.save() === true && win.file === null, 'Save on Home must not open a dialog');
        close(win);
    });
    test('due dates: overdue, today, tomorrow; far ones and finished ones are excluded', () => {
        const { win } = open();
        eq(win.homePage.data().tasks.map(t => [t.title, t.status]), [['Old report', 'overdue'], ['Implement search', 'today'], ['Review architecture', 'soon']]);
        const all = labels(win);
        ok(all.includes('2 days overdue') && all.includes('Today') && all.includes('Tomorrow'), `due-date labels: ${all.join('|')}`);
        ok(all.includes('nyerat · board'), 'project and board in the subtitle');
        ok(!rowTitles(win).includes('Later') && !rowTitles(win).includes('Already done'), 'a far/finished card is not shown');
        close(win);
    });
    test('inbox: the number of unprocessed items', () => {
        const { win } = open();
        eq(win.homePage.data().inboxes, [{ file: 'inbox.md', open: 2 }]);
        ok(labels(win).includes('2 unprocessed'), 'inbox label');
        close(win);
    });
    test('opening a file from Home opens a new tab; Home remains and is not duplicated', () => {
        const { win } = open();
        win.openFile(architecture); settle();
        win.openFile(summary); settle();
        win.openFile(journal); settle();
        eq(win.documentCount, 4, 'number of tabs');
        ok(!win.homeMode, 'still on Home after opening the file');
        win.openHome(); settle();
        ok(win.homeMode, 'Alt+Home did not return to Home');
        eq(win.documentCount, 4, 'Home was duplicated');
        const data = win.homePage.data();
        eq(data.resume.map(r => [r.title, r.subtitle]), [['journal', '2026-10-06.md'], ['delta', 'summary.md']], 'one Continue card per folder');
        eq(data.recent.map(r => [r.title, r.subtitle]), [['architecture.md', 'projects/delta']], 'recent files');
        ok(labels(win).includes('Continue') && labels(win).includes('Recent files'), 'section titles');
        close(win);
    });
    test('checking a task writes [x] to the board, unchecking restores it', () => {
        const { win } = open();
        const checks = () => descendants(win.home.widget).filter((x): x is Gtk.CheckButton => x instanceof Gtk.CheckButton);
        eq(checks().length, 3, 'checkboxes');
        checks()[1].active = true; settle();
        ok(readTextFile(board).includes(`- [x] Implement search #project/nyerat [due:: ${day(0)}]`), 'the card was not checked on disk');
        ok(checks()[1].active, 'the check stays visible until redrawn');
        checks()[1].active = false; settle();
        eq(readTextFile(board), BOARD, 'unchecking did not restore the board');
        // The card changed outside after Home was drawn: the check is refused and the board is not touched.
        GLib.file_set_contents(board, BOARD.replace('Review architecture', 'Review again'));
        checks()[2].active = true; settle();
        ok(readTextFile(board).includes('- [ ] Review again'), 'the changed card was checked too');
        ok(win.lastToast.includes('changed'), `toast: ${win.lastToast}`);
        GLib.file_set_contents(board, BOARD);
        close(win);
    });
    test('a board that is open and unsaved: due dates are read and checked through its editor', () => {
        const { win } = open();
        win.openFile(board); settle();
        win.editor.replaceText(BOARD.replace('Old report', 'Revised report'));
        win.openHome(); settle();
        ok(rowTitles(win).includes('Revised report'), 'the unsaved editor contents were not read');
        const check = descendants(win.home.widget).find((x): x is Gtk.CheckButton => x instanceof Gtk.CheckButton)!;
        check.active = true; settle();
        win.switchTab(1); settle();
        ok(win.editor.getText().includes('- [x] Revised report'), 'the board editor was not updated');
        eq(readTextFile(board), BOARD, 'the disk was touched although the board is open');
        win.editor.buffer.set_modified(false);
        close(win);
    });
    test('a running agent is shown with its status', () => {
        const { win } = open();
        const run = win.harness.orchestrator.queue.add({ board: board, card: 'Tidy up README [agent:: pi]', title: 'Tidy up README', agent: 'pi', project: 'shop', folder: '/tmp/shop', prompt: '', session: null });
        win.refreshHome(); settle();
        ok(labels(win).includes('Agent') && rowTitles(win).includes('Tidy up README') && labels(win).includes('Working'), `agent: ${labels(win).join('|')}`);
        win.harness.orchestrator.queue.end(run, 'stopped');
        win.refreshHome(); settle();
        ok(!labels(win).includes('Agent'), 'the Agent section is still shown after finishing');
        close(win);
    });
    test('closing the last tab returns to Home; Home is saved and restored as a tab', () => {
        const { win, s } = open();
        win.openFile(journal); settle();
        win.switchTab(-1); settle();
        win.closeTab(); settle();   // close Home
        eq(win.documentCount, 1, 'Home closed');
        ok(!win.homeMode, 'still Home');
        win.closeTab(); settle();   // close the last tab
        ok(win.homeMode, 'the last tab did not become Home');
        eq(win.documentName, 'Home', 'tab name');
        win.closeTab(); settle();
        ok(win.homeMode && win.documentCount === 1, 'Home as the last tab cannot vanish');
        win.openFile(journal); settle();
        ok(win.onClose(), 'onClose() refused');
        eq(s.tabs.map(t => t.file), ['nyerat:home', journal], 'saved tabs');
        close(win);
        const again = open({ tabs: s.tabs, activeTab: 0 });
        ok(again.win.homeMode, 'Home was not restored as the active tab');
        eq(again.win.documentCount, 2, 'number of tabs');
        close(again.win);
    });
    test('more than seven due dates are summarized; the "Show" row opens the rest', () => {
        const many = put('many.md', `---\nkanban: true\n---\n\n## Plan\n\n${Array.from({ length: 10 }, (_, i) => `- [ ] Task ${i} [due:: ${day(0)}]`).join('\n')}\n`);
        const { win } = open();
        const checks = () => descendants(win.home.widget).filter(x => x instanceof Gtk.CheckButton).length;
        eq(checks(), 7, 'due-date rows');
        const more = descendants(win.home.widget).find((x): x is Adw.ActionRow => x instanceof Adw.ActionRow && x.title.startsWith('Show'))!;
        eq(more.title, 'Show 6 more tasks', 'summary row');
        more.emit('activated'); settle();
        eq(checks(), 13, 'all due dates after opening');
        GLib.unlink(many);
        close(win);
    });
    test('the Home preference is off: closing the last tab empties the document as before', () => {
        const { win } = open({ home: false });
        ok(!win.homeMode, 'Home is shown although turned off');
        win.openHome(); settle();
        ok(win.homeMode, 'Alt+Home still opens Home');
        win.openFile(journal); settle();
        win.closeTab(); settle();
        win.closeTab(); settle();
        ok(!win.homeMode && win.file === null, 'the last tab was not emptied');
        close(win);
    });
    test('boards and inboxes after more than 300 notes are still read', () => {
        const notes = path('aaa');
        GLib.mkdir_with_parents(notes, 0o755);
        for (let i = 0; i < 320; i++) put(`aaa/note${i}.md`, '# Note\n');
        try {
            const { win } = open();
            const data = win.homePage.data();
            eq(data.tasks.map(t => t.title), ['Old report', 'Implement search', 'Review architecture'], 'due dates');
            eq(data.inboxes, [{ file: 'inbox.md', open: 2 }], 'inbox');
            close(win);
        } finally {
            for (let i = 0; i < 320; i++) GLib.unlink(path(`aaa/note${i}.md`));
            GLib.rmdir(notes);
        }
    });
    test('an unsaved tab that becomes a board is counted; one that stops being a board is not', () => {
        const { win } = open();
        win.openFile(summary); settle();
        win.editor.setText(`---\nkanban: true\n---\n\n## Plan\n\n- [ ] Write summary [due:: ${day(0)}]\n`);
        win.editor.buffer.set_modified(true);
        ok(win.homePage.data().tasks.some(t => t.title === 'Write summary' && t.file === 'projects/delta/summary.md'), 'the unsaved board is missing');
        win.openFile(board); settle();
        win.editor.setText('# Not a board any more\n');
        win.editor.buffer.set_modified(true);
        ok(!win.homePage.data().tasks.some(t => t.file === 'board.md'), 'the unsaved non-board still counts');
        for (const doc of [summary, board]) { win.openFile(doc); win.editor.buffer.set_modified(false); }
        close(win);
    });
    test('without a work folder and history: a welcome page with Open Folder', () => {
        const { win } = open({ folder: null });
        ok(labels(win).includes('Open Folder…') && labels(win).includes('New Document'), `welcome: ${labels(win).join('|')}`);
        close(win);
    });

    // --shot-home=<prefix>: save <prefix>-light.png, <prefix>-dark.png, <prefix>-narrow.png, and <prefix>-bottom.png.
    const shot = optVal('shot-home');
    if (!shot) return;
    const { win } = open({ width: 1100, height: 760 });
    for (const file of [architecture, summary, journal, board]) win.openFile(file);
    const queue = win.harness.orchestrator.queue;
    queue.wait(queue.add({ board: board, card: 'Tidy up README [agent:: pi]', title: 'Tidy up README', agent: 'pi', project: 'shop', folder: '/tmp/shop', prompt: '', session: null }),
        { kind: 'question', id: null, title: 'Which README?', message: '', options: [], prefill: '', timeout: null });
    win.openHome();
    for (const [name, dark, width] of [['light', false, 1100], ['dark', true, 1100], ['narrow', false, 480]] as const) {
        win.setDark(dark);
        win.win.set_default_size(width, 760);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        widgetPixbuf(win.win)?.savev(`${shot}-${name}.png`, 'png', [], []);
    }
    win.win.set_default_size(1100, 760);
    for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
    const adj = win.home.widget.vadjustment;
    adj.set_value(adj.upper - adj.page_size);
    for (let i = 0; i < 20; i++) { pump(); GLib.usleep(15000); }
    widgetPixbuf(win.win)?.savev(`${shot}-bottom.png`, 'png', [], []);
    win.setDark(false);
    win.win.set_default_size(1100, 700);
    close(win);
}
