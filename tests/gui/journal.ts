// GUI tests: the daily journal (open/create, quick capture, activity from the board, agent, harness, and git, the row on Home,
// summary through the Assistant) in a separate window with a temporary work folder.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { section, test, eq, ok, tmp, optVal, settle as settlePromise } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import { localDate } from '../../src/markdown/home.js';
import { clock } from '../../src/markdown/journal.js';
import { readActivity } from '../../src/activity.js';
import { AppSettings } from '../../src/settings.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
import type { ChatRequest, Provider } from '../../src/agent/provider.js';
import type { KeyStore } from '../../src/agent/apikey.js';
import type { HarnessResult } from '../../src/agent/harness.js';
import { promptDialog } from '../../src/ui/dialogs.js';
import { descendants, whenDialogReady, widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';
import { inMemorySettings } from '../../src/platform/gjs/settings.js';

export function journalTests(c: GuiContext): void {
    const { w, pump } = c;

    section('Journal');
    const ws = GLib.build_filenamev([tmp, 'journal-work']);
    GLib.mkdir_with_parents(ws, 0o755);
    const path = (name: string) => GLib.build_filenamev([ws, ...name.split('/')]);
    const put = (name: string, text: string) => { GLib.file_set_contents(path(name), text); return path(name); };
    const today = localDate(new Date());
    const journal = path(`journal/${today}.md`);
    const BOARD = '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Release material\n- [ ] Research prices\n\n## In Progress\n\n## Done\n';
    const board = put('tasks.md', BOARD);
    put('plan.md', '# Plan\n\nRelease on 15 November.\n');

    // A git repo with one commit today, so the Activity section also contains a commit.
    const git = (...args: string[]) => {
        const [okRun, , err, status] = GLib.spawn_sync(ws, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], null, GLib.SpawnFlags.SEARCH_PATH, null);
        if (!okRun || status !== 0) throw new Error(`git ${args.join(' ')} failed: ${ new TextDecoder().decode(err ?? new Uint8Array())}`);
    };
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'Prepare the release board');

    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(8000); } };
    const rowTitles = (win: MainWindow) => descendants(win.home.widget).filter((x): x is Adw.ActionRow => x instanceof Adw.ActionRow).map(r => [r.title, r.subtitle]);
    const open = (extra: Partial<AppSettings> = {}) => {
        const s = inMemorySettings({ welcomed: true, dark: false, autosave: false, folder: ws, sidebar: false, chat: false, ...extra });
        const win = new MainWindow(c.app, s, null);
        settle();
        return { win, s };
    };
    const close = (win: MainWindow) => {
        for (let i = 0; i < 10; i++) win.editor.buffer.set_modified(false);
        win.win.destroy();
        settle();
        registerActions(c.app, w);
    };

    test('without a work folder, the journal is not opened and the user is told', () => {
        const { win } = open({ folder: null });
        eq(win.journal.open(), null);
        ok(win.lastToast.includes('work folder'), `toast: ${win.lastToast}`);
        let asked = false;
        win.journal.dialogs = { capture: () => { asked = true; return 'x'; } };
        win.journal.capture();
        ok(!asked, 'the quick-capture dialog appeared without a work folder');
        eq(win.homePage.data().journal, null, 'a Journal row on Home without a work folder');
        close(win);
    });

    test('Ctrl+Shift+J without an open journal: a time-stamped note is written to a new file from the template', () => {
        const { win } = open();
        const now = new Date();
        win.journal.dialogs = { capture: () => 'Opening files got faster' };
        win.journal.capture(); settle();
        const text = readTextFile(journal);
        ok(text.startsWith('# ') && text.includes('## Today\'s focus') && text.includes('## Summary'), `template: ${text}`);
        ok(new RegExp(`## Notes\\n\\n- \\d\\d:\\d\\d Opening files got faster\\n\\n## Activity`).test(text), `notes: ${text}`);
        ok(text.includes(`- ${clock(now)} `) || text.includes(`- ${clock(new Date())} `), 'note time');
        ok(win.homeMode, 'quick capture switched away from Home');
        win.journal.dialogs = { capture: () => null };
        win.journal.capture(); settle();
        eq(readTextFile(journal), text, 'a cancelled dialog changed the journal');
        close(win);
    });

    test('board and agent activity is recorded in the daily log', () => {
        const { win } = open();
        win.openFile(board); settle();
        ok(win.boardMode, 'the board is not shown as a board');
        win.board.edit({ kind: 'move', at: { column: 0, index: 0 }, card: win.board.getBoard().columns[0].cards[0].text, to: { column: 1, index: 0 } }); settle();
        const error = win.session.assistant.chat.host.applyChange!({ kind: 'edit', file: 'plan.md', before: '# Plan\n\nRelease on 15 November.\n', after: '# Plan\n\nRelease on 22 November.\n', reason: 'test' });
        eq(error, null, 'agent change');
        const texts = readActivity(ws, today).map(a => a.text);
        eq(texts, ['Card “Release material” → In Progress · [[tasks]]', 'Agent changed [[plan]]']);
        win.closeTab(); settle();   // the board is not saved: discard
        close(win);
        GLib.file_set_contents(board, BOARD);
    });

    test('editing the board text in text mode is not recorded as activity', () => {
        const { win } = open();
        const before = readActivity(ws, today).length;
        win.openFile(board); settle();
        win.toggleBoardView(false); settle();
        win.editor.replaceText(BOARD.replace('- [ ] Research prices', '- [x] Research prices'));
        win.toggleBoardView(true); settle();
        eq(readActivity(ws, today).length, before, 'a board text edit was recorded as activity');
        win.closeTab(); settle();
        close(win);
    });

    test('a finished harness result is recorded once', () => {
        const { win } = open();
        const before = readActivity(ws, today).length;
        const run = win.harness.orchestrator.queue.add({ board: board, card: 'Fix checkout [agent:: pi]', title: 'Fix checkout', agent: 'pi', project: 'shop', folder: '/tmp/shop', prompt: '', session: null });
        const result: HarnessResult = { ok: true, summary: 'Done', error: null, cost: 0, tokens: 0, sessionId: null };
        win.harness.orchestrator.queue.end(run, 'done', result);
        const host = (win.harness.orchestrator as unknown as { host: { changed: (r: typeof run, m: string | null) => void } }).host;
        host.changed(run, null);
        host.changed(run, null);
        const texts = readActivity(ws, today).map(a => a.text).slice(before);
        eq(texts, ['pi finished “Fix checkout” in project shop']);
        close(win);
    });

    test('opening the journal merges the log and commits of today into Activity, without duplicating', () => {
        const { win } = open();
        const filling = win.journal.open();
        ok(filling, 'the journal did not open');
        settlePromise(filling!);
        eq(win.file, journal, 'journal tab');
        const text = win.editor.getText();
        const activity = text.slice(text.indexOf('## Activity'), text.indexOf('## Summary'));
        for (const line of ['Card “Release material” → In Progress · [[tasks]]', 'Agent changed [[plan]]', 'pi finished “Fix checkout”', 'Prepare the release board'])
            ok(activity.includes(line), `activity without "${line}":\n${activity}`);
        ok(/- \d\d:\d\d Commit `[0-9a-f]{7,}` Prepare the release board/.test(activity), 'commit line');
        ok(text.includes('Opening files got faster'), 'the earlier note vanished');
        // One undo step restores the file contents.
        win.editor.buffer.undo();
        eq(win.editor.getText(), readTextFile(journal), 'undo of filling in the activity');
        win.editor.buffer.redo();
        win.save(); settle();
        eq(win.documentCount, 2, 'number of tabs (Home + journal)');
        settlePromise(win.journal.open()!);
        eq(win.editor.getText(), readTextFile(journal), 'the activity was duplicated when opened again');
        eq(win.documentCount, 2, 'the journal opened in a new tab again');
        close(win);
    });

    test('quick capture while the journal is open writes through the editor (one undo step), not the disk', () => {
        const { win } = open();
        settlePromise(win.journal.open()!);
        win.openHome(); settle();
        const disk = readTextFile(journal);
        win.journal.dialogs = { capture: () => '! Flatpak cannot be tested yet' };
        win.journal.capture(); settle();
        eq(readTextFile(journal), disk, 'the disk was touched although the journal is open');
        win.switchTab(1); settle();
        ok(win.editor.getText().includes(' ! Flatpak cannot be tested yet\n\n## Activity'), 'the note at the end of the Notes section');
        win.editor.buffer.undo();
        eq(win.editor.getText(), disk, 'undo of quick capture');
        close(win);
    });

    test('Home: the journal row for today with the number of notes and activities', () => {
        const { win } = open();
        const data = win.homePage.data();
        eq(data.journal, { exists: true, notes: 1, activity: 3 });
        const row = rowTitles(win).find(([title]) => title === 'Today\'s journal');
        eq(row, ['Today\'s journal', '1 note · 3 activities']);
        const capture = descendants(win.home.widget).find((x): x is Gtk.Button => x instanceof Gtk.Button && x.get_tooltip_text() === 'Add to Journal…');
        ok(capture, 'the quick-capture button');
        let asked = false;
        win.journal.dialogs = { capture: () => { asked = true; return null; } };
        capture!.emit('clicked');
        ok(asked, 'the capture button did not open a dialog');
        descendants(win.home.widget).find((x): x is Adw.ActionRow => x instanceof Adw.ActionRow && x.title === 'Today\'s journal')!.emit('activated');
        settle(); settle();
        eq(win.file, journal, 'the row did not open the journal');
        close(win);
    });

    test('summarize the journal: the Assistant is asked with the journal as the active document', () => {
        const { win, s } = open();
        const seen: ChatRequest[] = [];
        const provider: Provider = {
            async chat(req) {
                seen.push(req);
                req.onText('Ready.');
                return { usage: { prompt: 10, cached: 0, completion: 2 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        };
        const keyStore: KeyStore = { get: async () => ({ key: 'test', source: 'keyring' }), set: async () => 'keyring', clear: async () => {} };
        win.session.assistant.chat.makeProvider = () => provider;
        win.session.assistant.chat.keyStore = keyStore;
        const asking = win.journal.summarize();
        ok(asking, 'the summary did not run');
        settlePromise(asking!);
        settle();
        ok(s.chat, 'the Assistant panel did not open');
        eq(win.file, journal, 'the journal is not the active document');
        const sent = JSON.stringify(seen[0] ?? {});
        ok(sent.includes('Close the day') && sent.includes(`journal/${today}.md`), 'summary question');
        win.chat.reset();
        close(win);
    });

    // --shot-journal=<prefix>: save <prefix>-journal.png, -journal-dark.png, -home.png, -capture.png.
    const shot = optVal('shot-journal');
    if (!shot) return;
    const { win } = open({ width: 1100, height: 760, sidebar: true });
    settlePromise(win.journal.open()!);
    const save = (name: string) => {
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        widgetPixbuf(win.win)?.savev(`${shot}-${name}.png`, 'png', [], []);
    };
    win.setDark(false); save('journal');
    win.setDark(true); save('journal-dark');
    win.setDark(false);
    win.openHome(); save('home');
    // The real quick-capture dialog, captured and then closed from a timer.
    whenDialogReady(() => win.win.get_visible_dialog(), dialog => {
        widgetPixbuf(win.win)?.savev(`${shot}-capture.png`, 'png', [], []);
        dialog.close();
    });
    settlePromise(promptDialog(win.win, { title: 'Add to Journal', label: "Recorded in today's journal with the current time.", accept: 'Add' }));
    close(win);
}
