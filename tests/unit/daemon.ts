// Tests of the TypeScript client of markworkd, against an in-memory stand-in for the daemon (daemon-fake.ts):
// the frame format, requests and streams, reconnecting with a resume that loses and repeats nothing, and the
// Spawner that lets the orchestrator run a harness through the daemon. The real daemon is tested in daemon-live.ts.

import { DaemonClient } from '../../src/agent/daemon/client.js';
import { DaemonConnection, type ConnectionState } from '../../src/agent/daemon/connection.js';
import { DaemonError, encodeRequest, exitStatus, parseExit, parseFrame, type DaemonRecord, type RunSummary, type StateEvent } from '../../src/agent/daemon/protocol.js';
import { adoptRun, daemonGit, daemonSpawner, newRunId } from '../../src/orchestratordaemon.js';
import { Orchestrator, type HarnessProcess, type SpawnHandlers, type SpawnMeta, type Spawner } from '../../src/orchestrator.js';
import { parseBoard, type Board } from '../../src/markdown/kanban.js';
import { section, test, eq, ok, contains, within } from '../framework.js';
import { host as testHost } from '../host.js';
import { FakeDaemon, ManualTimers, flush } from './daemon-fake.js';

function setup(opts: { backoffMs?: number[]; expectBridge?: boolean } = {}) {
    const daemon = new FakeDaemon();
    const timers = new ManualTimers();
    const conn = new DaemonConnection({ open: daemon.open, name: 'test', timers, backoffMs: opts.backoffMs ?? [100, 200, 400], expectBridge: opts.expectBridge });
    return { daemon, timers, conn };
}

function collector() {
    const lines: string[] = [];
    let exit: { status: number; stderr: string } | null = null;
    const handlers: SpawnHandlers = { line: l => lines.push(l), exit: (status, stderr) => { exit = { status, stderr }; } };
    return { lines, handlers, get exit() { return exit; } };
}

const out = (recs: DaemonRecord[]) => recs.map(r => `${r.seq}:${r.kind}:${r.line}`);

export async function daemonClientTests(): Promise<void> {
    section('markworkd client: frames');

    await test('parseFrame: replies and events are told apart; anything else is ignored', async () => {
        eq(parseFrame('{"re":"3","ok":true,"seq":9}'), { type: 'reply', re: '3', ok: true, body: { re: '3', ok: true, seq: 9 } });
        eq(parseFrame('{"re":"3","ok":false,"error":{"code":"x"}}')?.type, 'reply');
        eq(parseFrame('{"ev":"record","run":"r"}')?.type, 'event');
        eq(parseFrame('Last login: yesterday'), null, 'a login banner');
        eq(parseFrame('{broken'), null);
        eq(parseFrame('[1,2]'), null);
        eq(parseFrame('{"a":1}'), null, 'an object that is neither');
        eq(parseFrame('   '), null);
    });

    await test('encodeRequest puts id and op next to the parameters; parameters cannot override them', async () => {
        const o = JSON.parse(encodeRequest('7', 'write', { run: 'r', line: 'x', id: 'evil', op: 'evil' }));
        eq(o, { run: 'r', line: 'x', id: '7', op: 'write' });
    });

    await test('exitStatus: exit code, 128 + signal, 127 when it never started', async () => {
        eq(exitStatus({ reason: 'exited', code: 3 }), 3);
        eq(exitStatus({ reason: 'exited', code: 0 }), 0);
        eq(exitStatus({ reason: 'stopped', signal: 15 }), 143);
        eq(exitStatus({ reason: 'start_failed', error: 'x' }), 127);
        eq(exitStatus({ reason: 'lost' }), 1);
        eq(exitStatus({ reason: 'canceled' }), 0);
        eq(parseExit('{"reason":"signaled","signal":9}'), { reason: 'signaled', signal: 9 });
        eq(parseExit('nonsense').reason, 'exited');
    });

    section('markworkd client: requests');

    await test('a request gets its reply; a failed one becomes a DaemonError with the daemon\'s code', async () => {
        const daemon = new FakeDaemon();
        const client = new DaemonClient(daemon.open());
        const hello = await within(client.hello('t'));
        eq([hello.proto, hello.machine], [1, 'fakebox']);
        const spawned = await within(client.spawn({ run: 'r1', program: 'pi', args: ['--mode', 'rpc'], cwd: '/p' }));
        eq([spawned.run, spawned.state], ['r1', 'running']);
        eq(await within(client.write('r1', 'hi')), 2, 'the seq of the "in" record');
        let err: unknown;
        try { await within(client.write('nope', 'x')); } catch (e) { err = e; }
        ok(err instanceof DaemonError && err.code === 'not_found', 'a DaemonError with code not_found');
        eq((await within(client.list())).map(r => r.run), ['r1']);
        eq((await within(client.get('r1'))).state, 'running');
        client.close();
    });

    await test('a request the daemon never answers times out; a closed connection rejects at once', async () => {
        const daemon = new FakeDaemon();
        daemon.silent = true;
        const timers = new ManualTimers();
        const client = new DaemonClient(daemon.open(), { timers, requestTimeoutMs: 5000 });
        await within(client.hello('t'));
        let result = '';
        client.ping().then(() => { result = 'ok'; }, (e: DaemonError) => { result = e.code; });
        await flush();
        eq(result, '', 'still waiting');
        await timers.advance(5000);
        await flush();
        eq(result, 'timeout');
        client.close();
        let after = '';
        client.ping().catch((e: DaemonError) => { after = e.code; });
        await flush();
        eq(after, 'connection_closed');
    });

    await test('the connection ending rejects the requests that are waiting', async () => {
        const daemon = new FakeDaemon();
        daemon.silent = true;
        const client = new DaemonClient(daemon.open());
        await within(client.hello('t'));
        let code = '', closed: string | null | undefined;
        client.onClosed = r => { closed = r; };
        client.ping().catch((e: DaemonError) => { code = e.code; });
        daemon.drop();
        await flush();
        eq(code, 'connection_closed');
        eq(closed, 'link dropped');
        ok(client.isClosed, 'closed');
    });

    await test('records that arrive in the same read as the subscribe reply are not lost', async () => {
        const daemon = new FakeDaemon();
        const client = new DaemonClient(daemon.open());
        await within(client.hello('t'));
        await within(client.spawn({ run: 'r', program: 'pi', args: [], cwd: '/p' }));
        daemon.out('r', 'one');
        daemon.out('r', 'two');
        daemon.finish('r', { reason: 'exited', code: 0 });
        const got: DaemonRecord[] = [];
        let ended = -1;
        const sub = await within(client.subscribe('r', 0, { record: r => got.push(r), end: n => { ended = n; } }));
        eq(sub.last_seq, 4);
        eq(out(got), ['1:start:pid 1', '2:out:one', '3:out:two', '4:exit:{"reason":"exited","code":0}']);
        eq(ended, 4);
    });

    await test('behind an SSH bridge, text before the sentinel line is ignored', async () => {
        const daemon = new FakeDaemon();
        daemon.bannerNoise = true;
        daemon.expectBridgeSentinel = true;
        const client = new DaemonClient(daemon.open(), { expectBridge: true });
        eq((await within(client.hello('t'))).machine, 'fakebox');
        client.close();
    });

    section('markworkd client: reconnecting');

    await test('the connection connects, and waits with a growing delay while the machine cannot be reached', async () => {
        const { daemon, timers, conn } = setup({ backoffMs: [100, 200, 400] });
        daemon.refuse = true;
        const states: ConnectionState[] = [];
        conn.onState(s => states.push(s));
        let client: DaemonClient | null = null;
        conn.ready().then(c => { client = c; });
        await flush();
        eq(conn.state, 'waiting');
        eq(conn.detail, 'connection refused');
        eq(timers.pendingDelays, [100]);
        await timers.advance(100);
        eq(timers.pendingDelays, [200], 'the delay doubles');
        await timers.advance(200);
        eq(timers.pendingDelays, [400]);
        await timers.advance(400);
        eq(timers.pendingDelays, [400], 'and stays at the last one');
        eq(daemon.openCount, 4);
        daemon.refuse = false;
        await timers.advance(400);
        await flush();
        eq(conn.state, 'ready');
        ok(client !== null, 'ready() resolved');
        eq(states, ['connecting', 'waiting', 'connecting', 'waiting', 'connecting', 'waiting', 'connecting', 'waiting', 'connecting', 'ready']);
        conn.dispose();
    });

    await test('after a successful connect the delay starts over', async () => {
        const { daemon, timers, conn } = setup({ backoffMs: [100, 200] });
        conn.start();
        await flush();
        eq(conn.state, 'ready');
        daemon.refuse = true;
        daemon.drop();
        await flush();
        eq(timers.pendingDelays, [100]);
        await timers.advance(100);
        eq(timers.pendingDelays, [200]);
        daemon.refuse = false;
        await timers.advance(200);
        await flush();
        eq(conn.state, 'ready');
        daemon.refuse = true;
        daemon.drop();
        await flush();
        eq(timers.pendingDelays, [100], 'back to the first delay');
        conn.dispose();
    });

    await test('a protocol the daemon does not support is final: no retries, ready() and followers fail', async () => {
        const { daemon, timers, conn } = setup();
        daemon.protoVersion = 2;
        let failed = '', rejected = '';
        conn.follow('r', 0, { record: () => {}, end: () => {}, failed: e => { failed = e.code; } });
        conn.ready().catch((e: DaemonError) => { rejected = e.code; });
        await flush();
        eq(conn.state, 'failed');
        eq(failed, 'unsupported_proto');
        eq(rejected, 'unsupported_proto');
        eq(timers.pendingDelays, []);
        conn.dispose();
    });

    await test('a follower resumes after the link drops and sees every record once, in order', async () => {
        const { daemon, timers, conn } = setup();
        const client = await within(conn.ready());
        await within(client.spawn({ run: 'r', program: 'pi', args: [], cwd: '/p' }));
        const got: DaemonRecord[] = [];
        let ended = -1;
        const f = conn.follow('r', 0, { record: r => got.push(r), end: n => { ended = n; }, failed: () => {} });
        await flush();
        daemon.out('r', 'a');
        daemon.out('r', 'b');
        eq(out(got), ['1:start:pid 1', '2:out:a', '3:out:b']);

        daemon.drop();
        await flush();
        daemon.out('r', 'while away');       // the agent goes on while nobody is connected
        daemon.out('r', 'still away');
        await timers.advance(100);
        await flush();
        eq(conn.state, 'ready');
        eq(out(got).slice(3), ['4:out:while away', '5:out:still away']);
        daemon.out('r', 'back');
        eq(f.lastSeq, 6);
        eq(daemon.requestsOf('subscribe').map(r => r.from_seq), [1, 4], 'the second subscribe asked for the next record');
        daemon.finish('r', { reason: 'exited', code: 0 });
        eq(ended, 7);
        eq(got.map(r => r.seq), [1, 2, 3, 4, 5, 6, 7]);
        conn.dispose();
    });

    await test('a daemon that replays older records does not make the follower repeat them', async () => {
        const { daemon, timers, conn } = setup();
        const client = await within(conn.ready());
        await within(client.spawn({ run: 'r', program: 'pi', args: [], cwd: '/p' }));
        const got: number[] = [];
        conn.follow('r', 0, { record: r => got.push(r.seq), end: () => {}, failed: () => {} });
        await flush();
        daemon.out('r', 'a');
        daemon.replayFromStart = true;
        daemon.drop();
        await flush();
        await timers.advance(100);
        await flush();
        daemon.out('r', 'b');
        eq(got, [1, 2, 3]);
        conn.dispose();
    });

    await test('a follower of a run that does not exist fails; one that is stopped hears nothing more', async () => {
        const { daemon, conn } = setup();
        let failed = '';
        conn.follow('ghost', 0, { record: () => {}, end: () => {}, failed: e => { failed = e.code; } });
        await flush();
        eq(failed, 'not_found');

        const client = await within(conn.ready());
        await within(client.spawn({ run: 'r', program: 'pi', args: [], cwd: '/p' }));
        const got: number[] = [];
        const f = conn.follow('r', 0, { record: r => got.push(r.seq), end: () => {}, failed: () => {} });
        await flush();
        f.stop();
        await flush();
        daemon.out('r', 'late');
        eq(got, [1]);
        eq(daemon.requestsOf('unsubscribe').length, 1);
        conn.dispose();
    });

    await test('watch: the snapshot comes first, then the changes; after a reconnect there is a new snapshot', async () => {
        const { daemon, timers, conn } = setup();
        const client = await within(conn.ready());
        await within(client.spawn({ run: 'old', program: 'pi', args: [], cwd: '/p' }));
        const events: string[] = [];
        // The daemon sends a change right behind the snapshot reply, in the same read.
        daemon.afterWatch = c => c.send({ ev: 'state', run: 'old', state: 'exited', exit: { reason: 'exited', code: 0 }, last_seq: 2 });
        conn.watch({
            snapshot: (runs: RunSummary[]) => events.push(`snapshot:${runs.map(r => r.run).join(',')}`),
            state: (ev: StateEvent) => events.push(`state:${ev.run}:${ev.state}`),
        });
        await flush();
        eq(events, ['snapshot:old', 'state:old:exited']);
        daemon.afterWatch = null;
        daemon.drop();
        await flush();
        await timers.advance(100);
        await flush();
        eq(events.slice(2), ['snapshot:old']);
        conn.dispose();
    });

    await test('disposing the connection rejects waiters and stops retrying', async () => {
        const { daemon, timers, conn } = setup();
        daemon.refuse = true;
        let code = '';
        conn.ready().catch((e: DaemonError) => { code = e.code; });
        await flush();
        conn.dispose();
        await flush();
        eq(code, 'closed', 'a final code, unlike connection_closed which callers retry');
        eq(conn.state, 'closed');
        await timers.advance(10000);
        eq(daemon.openCount, 1, 'no attempt after dispose');
    });

    section('markworkd client: the Spawner for the orchestrator');

    await test('a run through the daemon: the program is a name, lines come back, the exit status and stderr are reported', async () => {
        const { daemon, conn } = setup();
        const c = collector();
        const spawn = daemonSpawner(conn, { newRunId: () => 'run-1' });
        const proc = spawn(['/home/u/.local/bin/pi', '--mode', 'rpc', '--name', 'Fix it'], '/work/shop', c.handlers, { lane: 'shop', labels: { card: 'Fix it', board: '/b.md' } });
        await flush();
        const req = daemon.requestsOf('spawn')[0];
        eq([req.program, req.args, req.cwd, req.lane, req.labels], ['pi', ['--mode', 'rpc', '--name', 'Fix it'], '/work/shop', 'shop', { card: 'Fix it', board: '/b.md' }]);
        ok(proc.write('{"type":"prompt"}'), 'accepted');
        await flush();
        eq(daemon.runs.get('run-1')!.inputs, ['{"type":"prompt"}']);
        daemon.out('run-1', '{"type":"agent_start"}');
        daemon.out('run-1', '{"type":"agent_end"}');
        eq(c.lines, ['{"type":"agent_start"}', '{"type":"agent_end"}']);
        eq(c.exit, null);
        daemon.finish('run-1', { reason: 'exited', code: 2 }, 'warning: something\n');
        await flush();
        eq(c.exit, { status: 2, stderr: 'warning: something\n' });
        eq(daemon.requestsOf('forget').length, 1, 'the daemon is told it can drop the run');
        eq(proc.write('late'), false, 'no input after the run ended');
        conn.dispose();
    });

    await test('lines written before the run exists are delivered after it, in order', async () => {
        const { daemon, timers, conn } = setup();
        daemon.refuse = true;                      // not connected yet
        const c = collector();
        const proc = daemonSpawner(conn, { newRunId: () => 'r' })(['pi'], '/p', c.handlers);
        ok(proc.write('first') && proc.write('second') && proc.write('third'), 'accepted while connecting');
        await flush();
        eq(daemon.requestsOf('write').length, 0);
        daemon.refuse = false;
        await timers.advance(100);
        await flush();
        eq(daemon.runs.get('r')!.inputs, ['first', 'second', 'third']);
        eq(daemon.requests.map(r => r.op).filter(o => o === 'spawn' || o === 'write'), ['spawn', 'write', 'write', 'write'], 'the run exists before the first write');
        conn.dispose();
    });

    await test('shutting the connection down ends the pending creation of a run instead of retrying forever', async () => {
        const { daemon, conn } = setup();
        daemon.refuse = true;
        const c = collector();
        daemonSpawner(conn, { newRunId: () => 'r' })(['pi'], '/p', c.handlers);
        await flush();
        conn.dispose();
        await flush();
        eq(c.exit?.status, 1);
        contains(c.exit!.stderr, 'shut down');
    });

    await test('a connection that dies while the run is created is retried: exactly one run results', async () => {
        const { daemon, timers, conn } = setup();
        await within(conn.ready());
        daemon.dropAfterSpawn = true;
        const c = collector();
        daemonSpawner(conn, { newRunId: () => 'r' })(['pi'], '/p', c.handlers);
        await flush();
        await timers.advance(100);
        await flush();
        eq(daemon.runs.size, 1);
        eq(daemon.requestsOf('spawn').length, 2, 'the idempotent request was repeated');
        daemon.out('r', 'hello');
        eq(c.lines, ['hello']);
        conn.dispose();
    });

    await test('a spawn the daemon refuses ends the run with the reason as its message', async () => {
        const { daemon, conn } = setup();
        daemon.failSpawnWith = 'program_not_allowed';
        const c = collector();
        daemonSpawner(conn)(['/bin/rm', '-rf', '/'], '/p', c.handlers);
        await flush();
        eq(c.exit?.status, 127);
        contains(c.exit!.stderr, 'program_not_allowed');
        daemon.failSpawnWith = 'cwd_not_allowed';
        const c2 = collector();
        daemonSpawner(conn)(['pi'], '/etc', c2.handlers);
        await flush();
        eq(c2.exit?.status, 1);
        conn.dispose();
    });

    await test('closeInput and stop reach the daemon; stop goes before lines that were not sent yet', async () => {
        const { daemon, conn } = setup();
        const c = collector();
        const proc = daemonSpawner(conn, { newRunId: () => 'r' })(['pi'], '/p', c.handlers);
        await flush();
        proc.closeInput();
        proc.closeInput();
        await flush();
        eq(daemon.requestsOf('close_stdin').length, 1, 'closing twice sends once');
        eq(proc.write('too late'), false, 'no input after closeInput');
        proc.stop();
        await flush();
        ok(daemon.runs.get('r')!.stopped, 'stop was sent');
        conn.dispose();

        const s = setup();
        s.daemon.refuse = true;
        const c2 = collector();
        const p2 = daemonSpawner(s.conn, { newRunId: () => 'q' })(['pi'], '/p', c2.handlers);
        p2.write('a line that never mattered');
        p2.stop();
        await flush();
        s.daemon.refuse = false;
        await s.timers.advance(100);
        await flush();
        eq(s.daemon.requests.map(r => r.op).filter(o => ['spawn', 'write', 'stop'].includes(o)), ['spawn', 'stop', 'write']);
        s.conn.dispose();
    });

    await test('a write is not repeated when the link dies under it: it is reported instead', async () => {
        const { daemon, timers, conn } = setup();
        const problems: string[] = [];
        const c = collector();
        const proc = daemonSpawner(conn, { newRunId: () => 'r', problem: (run, m) => problems.push(`${run} ${m}`) })(['pi'], '/p', c.handlers);
        await flush();
        daemon.dropOnWrite = true;
        proc.write('a prompt');
        await flush();
        await timers.advance(100);
        await flush();
        eq(daemon.requestsOf('write').length, 1, 'sent once, not again');
        eq(problems.length, 1);
        contains(problems[0], 'write');
        ok(proc.write('the next one'), 'the process is still usable');
        await flush();
        eq(daemon.runs.get('r')!.inputs, ['the next one']);
        conn.dispose();
    });

    await test('output is delivered exactly once across a reconnect', async () => {
        const { daemon, timers, conn } = setup();
        const c = collector();
        daemonSpawner(conn, { newRunId: () => 'r' })(['pi'], '/p', c.handlers);
        await flush();
        daemon.out('r', 'one');
        daemon.drop();
        await flush();
        daemon.out('r', 'two');
        await timers.advance(100);
        await flush();
        daemon.out('r', 'three');
        daemon.finish('r', { reason: 'exited', code: 0 });
        await flush();
        eq(c.lines, ['one', 'two', 'three']);
        eq(c.exit?.status, 0);
        conn.dispose();
    });

    await test('how a run can end: a signal, a daemon that restarted, a program that never started', async () => {
        const { daemon, conn } = setup();
        const cases: [string, { reason: 'stopped' | 'lost' | 'start_failed' | 'signaled'; signal?: number; error?: string }, number, string][] = [
            ['sig', { reason: 'signaled', signal: 9 }, 137, ''],
            ['lost', { reason: 'lost', error: 'the daemon restarted while the run was active' }, 1, 'the daemon restarted while the run was active'],
            ['nostart', { reason: 'start_failed', error: 'exec: not found' }, 127, 'exec: not found'],
        ];
        for (const [id, exit, status, stderr] of cases) {
            const c = collector();
            daemonSpawner(conn, { newRunId: () => id })(['pi'], '/p', c.handlers);
            await flush();
            daemon.finish(id, exit);
            await flush();
            eq(c.exit, { status, stderr }, id);
        }
        conn.dispose();
    });

    await test('adoptRun follows a run that is already there from the record after the last one seen', async () => {
        const { daemon, conn } = setup();
        const client = await within(conn.ready());
        await within(client.spawn({ run: 'old', program: 'pi', args: [], cwd: '/p' }));
        daemon.out('old', 'seen before');
        daemon.out('old', 'missed 1');
        daemon.out('old', 'missed 2');
        daemon.finish('old', { reason: 'exited', code: 0 });
        const c = collector();
        adoptRun(conn, 'old', 3, c.handlers);
        await flush();
        eq(c.lines, ['missed 1', 'missed 2'], 'from record 3 on');
        eq(c.exit?.status, 0);
        eq(daemon.requestsOf('spawn').length, 1, 'adopting does not spawn');
        conn.dispose();
    });

    await test('run ids are unique and acceptable to the daemon', async () => {
        const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
        eq(ids.size, 200);
        for (const id of ids) ok(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id), id);
    });

    section('markworkd client: closing the window');

    // The orchestrator with a fake Spawner and a board held in memory.
    function orchestrate(spawner: Spawner) {
        let board: Board = parseBoard('---\nlayout: board\nproject: shop\n---\n\n## Plan\n\n- [ ] Checkout [agent:: pi]\n\n## In Progress\n\n## Review\n');
        const host = {
            workspace: () => null,
            linkedNotes: () => [],
            updateBoard: (_file: string, edit: (b: Board) => Board) => { board = edit(board); return null; },
            changed: () => {},
        };
        const orch = new Orchestrator(host);
        orch.spawn = spawner;
        orch.program = () => '/usr/bin/pi';
        const folder = testHost().makeTempDir();
        const err = orch.start('/b.md', board, { column: 0, index: 0 }, 'pi', 'shop', folder, 'board');
        eq(err, null);
        return { orch, folder, board: () => board };
    }

    await test('closing the window stops a harness that is a child of this window, and lets go of one that lives in a daemon', async () => {
        const calls: string[] = [];
        const local: Spawner = () => ({ write: () => true, closeInput: () => calls.push('local closeInput'), stop: () => calls.push('local stop') });
        const a = orchestrate(local);
        a.orch.dispose();
        eq(calls, ['local stop'], 'no detach: stopped as before');

        calls.length = 0;
        const remote: Spawner = (): HarnessProcess => ({ write: () => true, closeInput: () => calls.push('remote closeInput'), stop: () => calls.push('remote stop'), detach: () => calls.push('remote detach') });
        const b = orchestrate(remote);
        b.orch.dispose();
        eq(calls, ['remote detach'], 'detached, not stopped');
        eq(b.board().columns[1].cards.length, 1, 'the card stays in In Progress: the work goes on');
    });

    await test('the orchestrator tells the spawner which lane and which card a run is for', async () => {
        let seen: SpawnMeta | undefined;
        const spawner: Spawner = (_argv, _cwd, _h, meta) => { seen = meta; return { write: () => true, closeInput: () => {}, stop: () => {} }; };
        const { orch } = orchestrate(spawner);
        eq(seen?.lane, 'shop');
        eq([seen?.labels.agent, seen?.labels.project, seen?.labels.board, seen?.labels.title], ['pi', 'shop', '/b.md', 'Checkout']);
        contains(seen!.labels.card, 'Checkout');
        orch.dispose();
    });

    await test('git through the daemon passes environment variables only to the call that asks for them', async () => {
        const { daemon, conn } = setup();
        daemon.git = args => args[0] === 'push' ? { status: 1, err: 'fatal: nope' } : { status: 0 };
        let n = 0;
        const git = daemonGit(conn, { newRunId: () => `g${++n}` });
        const status = git('/work/shop', ['status']);
        const push = git('/work/shop', ['push', 'https://h/r.git', 'HEAD'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'Authorization: Basic eDp5' });
        await flush();
        const [first, second] = daemon.requestsOf('spawn');
        eq([first.program, first.env], ['git', undefined], 'a plain call carries no environment');
        eq(second.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'Authorization: Basic eDp5' });
        ok(!second.args.some((a: string) => a.includes('Basic')), 'and the token is not in the arguments');
        await flush();
        eq((await status)?.status, 0);
        eq(await push, { status: 1, out: '', err: 'fatal: nope' });
        eq(daemon.requestsOf('forget').length, 2, 'both runs are forgotten, so the daemon keeps no record of the token');
        conn.dispose();
    });

    await test('detaching from a daemon run stops the callbacks and leaves the run on the daemon', async () => {
        const { daemon, conn } = setup();
        const c = collector();
        const proc = daemonSpawner(conn, { newRunId: () => 'r' })(['pi'], '/p', c.handlers);
        await flush();
        daemon.out('r', 'before');
        proc.detach!();
        daemon.out('r', 'after');
        daemon.finish('r', { reason: 'exited', code: 0 });
        await flush();
        eq(c.lines, ['before'], 'nothing after detach');
        eq(c.exit, null);
        eq(proc.write('x'), false);
        eq(daemon.requestsOf('stop').length, 0, 'the run was not stopped');
        ok(daemon.runs.has('r'), 'and not forgotten');
        conn.dispose();
    });
}
