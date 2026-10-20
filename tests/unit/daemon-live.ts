// The TypeScript client against the real markworkd: the Go daemon is built from markworkd/ and started on a Unix
// socket in a temporary folder, and a small shell script plays the agent. This is what proves that the two
// implementations of the protocol agree, and that the platform's links (a Unix socket, and the stdio of `markworkd
// bridge`) work on the runtime the tests run on. Skipped, with a note, when Go is not installed.

import { DaemonConnection, type ConnectionOptions } from '../../src/agent/daemon/connection.js';
import { openCommandLink, openSocketLink, sshBridgeArgv } from '../../src/agent/daemon/streamlink.js';
import type { RunSummary, StateEvent } from '../../src/agent/daemon/protocol.js';
import { adoptRun, daemonGit, daemonSpawner } from '../../src/orchestratordaemon.js';
import { createWorktree, DEFAULT_ISOLATION, listWorktrees, removeWorktree } from '../../src/agent/worktree.js';
import type { HarnessProcess, SpawnHandlers } from '../../src/orchestrator.js';
import { platform } from '../../src/platform/index.js';
import { DIM, RESET, ROOT, ok, eq, contains, section, within, test, tmp, disk, say, until } from '../framework.js';
import { host } from '../host.js';

const AGENT = `#!/bin/sh
echo ready
while IFS= read -r line; do
  case "$line" in
    "exit "*) exit "\${line#exit }" ;;
    "err "*) echo "\${line#err }" >&2 ;;
    "sleep") sleep 30 ;;
    *) echo "echo:$line" ;;
  esac
done
echo eof
`;

async function run(argv: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
    const result = await platform().processes.run({ argv, cwd, timeoutMs: 600000 });
    return { ok: result?.status === 0, out: result ? `${result.out}${result.err}` : `${argv[0]} could not be started` };
}

async function waitUntil(cond: () => boolean, what: string, ms = 15000): Promise<void> {
    try { await until(cond, ms); } catch { throw new Error(`timed out waiting for ${what}`); }
}

interface Collected { lines: string[]; exit: { status: number; stderr: string } | null; handlers: SpawnHandlers }
function collect(): Collected {
    const c: Collected = { lines: [], exit: null, handlers: { line: l => c.lines.push(l), exit: (status, stderr) => { c.exit = { status, stderr }; } } };
    return c;
}

export async function daemonLiveTests(): Promise<void> {
    section('markworkd client: against the real daemon');
    const modDir = disk.join(ROOT, 'markworkd');
    if (platform().os === 'win32') {
        say(`  ${DIM}skipped: markworkd is not built for Windows yet (docs/design/electron.md, its open gaps)${RESET}`);
        return;
    }
    if (!platform().processes.findProgram('go') || !disk.isDirectory(modDir)) {
        say(`  ${DIM}skipped: Go is not installed (or markworkd/ is missing), so the daemon cannot be built${RESET}`);
        return;
    }
    const dir = host().makeTempDir();
    const bin = `${dir}/markworkd`;
    const built = await run(['go', 'build', '-o', bin, './cmd/markworkd'], modDir);
    if (!built.ok) {
        await test('the daemon builds', async () => { throw new Error(built.out); });
        return;
    }
    const proj = `${dir}/proj`;
    disk.mkdirs(proj);
    const agent = `${dir}/agent.sh`;
    disk.write(agent, AGENT);
    platform().fs.setMode(agent, 0o755);
    const sock = `${dir}/s.sock`;
    const common = ['--socket', sock, '--state-dir', `${dir}/state`, '--config', `${dir}/config.json`];
    const gitPath = platform().processes.findProgram('git') ?? '/usr/bin/git';
    disk.write(`${dir}/config.json`, JSON.stringify({ roots: [proj], programs: { 'agent.sh': agent, git: gitPath }, default_idle_ttl_sec: 0 }));
    let daemonExited = false;
    const daemon = platform().processes.spawn([bin, 'serve', ...common], dir, { line: () => {}, exit: () => { daemonExited = true; } });
    const connections: DaemonConnection[] = [];

    const connect = (open: ConnectionOptions['open'] = () => openSocketLink(sock), extra: Partial<ConnectionOptions> = {}): DaemonConnection => {
        const c = new DaemonConnection({ open, name: 'markwork-test', backoffMs: [20, 50], ...extra });
        connections.push(c);
        return c;
    };

    try {
        await waitUntil(() => { try { openSocketLink(sock).close(); return true; } catch { return false; } }, 'the daemon to listen');

        await test('hello and info over the Unix socket', async () => {
            const conn = connect();
            const client = await within(conn.ready());
            const info = await within(client.info());
            contains(info.daemon, 'markworkd');
            eq([info.running, info.queued], [0, 0]);
            eq(conn.state, 'ready');
        });

        await test('a harness run: the program is found by name, output comes back in order, exit status and stderr are reported', async () => {
            const conn = connect();
            const c = collect();
            const proc = daemonSpawner(conn)([agent, '--mode', 'rpc'], proj, c.handlers, { lane: 'proj', labels: { card: 'Fix it' } });
            proc.write('hello');
            proc.write('err something went wrong');
            proc.write('exit 3');
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.lines, ['ready', 'echo:hello']);
            eq(c.exit, { status: 3, stderr: 'something went wrong\n' });
        });

        await test('closing stdin ends the agent in an orderly way (status 0)', async () => {
            const conn = connect();
            const c = collect();
            const proc = daemonSpawner(conn)([agent], proj, c.handlers);
            proc.write('one');
            proc.closeInput();
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.lines, ['ready', 'echo:one', 'eof']);
            eq(c.exit?.status, 0);
        });

        await test('stop ends a running agent with 143 (SIGTERM)', async () => {
            const conn = connect();
            const c = collect();
            const proc = daemonSpawner(conn)([agent], proj, c.handlers);
            proc.write('sleep');
            await waitUntil(() => c.lines.includes('ready'), 'the agent to start');
            proc.stop();
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.exit?.status, 143);
        });

        await test('a very long line goes through a non-blocking socket in pieces and arrives whole', async () => {
            const conn = connect();
            const c = collect();
            const proc = daemonSpawner(conn)([agent], proj, c.handlers);
            const big = 'x'.repeat(600000);
            proc.write(big);
            proc.write('after');
            proc.closeInput();
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.lines.length, 4);
            eq(c.lines[1].length, 'echo:'.length + big.length);
            eq(c.lines[2], 'echo:after');
        });

        await test('many lines keep their order', async () => {
            const conn = connect();
            const c = collect();
            const proc = daemonSpawner(conn)([agent], proj, c.handlers);
            for (let i = 0; i < 300; i++) proc.write(`line ${i}`);
            proc.closeInput();
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.lines.length, 302);
            eq(c.lines[1], 'echo:line 0');
            eq(c.lines[300], 'echo:line 299');
        });

        await test('a request the daemon refuses ends the run with the daemon\'s reason', async () => {
            const conn = connect();
            const c = collect();
            daemonSpawner(conn)([agent], '/etc', c.handlers);
            await waitUntil(() => c.exit !== null, 'the answer');
            eq(c.exit?.status, 1);
            contains(c.exit!.stderr, 'cwd');
            const d = collect();
            daemonSpawner(conn)(['/bin/sh'], proj, d.handlers);
            await waitUntil(() => d.exit !== null, 'the answer');
            eq(d.exit?.status, 127, 'a program that is not in the daemon\'s list');
        });

        await test('the link drops while the agent runs: the run goes on and the output is whole, once', async () => {
            const conn = connect();
            const c = collect();
            const proc = daemonSpawner(conn)([agent], proj, c.handlers);
            proc.write('before');
            await waitUntil(() => c.lines.includes('echo:before'), 'the first answer');
            conn.current()!.link.close();                   // like an SSH session that died
            ok(conn.state !== 'ready', 'the connection noticed');
            proc.write('after');                            // waits for the reconnect
            proc.closeInput();
            await waitUntil(() => c.exit !== null, 'the run to end after the reconnect');
            eq(c.lines, ['ready', 'echo:before', 'echo:after', 'eof']);
            eq(c.exit?.status, 0);
        });

        await test('Markwork closes while the agent runs: a new connection finds the run and carries on', async () => {
            const first = connect();
            const c1 = collect();
            const proc = daemonSpawner(first)([agent], proj, c1.handlers, { lane: 'proj', labels: { card: 'Long job', board: '/b.md' } });
            proc.write('one');
            await waitUntil(() => c1.lines.includes('echo:one'), 'the first answer');
            first.dispose();                                // the window is closed; nothing stops the run

            const second = connect();
            const runs = await within((async () => (await second.ready()).list({ state: 'running' }))());
            const mine = runs.find(r => r.labels?.card === 'Long job');
            ok(mine, 'the run is still there and can be recognised by its labels');
            eq(mine!.labels?.board, '/b.md');
            const c2 = collect();
            const adopted: HarnessProcess = adoptRun(second, mine!.run, 1, c2.handlers);
            await waitUntil(() => c2.lines.includes('echo:one'), 'the replay');
            adopted.write('two');
            adopted.closeInput();
            await waitUntil(() => c2.exit !== null, 'the run to end');
            eq(c2.lines, ['ready', 'echo:one', 'echo:two', 'eof'], 'everything from the start, including what happened while closed');
            eq(c2.exit?.status, 0);
        });

        await test('watch reports runs starting and ending', async () => {
            const conn = connect();
            const snapshots: RunSummary[][] = [];
            const states: string[] = [];
            conn.watch({ snapshot: r => snapshots.push(r), state: (ev: StateEvent) => states.push(`${ev.run}:${ev.state}`) });
            await waitUntil(() => snapshots.length > 0, 'the snapshot');
            const c = collect();
            let id = '';
            const spawn = daemonSpawner(conn, { newRunId: () => (id = 'watched-1'), forgetWhenDone: false });
            const proc = spawn([agent], proj, c.handlers);
            proc.closeInput();
            await waitUntil(() => c.exit !== null, 'the run to end');
            await waitUntil(() => states.includes('watched-1:exited'), 'the state event');
            ok(states.indexOf('watched-1:running') < states.indexOf('watched-1:exited') || !states.includes('watched-1:running'), 'running before exited');
            eq(id, 'watched-1');
        });

        await test('through `markworkd bridge`, as over SSH: the same protocol over the stdio of a command', async () => {
            const conn = connect(() => openCommandLink([bin, 'bridge', ...common]), { expectBridge: true });
            const c = collect();
            const proc = daemonSpawner(conn)([agent], proj, c.handlers);
            proc.write('over the bridge');
            proc.closeInput();
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.lines, ['ready', 'echo:over the bridge', 'eof']);
            eq(c.exit?.status, 0);
        });

        await test('lane slots: two runs of a lane work at once, a third waits for a slot', async () => {
            const conn = connect();
            const runs = [collect(), collect(), collect()];
            const procs = runs.map(c => daemonSpawner(conn)([agent], proj, c.handlers, { lane: 'slots', slots: 2, labels: {} }));
            await waitUntil(() => runs[0].lines.includes('ready') && runs[1].lines.includes('ready'), 'two runs to start');
            const client = await within(conn.ready());
            eq((await within(client.list({ lane: 'slots' }))).map(r => r.state).sort(), ['queued', 'running', 'running']);
            procs[0].closeInput();
            await waitUntil(() => runs[2].lines.includes('ready'), 'the third to start in the freed slot');
            procs[1].closeInput();
            procs[2].closeInput();
            await waitUntil(() => runs.every(c => c.exit !== null), 'the runs to end');
        });

        await test('git through the daemon: a card worktree is made, listed, and removed on its machine', async () => {
            const conn = connect();
            const repo = `${proj}/shop`;
            disk.mkdirs(repo);
            const sh = async (...args: string[]) => { const r = await run(['git', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], repo); if (!r.ok) throw new Error(r.out); };
            await sh('init', '-q', '-b', 'main');
            disk.write(`${repo}/a.txt`, 'a\n');
            await sh('add', '-A');
            await sh('commit', '-q', '-m', 'First');
            const git = daemonGit(conn);
            const made = await within(createWorktree(git, { folder: repo, title: 'Fix login', isolation: DEFAULT_ISOLATION }));
            if (!made.ok) throw new Error(made.message);
            eq(made.value.path, `${proj}/.markwork-worktrees/shop/fix-login`, 'next to the project, inside the daemon\'s root');
            ok(disk.exists(`${made.value.path}/a.txt`), 'checked out');
            eq((await within(listWorktrees(git, repo))).map(w => w.branch), ['main', 'markwork/fix-login']);
            const client = await within(conn.ready());
            eq((await within(client.list({}))).filter(r => r.program === 'git').length, 0, 'every git run is forgotten once it ended');
            eq((await within(removeWorktree(git, made.value))).ok, true);
            ok(!disk.exists(made.value.path), 'removed');
            const refused = await within(git('/etc', ['status']));
            ok(refused !== null && refused.status !== 0 && /cwd|allowed|root/i.test(refused.err), `a folder outside the roots is refused: ${refused?.err}`);
        });

        await test('a command that cannot be run is a failed attempt with its reason, not a crash', async () => {
            const conn = connect(() => openCommandLink(['sh', '-c', 'echo "Permission denied (publickey)." >&2; exit 255']), { expectBridge: true });
            conn.start();
            await waitUntil(() => conn.state === 'waiting' && conn.detail.includes('Permission denied'), 'the reason to show');
            contains(conn.detail, 'Permission denied (publickey).');
        });
    } finally {
        for (const c of connections) c.dispose();
        daemon.stop();   // SIGTERM, then SIGKILL if it is ignored
        try { await waitUntil(() => daemonExited, 'the daemon to exit', 10000); } catch { /* stop() kills it */ }
        await run(['rm', '-rf', dir], '/');
        void tmp;
    }
}

// ---------- over real ssh ----------

// The client through a real `ssh` to a machine that runs markworkd and has a `pi` that speaks pi's RPC mode (the Docker
// image in markworkd/contrib/docker is one). Off unless MARKWORK_TEST_SSH is set, e.g.
//   MARKWORK_TEST_SSH="-F /path/ssh_config markwork-vps" node dist-node/run-core-node.js --only-daemon
// The last word is the host, the others are ssh options. The run folder is MARKWORK_TEST_SSH_DIR.
export async function daemonSshTests(): Promise<void> {
    const spec = platform().env('MARKWORK_TEST_SSH');
    if (!spec) return;
    section('markworkd client: over real ssh');
    const words = spec.split(/\s+/).filter(Boolean);
    const host = words.pop()!;
    const folder = platform().env('MARKWORK_TEST_SSH_DIR') ?? '/home/tester/projects/shop';
    const open = (target = host) => () => openCommandLink(sshBridgeArgv({ host: target, options: words }));
    const connect = (target = host): DaemonConnection => new DaemonConnection({ open: open(target), name: 'markwork-test', expectBridge: true, backoffMs: [200, 500] });
    const GET_STATE = JSON.stringify({ id: 'markwork-state', type: 'get_state' });
    const PROMPT = JSON.stringify({ id: 'p1', type: 'prompt', message: 'go' });
    const conns: DaemonConnection[] = [];
    const mk = (target?: string) => { const c = connect(target); conns.push(c); return c; };
    const start = (conn: DaemonConnection, c: Collected, labels: Record<string, string> = {}): HarnessProcess => {
        const proc = daemonSpawner(conn)(['pi', '--mode', 'rpc'], folder, c.handlers, { lane: 'ssh-test', labels });
        proc.write(GET_STATE);
        proc.write(PROMPT);
        return proc;
    };

    try {
        await test('hello over ssh and markworkd bridge', async () => {
            const conn = mk();
            const info = await within((async () => (await conn.ready()).info())(), 30000);
            contains(info.daemon, 'markworkd');
            eq(conn.state, 'ready');
        });

        await test('a run over ssh: the agent\'s events come back, and stop ends it (143)', async () => {
            const conn = mk();
            const c = collect();
            const proc = start(conn, c);
            await waitUntil(() => c.lines.some(l => l.includes('tool_execution_start')), 'the agent\'s first events', 30000);
            contains(c.lines[0], 'markwork-state');
            proc.stop();
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.exit?.status, 143);
        });

        await test('Markwork closes while the agent works on the machine: a new ssh finds the run and replays it', async () => {
            const label = `ssh-adopt-${Date.now()}`;
            const first = mk();
            const c1 = collect();
            start(first, c1, { card: label });
            await waitUntil(() => c1.lines.some(l => l.includes('tool_execution_start')), 'the first events', 30000);
            first.dispose();                                    // the ssh process ends; the run does not

            const second = mk();
            const runs = await within((async () => (await second.ready()).list({ state: 'running' }))(), 30000);
            const mine = runs.find(r => r.labels?.card === label);
            ok(mine, 'the run is still on the machine');
            const c2 = collect();
            const adopted = adoptRun(second, mine!.run, 1, c2.handlers);
            await waitUntil(() => c2.lines.some(l => l.includes('tool_execution_start')), 'the replay');
            contains(c2.lines[0], 'markwork-state');
            adopted.stop();
            await waitUntil(() => c2.exit !== null, 'the run to end');
            eq(c2.exit?.status, 143);
        });

        await test('the ssh link dies mid-run: it reconnects and the output is whole, once', async () => {
            const conn = mk();
            const c = collect();
            const proc = start(conn, c);
            await waitUntil(() => c.lines.some(l => l.includes('tool_execution_start')), 'the first events', 30000);
            const before = c.lines.length;
            conn.current()!.link.close();                       // ssh is terminated, as if the network had dropped
            await waitUntil(() => conn.state === 'ready', 'the reconnect', 30000);
            eq(c.lines.length, before, 'nothing was repeated after the resume');
            eq(new Set(c.lines).size, c.lines.length, 'no line twice');
            proc.stop();
            await waitUntil(() => c.exit !== null, 'the run to end');
            eq(c.exit?.status, 143);
        });

        await test('a host that does not exist is a failed attempt with ssh\'s own reason', async () => {
            const conn = mk('markwork-no-such-host.invalid');
            conn.start();
            await waitUntil(() => conn.state === 'waiting' && conn.detail.length > 0, 'the reason', 30000);
            ok(/resolve|not known|name or service/i.test(conn.detail), `reason: ${conn.detail}`);
        });
    } finally {
        for (const c of conns) c.dispose();
    }
}
