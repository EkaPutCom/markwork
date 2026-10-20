// The app side of the daemon: the hub of connections per machine, and the orchestrator following a run again after
// Markwork was closed (history replayed, the one open question asked again, a run that ended meanwhile finished).

import type { Link } from '../../src/agent/daemon/client.js';
import { isRemoteMachine, isValidMachineName, isValidSshTarget, machineProjectKey } from '../../src/agent/daemon/machines.js';
import { sshBridgeArgv } from '../../src/agent/daemon/streamlink.js';
import { DaemonHub, LOCAL_MACHINE, localSocketPath, type Openers } from '../../src/orchestrator/hub.js';
import { Orchestrator, type AdoptInfo, type HarnessProcess, type SpawnHandlers } from '../../src/orchestrator/index.js';
import { parseBoard, type Board } from '../../src/markdown/kanban.js';
import { section, test, eq, ok, contains } from '../core/framework.js';
import { FakeDaemon, ManualTimers, flush } from './daemon-fake.js';

// ---------- the hub ----------

function hubWith(opts: { machines?: Record<string, string>; command?: string; installed?: boolean }) {
    const daemon = new FakeDaemon();
    daemon.expectBridgeSentinel = true;
    const calls: { kind: string; arg: string | string[] }[] = [];
    const openers: Openers = {
        socket: path => { calls.push({ kind: 'socket', arg: path }); return daemon.open(); },
        command: argv => { calls.push({ kind: 'command', arg: argv }); return daemon.open(); },
    };
    const hub = new DaemonHub({ machines: () => opts.machines ?? {}, daemonCommand: () => opts.command ?? '' }, openers, program => (opts.installed ? `/usr/bin/${program}` : null));
    return { daemon, calls, hub };
}

// ---------- following a run again ----------

const ev = (o: object) => JSON.stringify(o);
const STATE = ev({ id: 'markwork-state', type: 'response', command: 'get_state', success: true, data: { sessionId: 's-1' } });
const ASK = (extra: object = {}) => ev({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow the bash command?', message: 'rm -rf build', ...extra });
const ANSWER = ev({ type: 'extension_ui_response', id: 'ui-1', confirmed: true });
const TEXT = (text: string) => ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
const SETTLED = ev({ type: 'agent_settled' });

function follower() {
    let board: Board = parseBoard('---\nlayout: board\nproject: shop\n---\n\n## Plan\n\n## In Progress\n\n- [ ] Checkout [agent:: pi]\n\n## Review\n');
    const changes: string[] = [];
    const host = {
        workspace: () => null,
        linkedNotes: () => [],
        updateBoard: (_file: string, edit: (b: Board) => Board) => { board = edit(board); return null; },
        changed: (_run: unknown, message: string | null) => { if (message) changes.push(message); },
    };
    const orch = new Orchestrator(host);
    let handlers!: SpawnHandlers;
    let adoptedWith: { runId: string; upTo: number } | null = null;
    const calls: string[] = [];
    const proc: HarnessProcess = { write: l => { calls.push(`write ${l}`); return true; }, closeInput: () => calls.push('closeInput'), stop: () => calls.push('stop'), detach: () => calls.push('detach') };
    orch.adopter = (runId, upTo, h) => { adoptedWith = { runId, upTo }; handlers = h; return proc; };
    orch.localFolders = false;
    const info: AdoptInfo = { runId: 'mw-1', lastSeq: 9, board: '/b.md', card: 'Checkout [agent:: pi]', title: 'Checkout', agent: 'pi', project: 'shop', folder: '/srv/shop', machine: 'vps' };
    const history = (lines: (string | { in: string })[], ts = Date.now()) => {
        for (const l of lines) {
            if (typeof l === 'string') handlers.line(l, ts);
            else handlers.input?.(l.in);
        }
        handlers.caughtUp?.();
    };
    return { orch, info, calls, changes, board: () => board, history, get handlers() { return handlers; }, get adoptedWith() { return adoptedWith; } };
}

export async function daemonAppTests(): Promise<void> {
    section('markworkd in the app: machines');

    await test('an SSH target is a host, never something ssh would read as an option', async () => {
        for (const ok1 of ['vps', 'eka@vps.example.com', 'user@10.0.0.5', 'host-1.example.org', 'u@host:2222']) ok(isValidSshTarget(ok1), ok1);
        for (const bad of ['', '-oProxyCommand=touch /tmp/x', '-p', 'a b', 'host;rm -rf', 'host\nx', '$(id)']) ok(!isValidSshTarget(bad), JSON.stringify(bad));
        const argv = sshBridgeArgv({ host: 'eka@vps' });
        eq(argv.slice(-3), ['--', 'eka@vps', 'markworkd bridge'], 'the host comes after --');
        ok(argv.includes('BatchMode=yes'), 'never wait for a password prompt that has no terminal');
    });

    await test('a machine name is short and plain, and is not the word that means this computer', async () => {
        for (const good of ['vps', 'Home-NAS', 'build.2', 'a']) ok(isValidMachineName(good), good);
        for (const bad of ['', 'local', '-x', 'has space', 'a:b', 'x'.repeat(40), 'é']) ok(!isValidMachineName(bad), JSON.stringify(bad));
        eq([isRemoteMachine(''), isRemoteMachine('local'), isRemoteMachine('vps')], [false, false, true]);
        eq(machineProjectKey('vps', 'shop'), 'vps:shop');
    });

    await test('this computer: markworkd bridge when it is installed, else the socket; an SSH machine: ssh with the user\'s host', async () => {
        const a = hubWith({ installed: true });
        await settle1(a.hub.connection(LOCAL_MACHINE));
        eq(a.calls, [{ kind: 'command', arg: ['/usr/bin/markworkd', 'bridge'] }]);
        a.hub.dispose();

        const b = hubWith({ installed: false });
        const conn = b.hub.connection(LOCAL_MACHINE);
        conn.start();
        await flush();
        eq(b.calls, [{ kind: 'socket', arg: localSocketPath() }]);
        ok(/[\\/]markworkd[\\/]markworkd\.sock$/.test(localSocketPath()), 'in the runtime directory');
        b.hub.dispose();

        const c = hubWith({ machines: { vps: 'eka@vps.example.com' }, command: '~/.local/bin/markworkd' });
        await settle1(c.hub.connection('vps'));
        const argv = c.calls[0].arg as string[];
        eq([c.calls[0].kind, argv[0], argv.slice(-3)], ['command', 'ssh', ['--', 'eka@vps.example.com', '~/.local/bin/markworkd bridge']]);
        c.hub.dispose();
    });

    await test('a machine that is not defined or whose host is not valid is refused with a sentence, not connected to', async () => {
        const { hub, calls } = hubWith({ machines: { evil: '-oProxyCommand=x' } });
        let message = '';
        try { hub.connection('ghost'); } catch (e) { message = (e as Error).message; }
        contains(message, 'ghost');
        message = '';
        try { hub.connection('evil'); } catch (e) { message = (e as Error).message; }
        contains(message, 'not a valid SSH host');
        eq(calls, []);
    });

    await test('the hub tells which machine changed state, keeps one connection per machine, and makes a new one after forget', async () => {
        const { hub } = hubWith({ machines: { vps: 'vps' } });
        const seen: string[] = [];
        hub.onState((m, s) => seen.push(`${m}:${s}`));
        const first = hub.connection('vps');
        ok(hub.connection('vps') === first, 'one connection');
        first.start();
        await flush();
        eq(seen, ['vps:connecting', 'vps:ready']);
        eq(hub.state('vps')?.state, 'ready');
        hub.forget('vps');
        eq(hub.state('vps'), null);
        ok(hub.connection('vps') !== first, 'a new one');
        hub.dispose();
    });

    section('markworkd in the app: following a run again');

    await test('adopting makes a working run on the card and follows the daemon run from its start', async () => {
        const f = follower();
        eq(f.orch.adopt(f.info), null);
        eq(f.adoptedWith, { runId: 'mw-1', upTo: 9 });
        const run = f.orch.queue.runs[0];
        eq([run.status, run.agent, run.project, run.folder], ['working', 'pi', 'shop', '/srv/shop']);
        eq(f.orch.activity(), { children: 0, detachable: 1, queued: 0 });
        ok(f.orch.adopt(f.info) !== null, 'the same card cannot be followed twice');
        eq(f.orch.adopt({ ...f.info, card: 'Other', agent: 'nope' }), 'unknown harness "nope"');
        const g = follower();
        g.orch.adopter = null;
        contains(g.orch.adopt(g.info) ?? '', 'no daemon');
    });

    await test('a question that nothing answered is asked again once the history is over, not before', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        const run = f.orch.queue.runs[0];
        f.handlers.line(STATE, 1);
        f.handlers.line(ASK(), Date.now());
        eq(run.status, 'working', 'the history is still being replayed');
        f.handlers.caughtUp?.();
        eq(run.status, 'waiting');
        eq(run.ask?.title, 'Allow the bash command?');
        eq(run.result, null);
        f.orch.dispose();
    });

    await test('a question that was answered meanwhile is not asked again', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.history([STATE, ASK(), { in: ANSWER }, ev({ type: 'turn_start' })]);
        eq(f.orch.queue.runs[0].status, 'working');
        f.orch.dispose();
    });

    await test('a question whose own timeout ran out while Markwork was closed was answered by the harness: noted, not asked', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.history([STATE, ASK({ timeout: 30000 })], Date.now() - 3600000);
        const run = f.orch.queue.runs[0];
        eq(run.status, 'working');
        ok(run.trace.events.some(e => e.title === 'Answer time ran out'), 'noted in the log');
        f.orch.dispose();

        const g = follower();
        g.orch.adopt(g.info);
        g.history([STATE, ASK({ timeout: 30000 })], Date.now() - 1000);
        eq(g.orch.queue.runs[0].status, 'waiting', 'still within its timeout: asked');
        g.orch.dispose();
    });

    await test('a turn that finished while closed is handled as if it just did: close stdin, or ask the question it ended with', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.history([STATE, TEXT('Done: added the checkout.'), SETTLED]);
        eq(f.calls, ['closeInput']);
        f.orch.dispose();

        const g = follower();
        g.orch.adopt(g.info);
        g.history([STATE, TEXT('I checked.\n\nShould I use SDK A or B?'), SETTLED]);
        eq(g.orch.queue.runs[0].status, 'waiting');
        eq(g.orch.queue.runs[0].ask?.kind, 'question');
        eq(g.calls, []);
        g.orch.dispose();
    });

    await test('an earlier question that was followed by a reply is history; only the last open one counts', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.history([STATE, TEXT('Should I continue?'), SETTLED, { in: ev({ type: 'prompt', message: 'yes' }) }, TEXT('Going on.')]);
        eq(f.orch.queue.runs[0].status, 'working', 'the question was answered with a prompt');
        eq(f.calls, []);
        f.orch.dispose();
    });

    await test('a run that ended while Markwork was closed is finished: the card gets its result and moves to Review', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.handlers.line(STATE, 1);
        f.handlers.line(TEXT('QRIS checkout added in checkout.ts'), 2);
        f.handlers.line(SETTLED, 3);
        f.handlers.caughtUp?.();
        f.handlers.exit(0, '');
        const run = f.orch.queue.runs[0];
        eq(run.status, 'done');
        eq(run.result?.sessionId, 's-1', 'the session id comes from the replayed history, so a reply can continue it');
        const b = f.board();
        eq(b.columns[2].cards.length, 1, 'moved to Review');
        contains(b.columns[2].cards[0].notes.join('\n'), 'QRIS checkout added');
        ok(f.changes.some(m => m.includes('finished')), 'the user is told');
    });

    await test('a run the daemon lost (it restarted) fails the card with the reason', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.history([STATE]);
        f.handlers.exit(1, 'the daemon restarted while the run was active');
        const run = f.orch.queue.runs[0];
        eq(run.status, 'failed');
        contains(run.result?.error ?? '', 'daemon restarted');
    });

    await test('an interrupted run (lost with a known session) can be resumed in the same session, once the user confirms', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.history([STATE]);
        f.handlers.exit(1, 'the daemon restarted while the run was active', true);
        const run = f.orch.queue.runs[0];
        eq(run.status, 'failed');
        eq(run.result?.interrupted, true);
        contains(f.board().columns[1].cards[0].notes.join('\n'), 'interrupted');
        contains(f.board().columns[1].cards[0].notes.join('\n'), 'resume it');
        ok(f.changes.some(m => m.includes('interrupted')), 'the user is told, in words that point at the card');

        let argv: string[] = [];
        let wrote = '';
        f.orch.program = spec => spec.program;
        f.orch.spawn = (a, _cwd, _h) => { argv = a; return { write: l => { wrote += l; return true; }, closeInput: () => {}, stop: () => {} }; };
        eq(f.orch.resumeInterrupted(run), null);
        eq(argv.slice(-2), ['--session', 's-1'], 'the same pi session');
        contains(wrote, 'interrupted');
        eq(f.orch.queue.find('/b.md', run.card)?.status, 'working');
    });

    await test('a lost run without a session id cannot be resumed; a run that failed by itself is not "interrupted"', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.history([]);
        f.handlers.exit(1, 'the daemon restarted while the run was active', true);
        const run = f.orch.queue.runs[0];
        ok(!run.result?.interrupted, 'no session to continue');
        eq(f.orch.resumeInterrupted(run), 'this run was not interrupted');

        const g = follower();
        g.orch.adopt(g.info);
        g.history([STATE]);
        g.handlers.exit(2, 'boom');
        ok(!g.orch.queue.runs[0].result?.interrupted, 'an ordinary failure is not offered as a resume');
    });

    await test('closing: runs in a daemon are let go or stopped as asked, local children are stopped; queued cards are counted', async () => {
        const f = follower();
        f.orch.adopt(f.info);
        f.orch.dispose();
        eq(f.calls, ['detach']);

        const g = follower();
        g.orch.adopt(g.info);
        g.orch.dispose(true);
        eq(g.calls, ['stop'], 'stopped when the user chose to stop everything');
    });

    await test('with project folders on another machine, the local folder checks are skipped', async () => {
        let spawnedIn = '';
        const board = parseBoard('---\nlayout: board\nproject: shop\n---\n\n## Plan\n\n- [ ] Checkout [agent:: pi]\n\n## In Progress\n');
        const orch = new Orchestrator({ workspace: () => '/home/u/notes', linkedNotes: () => [], updateBoard: () => null, changed: () => {} });
        orch.spawn = (_argv, cwd) => { spawnedIn = cwd; return { write: () => true, closeInput: () => {}, stop: () => {} }; };
        orch.program = spec => spec.program;
        eq(orch.start('/b.md', board, { column: 0, index: 0 }, 'pi', 'shop', '/srv/shop-that-is-not-here', 'board') !== null, true, 'refused when folders are local and this one does not exist');
        orch.localFolders = false;
        eq(orch.start('/b.md', board, { column: 0, index: 0 }, 'pi', 'shop', '/srv/shop-that-is-not-here', 'board'), null);
        eq(spawnedIn, '/srv/shop-that-is-not-here');
        void ManualTimers;
    });
}

// Connects a connection and waits until it is ready (the in-memory daemon answers at once).
async function settle1(conn: { start(): void }): Promise<void> {
    conn.start();
    await flush();
}

export type { Link };
