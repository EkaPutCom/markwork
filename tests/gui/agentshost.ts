// GUI tests: agents that run in the markworkd daemon on another machine (an in-memory stand-in for the daemon, so no
// ssh is ever started): found again when Markwork opens, started from a card, the project folder on that machine, the
// question when the window closes, the connection state on Home, and the Preferences page.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { section, test, eq, ok, contains, tmp, optVal } from '../framework.js';
import { PreferencesDialog } from '../../src/ui/preferences.js';
import { findEntry } from '../../src/ui/menu.js';
import { AppSettings } from '../../src/settings.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { FakeDaemon } from '../unit/daemon-fake.js';
import type { GuiContext } from './context.js';

const ev = (o: object) => JSON.stringify(o);
const STATE = ev({ id: 'markwork-state', type: 'response', command: 'get_state', success: true, data: { sessionId: 'remote-session' } });
const TEXT = (text: string) => ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
const SETTLED = ev({ type: 'agent_settled' });

const BOARD = (column: 'plan' | 'doing') => `---
layout: board
project: shop
---

## Plan

${column === 'plan' ? '- [ ] Checkout [agent:: pi] #feature\n' : ''}
## In Progress

${column === 'doing' ? '- [ ] Checkout [agent:: pi] #feature\n' : ''}
## Review

## Done
`;

export function agentsHostTests(c: GuiContext): void {
    const { pump } = c;
    section('Agents on another machine');

    const dir = GLib.dir_make_tmp('markwork-agentshost-XXXXXX');
    const board = GLib.build_filenamev([dir, 'board.md']);
    const settle = (n = 30) => { for (let i = 0; i < n; i++) { pump(); GLib.usleep(8000); } };
    const waitFor = (cond: () => boolean, ms = 5000) => {
        for (let i = 0; i < ms / 10 && !cond(); i++) { pump(); GLib.usleep(10000); }
        pump();
        return cond();
    };

    const daemon = new FakeDaemon();
    daemon.expectBridgeSentinel = true;
    let unreachable = false;
    const openers = { socket: () => { throw new Error('no socket'); }, command: (argv: string[]) => { if (unreachable) throw new Error('connection refused'); void argv; return daemon.open(); } };

    // A window whose agents run on the machine "vps" (or another choice), with the daemon replaced.
    const open = (column: 'plan' | 'doing', extra: Partial<AppSettings> = {}) => {
        GLib.file_set_contents(board, BOARD(column));
        const settings = AppSettings.inMemory({ welcomed: true, home: false, dark: false, autosave: false, folder: dir, sidebar: false, machines: { vps: 'eka@vps.example.com' }, machineProjects: { 'vps:shop': '/srv/shop' }, ...extra });
        const win = new MainWindow(c.app, settings, null);
        win.harness.openers = openers;   // before the first idle, which is when the daemon is first looked for
        settle();
        win.load(board);
        settle();
        return { win, settings };
    };
    // Each test starts with a daemon that has nothing, so a run left by an earlier test is not found again.
    const reset = () => { daemon.runs.clear(); daemon.requests.length = 0; };
    const runOf = (win: MainWindow) => win.harness.orchestrator.queue.runs.find(r => r.board === board) ?? null;
    const cardAt = (win: MainWindow, column: number) => { const cols = win.board.getBoard().columns; if (!cols[column]) throw new Error(`no column ${column}; the board has ${cols.length}: ${cols.map(x => x.title).join(',')}; boardMode=${win.boardMode}; file=${win.file}`); return cols[column].cards.map(card => card.text); };
    const homeLabels = (win: MainWindow) => descendants(win.home.widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label());
    // A new MainWindow takes over the application's actions; they go back to the shared window when it is closed.
    const close = (win: MainWindow) => { win.win.destroy(); settle(10); registerActions(c.app, c.w); };

    test('a run that kept working while Markwork was closed is found again, follows on, and finishes the card', () => {
        reset();
        daemon.seed({ run: 'mw-old', labels: { agent: 'pi', project: 'shop', board, card: 'Checkout [agent:: pi] #feature', title: 'Checkout', host: GLib.get_host_name() } },
            [['in', ev({ id: 'markwork-state', type: 'get_state' })], ['out', STATE], ['out', ev({ type: 'turn_start' })], ['out', ev({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: 'checkout.ts' } })]]);
        const { win } = open('doing', { harnessMachine: 'vps' });
        ok(waitFor(() => runOf(win)?.status === 'working'), `status: ${runOf(win)?.status}`);
        eq(runOf(win)?.folder, '/srv/shop');
        eq(win.harness.hostStatus()?.state, 'ready');
        contains(runOf(win)!.trace.text(), 'edit');
        win.board.render();
        eq(win.harness.orchestrator.activity().detachable, 1);

        daemon.out('mw-old', TEXT('QRIS checkout added in checkout.ts'));
        daemon.out('mw-old', SETTLED);
        ok(waitFor(() => daemon.requestsOf('close_stdin').length === 1), 'a finished turn closes the harness\'s input');
        daemon.finish('mw-old', { reason: 'exited', code: 0 });
        ok(waitFor(() => runOf(win)?.status === 'done'), `status: ${runOf(win)?.status}`);
        eq(cardAt(win, 2), ['Checkout [agent:: pi] #feature'], 'moved to Review');
        contains(win.board.getBoard().columns[2].cards[0].notes.join('\n'), 'QRIS checkout added');
        ok(waitFor(() => daemon.requestsOf('forget').length === 1), 'the daemon is told it can drop the run');
        eq(runOf(win)?.result?.sessionId, 'remote-session', 'a reply can continue the harness session');
        close(win);
    });

    test('a run from another computer, or for a card that is gone, is not taken', () => {
        reset();
        daemon.seed({ run: 'mw-other-host', labels: { agent: 'pi', project: 'shop', board, card: 'Checkout [agent:: pi] #feature', title: 'Checkout', host: 'some-other-computer' } }, [['out', STATE]]);
        daemon.seed({ run: 'mw-gone-card', labels: { agent: 'pi', project: 'shop', board, card: 'A card nobody has', title: 'Gone', host: GLib.get_host_name() } }, [['out', STATE]]);
        daemon.seed({ run: 'mw-no-labels' }, [['out', STATE]]);
        const { win } = open('doing', { harnessMachine: 'vps' });
        ok(waitFor(() => win.harness.hostStatus()?.state === 'ready'), 'connected');
        settle();
        eq(win.harness.orchestrator.queue.runs.length, 0);
        close(win);
    });

    test('with agents on a machine, a card starts a run there: the program by name, the folder of that machine, the project as the lane', () => {
        reset();
        const { win } = open('plan', { harnessMachine: 'vps' });
        ok(waitFor(() => win.harness.hostStatus()?.state === 'ready'), 'connected');
        const before = daemon.requestsOf('spawn').length;
        findEntry(win.board.cardMenu(0, 0), 'Work on it with pi')!.run!();
        ok(waitFor(() => daemon.requestsOf('spawn').length === before + 1), 'spawn was sent');
        const req = daemon.requestsOf('spawn')[before];
        eq([req.program, req.cwd, req.lane, req.labels.project, req.labels.board], ['pi', '/srv/shop', 'shop', 'shop', board]);
        eq(req.args.slice(0, 2), ['--mode', 'rpc']);
        const id = req.run as string;
        ok(waitFor(() => (daemon.runs.get(id)?.inputs.length ?? 0) >= 2), 'get_state and the prompt were written');
        contains(daemon.runs.get(id)!.inputs[1], 'Checkout');
        eq(cardAt(win, 1), ['Checkout [agent:: pi] #feature'], 'moved to In Progress');

        daemon.out(id, STATE);
        daemon.out(id, TEXT('Done.'));
        daemon.out(id, SETTLED);
        daemon.finish(id, { reason: 'exited', code: 0 });
        ok(waitFor(() => runOf(win)?.status === 'done'), `status: ${runOf(win)?.status}`);
        eq(cardAt(win, 2), ['Checkout [agent:: pi] #feature']);
        close(win);
    });

    test('the project folder on another machine is typed, not browsed: it must be absolute, and it is kept per machine', () => {
        reset();
        const { win, settings } = open('plan', { harnessMachine: 'vps', machineProjects: {} });
        ok(waitFor(() => win.harness.hostStatus()?.state === 'ready'), 'connected');
        const asked: string[] = [];
        let answer: string | null = 'relative/dir';
        win.harness.dialogs = { ...win.harness.dialogs, remoteFolder: (machine, project) => { asked.push(`${machine}:${project}`); return answer; } };
        const spawns = daemon.requestsOf('spawn').length;
        findEntry(win.board.cardMenu(0, 0), 'Work on it with pi')!.run!();
        settle();
        eq(asked, ['vps:shop']);
        contains(win.lastToast, 'absolute');
        eq(daemon.requestsOf('spawn').length, spawns, 'nothing started');
        eq(settings.machineProjects, {});
        answer = '/srv/shop';
        findEntry(win.board.cardMenu(0, 0), 'Work on it with pi')!.run!();
        ok(waitFor(() => daemon.requestsOf('spawn').length === spawns + 1), 'started');
        eq(settings.machineProjects, { 'vps:shop': '/srv/shop' });
        eq(settings.projects, {}, 'the local mapping is untouched');
        close(win);
    });

    test('closing the window while agents work asks: stop them, keep those on the daemon going, or stay', () => {
        reset();
        daemon.seed({ run: 'mw-close', labels: { agent: 'pi', project: 'shop', board, card: 'Checkout [agent:: pi] #feature', title: 'Checkout', host: GLib.get_host_name() } }, [['out', STATE]]);
        const { win } = open('doing', { harnessMachine: 'vps' });
        ok(waitFor(() => runOf(win)?.status === 'working'), 'following');
        const seen: object[] = [];
        let choice: 'cancel' | 'stop' | 'keep' = 'cancel';
        win.harness.dialogs = { ...win.harness.dialogs, closeAgents: activity => { seen.push(activity); return choice; } };
        eq(win.harness.confirmClose(), false, 'cancel: the window stays');
        choice = 'keep';
        eq(win.harness.confirmClose(), true);
        choice = 'stop';
        eq(win.harness.confirmClose(), true);
        eq(seen[0], { children: 0, detachable: 1, queued: 0 });
        eq(seen.length, 3);
        daemon.out('mw-close', TEXT('Done.'));
        daemon.out('mw-close', SETTLED);
        daemon.finish('mw-close', { reason: 'exited', code: 0 });
        ok(waitFor(() => runOf(win)?.status === 'done'), `ended: ${runOf(win)?.status}`);
        eq(win.harness.confirmClose(), true, 'nothing running: no question');
        eq(seen.length, 3);
        close(win);
    });

    test('Home says where agents run and whether that machine answers, and the user is told when it does not', () => {
        reset();
        unreachable = true;
        const { win } = open('plan', { harnessMachine: 'vps' });
        ok(waitFor(() => win.harness.hostStatus()?.state === 'waiting'), `state: ${win.harness.hostStatus()?.state}`);
        eq(win.harness.hostStatus()?.detail, 'connection refused');
        contains(win.lastToast, 'Cannot reach vps: connection refused');
        win.openHome();
        settle();
        const labels = homeLabels(win);
        ok(labels.includes('Agents run on vps') || descendants(win.home.widget).some(x => x instanceof Adw.ActionRow && x.title === 'Agents run on vps'), 'the machine row');
        ok(labels.includes('Trying again'), `labels: ${labels.join(' | ')}`);

        unreachable = false;
        ok(waitFor(() => win.harness.hostStatus()?.state === 'ready', 4000), 'connected after a retry');
        contains(win.lastToast, 'Connected to vps again');
        settle();
        ok(homeLabels(win).includes('Connected'), 'Home shows it');
        const shot = optVal('shot-agents');
        if (shot) {
            settle(40);
            widgetPixbuf(win.win)?.savev(`${shot}-home-connected.png`, 'png', [], []);
            win.setDark(true);
            settle(40);
            widgetPixbuf(win.win)?.savev(`${shot}-home-connected-dark.png`, 'png', [], []);
            win.setDark(false);
        }
        close(win);
    });

    test('with agents in this window there is no machine row on Home', () => {
        reset();
        const { win } = open('plan', { harnessMachine: '' });
        win.openHome();
        settle();
        eq(win.harness.hostStatus(), null);
        ok(!descendants(win.home.widget).some(x => x instanceof Adw.ActionRow && x.title.startsWith('Agents run on')), 'no machine row');
        close(win);
    });

    test('Preferences: where agents run is chosen from the machines, and a machine can be removed', () => {
        reset();
        const { win, settings } = open('plan', { harnessMachine: '', machines: { vps: 'eka@vps.example.com', nas: 'nas' }, machineProjects: { 'vps:shop': '/srv/shop', 'nas:shop': '/data/shop' } });
        win.win.present();
        c.app.activate_action('preferences', null);
        settle();
        const dialog = win.win.get_visible_dialog();
        ok(dialog instanceof PreferencesDialog, 'the preferences dialog is shown');
        const widgets = descendants(dialog as Adw.Dialog);
        const combo = widgets.find((x): x is Adw.ComboRow => x instanceof Adw.ComboRow && x.title === 'Run agents')!;
        const items = () => { const m = combo.model!; return Array.from({ length: m.get_n_items() }, (_v, i) => (m.get_item(i) as Gtk.StringObject).string); };
        eq(items(), ['In this window', 'This computer (markworkd)', 'vps', 'nas']);
        eq(combo.selected, 0);

        combo.selected = 2;
        settle();
        eq(settings.harnessMachine, 'vps');
        combo.selected = 1;
        settle();
        eq(settings.harnessMachine, 'local');
        settings.harnessMachine = 'nas';
        settle();
        eq(combo.selected, 3, 'the row follows the setting');

        const shot = optVal('shot-agents');
        if (shot) {
            const page = widgets.find((x): x is Adw.PreferencesPage => x instanceof Adw.PreferencesPage && x.title === 'Agents')!;
            (dialog as Adw.PreferencesDialog).set_visible_page(page);
            settle(40);
            const light = widgetPixbuf(dialog as Adw.Dialog);
            light?.savev(`${shot}-preferences.png`, 'png', [], []);
            win.setDark(true);
            settle(40);
            widgetPixbuf(dialog as Adw.Dialog)?.savev(`${shot}-preferences-dark.png`, 'png', [], []);
            win.setDark(false);
            settle(20);
        }

        const rowOf = (name: string) => descendants(dialog as Adw.Dialog).find((x): x is Adw.ActionRow => x instanceof Adw.ActionRow && x.title === name)!;
        eq(rowOf('nas').subtitle, 'nas');
        const remove = descendants(rowOf('nas')).find((x): x is Gtk.Button => x instanceof Gtk.Button && x.icon_name === 'user-trash-symbolic')!;
        remove.emit('clicked');
        settle();
        eq(Object.keys(settings.machines), ['vps']);
        eq(settings.harnessMachine, '', 'the removed machine was the chosen one: back to this window');
        eq(settings.machineProjects, { 'vps:shop': '/srv/shop' }, 'its project folders are forgotten with it');
        eq(items(), ['In this window', 'This computer (markworkd)', 'vps']);
        (dialog as Adw.Dialog).force_close();
        settle(20);
        close(win);
    });

    const shot = optVal('shot-agents');
    if (shot) {
        test('screenshot: the question when the window closes', () => {
            reset();
            const { win } = open('plan', { harnessMachine: 'vps' });
            for (const [name, dark] of [['close', false], ['close-dark', true]] as const) {
                win.setDark(dark);
                void win.harness.dialogs.closeAgents({ children: 0, detachable: 2, queued: 1 });
                settle(60);   // the dialog fades in
                const dialog = win.win.get_visible_dialog();
                ok(dialog, 'the question is shown');
                widgetPixbuf(dialog!)?.savev(`${shot}-${name}.png`, 'png', [], []);
                dialog!.force_close();
                settle(30);
            }
            win.setDark(false);
            close(win);
        });
    }
    void tmp;
}
