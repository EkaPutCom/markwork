// Real supervisor + deterministic pi protocol fixture, including application
// close/reopen. Never runs real pi.
import { AppSession } from '../../src/app/session';
import { loadAgentFolder } from '../../src/agent/folder';
import { FolderStore } from '../../src/agent/folderstore';
import { platform } from '../../src/platform/index';
import { DaemonConnection } from '../../src/agent/daemon/connection';
import { openSocketLink } from '../../src/agent/daemon/streamlink';
import { memorySettings, fakeFrontend } from './appsession';
import {
    section,
    test,
    eq,
    ok,
    until,
    within,
    disk,
    ROOT,
    say,
} from '../core/framework';
import { host } from '../core/host';

export async function folderDaemonTests(): Promise<void> {
    section('Pi folders: real background daemon');
    if (platform().os !== 'linux' || !platform().processes.findProgram('go')) {
        say('  skipped: Linux and Go are required');
        return;
    }
    const dir = host().makeTempDir(),
        folder = disk.join(dir, 'agent'),
        workspace = disk.join(folder, 'workspace');
    disk.mkdirs(workspace);
    disk.write(
        disk.join(folder, 'agent.json'),
        JSON.stringify({
            version: 2,
            id: platform().newId(),
            runtime: 'pi',
            name: 'Background fixture',
            instructions: 'instructions.md',
        })
    );
    disk.write(disk.join(folder, 'instructions.md'), 'Write the report.');
    const definition = loadAgentFolder(folder);
    if (definition.kind !== 'agent') throw Error('Invalid fixture');
    const runtimeDir = new FolderStore(folder, definition.config).directory;
    const bin = disk.join(dir, 'markworkd'),
        socket = disk.join(dir, 'daemon.sock'),
        launcher = disk.join(dir, 'pi');
    const built = await platform().processes.run({
        argv: ['go', 'build', '-o', bin, './cmd/markworkd'],
        cwd: disk.join(ROOT, 'markworkd'),
        timeoutMs: 600000,
    });
    if (built?.status !== 0)
        throw Error(built?.err || 'Could not build daemon');
    disk.write(
        launcher,
        `#!/bin/sh\nexec '${platform().processes.findProgram('node')}' '${disk.join(ROOT, 'tests/electron/folder-pi-daemon-fixture.mjs')}' "$@"\n`
    );
    platform().fs.setMode(launcher, 0o755);
    const config = disk.join(dir, 'config.json');
    disk.write(
        config,
        JSON.stringify({
            roots: [folder, runtimeDir],
            programs: { pi: launcher },
            default_idle_ttl_sec: 0,
        })
    );
    let daemonExited = false;
    const daemon = platform().processes.spawn(
        [
            bin,
            'serve',
            '--socket',
            socket,
            '--config',
            config,
            '--state-dir',
            disk.join(dir, 'state'),
        ],
        dir,
        {
            line: () => {},
            exit: () => {
                daemonExited = true;
            },
        }
    );
    const find = platform().processes.findProgram;
    platform().processes.findProgram = (name) =>
        name === 'markworkd' ? null : find(name);
    const settings = memorySettings();
    settings.welcomed = true;
    settings.autosave = false;
    const sessions: AppSession<any>[] = [];
    const make = () => {
        const front = {
            ...fakeFrontend(settings, []),
            openers: {
                socket: () => openSocketLink(socket),
                command: () => {
                    throw Error('No command bridge in this fixture');
                },
            },
        };
        front.dialogs.files.confirm = async () => true;
        front.dialogs.harness = {
            ...front.dialogs.harness,
            closeAgents: async () => 'keep',
        };
        const session = new AppSession(front);
        sessions.push(session);
        session.start();
        session.open(folder);
        return session;
    };
    const connection = new DaemonConnection({
        name: 'folder-test-inspector',
        open: () => openSocketLink(socket),
        backoffMs: [20],
    });
    try {
        await until(() => disk.exists(socket), 10000);
        await test('background pi starts without version' +
            ' support; app close/reopen retains the' +
            ' exact run and prompt', async () => {
            const first = make();
            await first.agentFolders.enable(folder);
            await first.agentFolders.execution(folder, 'background');
            const id = first.agentFolders.state().sessions[0].id,
                entry = first.agentFolders.find(id);
            const sent = entry.panel.onSend('write once while closed');
            await until(
                () => disk.exists(disk.join(workspace, 'submitted')),
                15000
            );
            const run = entry.pi.store.get(entry.pi.chatId).run!.id;
            const stale = new FolderStore(folder, definition.config);
            const competitor = make();
            let refused = false;
            try {
                await competitor.agentFolders.enable(folder);
            } catch {
                refused = true;
            }
            ok(refused, 'a second owner was accepted');
            competitor.dispose();
            const queuedId = first.agentFolders.newChat()!;
            const queued = first.agentFolders
                .find(queuedId)
                .panel.onSend('keep this queued draft');
            eq(await within(first.closeRequest(), 20000), true);
            await within(sent);
            await within(queued);
            first.dispose();
            stale.claim();
            eq(
                stale.get(entry.pi.chatId).run?.id,
                run,
                'stale reader lost the durable run reservation'
            );
            stale.release();
            disk.write(disk.join(workspace, 'continue'), 'go');
            await until(
                () => disk.exists(disk.join(workspace, 'report.md')),
                10000
            );
            const native = JSON.parse(
                disk.read(entry.pi.store.get(entry.pi.chatId).native!)
            ) as { role: string; content: string }[];
            ok(
                native.some(
                    (message) =>
                        message.role === 'assistant' &&
                        message.content === 'Background report completed.'
                ),
                'observed report must have a complete' +
                    ' native snapshot before reopening'
            );
            const second = make();
            await until(
                () =>
                    !second.agentFolders.busy &&
                    second.agentFolders.state().sessions.length > 0,
                20000
            );
            const restored = second.agentFolders.find(id);
            ok(
                restored.pi.view.turns.some((turn) =>
                    turn.content.includes('Background report completed.')
                ),
                'native result not restored'
            );
            eq(
                disk.read(disk.join(workspace, 'submitted')),
                'write once while closed\n'
            );
            eq(restored.pi.store.get(restored.pi.chatId).run, undefined);
            eq(
                second.agentFolders
                    .find(queuedId)
                    .pi.store.draft(
                        second.agentFolders.find(queuedId).pi.chatId
                    ),
                'keep this queued draft'
            );
            eq((await (await connection.ready()).get(run)).state, 'exited');
            second.dispose();
        });
        await test('lost runs require explicit native' +
            ' recovery, never prompt or tool replay', async () => {
            const app = make();
            await app.agentFolders.enable(folder);
            disk.remove(disk.join(workspace, 'continue'));
            const entry = app.agentFolders.find(
                app.agentFolders.state().sessions[0].id
            );
            const sending = entry.panel.onSend('interrupt this exact run');
            await until(
                () =>
                    disk
                        .read(disk.join(workspace, 'submitted'))
                        .includes('interrupt this exact run'),
                15000
            );
            const client = await connection.ready(),
                run = entry.pi.store.get(entry.pi.chatId).run!.id;
            await client.stop(run);
            await within(sending, 20000);
            eq(entry.pi.store.get(entry.pi.chatId).status, 'interrupted');
            const native = JSON.parse(
                disk.read(entry.pi.store.get(entry.pi.chatId).native!)
            ) as { role: string; content: string }[];
            ok(
                native.some(
                    (message) =>
                        message.role === 'user' &&
                        message.content.includes('interrupt this exact run')
                ),
                'observed submission must survive an immediate process stop'
            );
            const before = disk.read(disk.join(workspace, 'submitted'));
            await app.agentFolders.reconnect(folder);
            eq(entry.pi.store.get(entry.pi.chatId).run?.id, run);
            await app.agentFolders.recover(entry.id);
            eq(entry.pi.store.get(entry.pi.chatId).run, undefined);
            eq(entry.pi.store.get(entry.pi.chatId).status, 'idle');
            eq(
                disk.read(disk.join(workspace, 'submitted')),
                before,
                'recovery repeated model work'
            );
            const stopped = entry.panel.onSend('explicitly stop this run');
            await until(
                () =>
                    disk
                        .read(disk.join(workspace, 'submitted'))
                        .includes('explicitly stop this run'),
                15000
            );
            await within(app.agentFolders.stopOriginal(entry.id), 20000);
            await within(entry.pi.waitIdle(), 20000);
            await within(stopped);
            eq(entry.pi.store.get(entry.pi.chatId).status, 'interrupted');
            await app.agentFolders.recover(entry.id);
            eq(entry.pi.store.get(entry.pi.chatId).run, undefined);
            app.dispose();
        });
        await test('background transport baseline: 1,000' +
            ' events with native resume and' +
            ' execution-machine preflights', async () => {
            const app = make();
            await app.agentFolders.enable(folder);
            disk.write(disk.join(workspace, 'continue'), 'go');
            const entry = app.agentFolders.find(
                    app.agentFolders.state().sessions[0].id
                ),
                times: number[] = [];
            for (let i = 0; i < 23; i++) {
                const start = platform().monotonicMs();
                await within(entry.panel.onSend('burst-' + i), 20000);
                eq(entry.pi.store.get(entry.pi.chatId).status, 'idle');
                eq(entry.pi.store.get(entry.pi.chatId).run, undefined);
                if (i >= 3) times.push(platform().monotonicMs() - start);
            }
            times.sort((a, b) => a - b);
            say(
                `${"  background 1000-event" +
            " turn median/p95/max ms: "}${times[10].toFixed(3)} / ${times[18].toFixed(3)} / ${times[19].toFixed(3)}`
            );
            app.dispose();
        });
        await test('unavailable execution-machine' +
            ' credentials fail before a prompt and' +
            ' never fall back locally', async () => {
            const app = make();
            await app.agentFolders.enable(folder);
            disk.write(disk.join(workspace, 'deny-auth'), 'deny');
            const entry = app.agentFolders.find(
                app.agentFolders.state().sessions[0].id
            );
            const before = disk.read(disk.join(workspace, 'submitted'));
            await within(entry.panel.onSend('must not execute'), 20000);
            eq(disk.read(disk.join(workspace, 'submitted')), before);
            disk.remove(disk.join(workspace, 'deny-auth'));
            await app.agentFolders.recover(entry.id);
            const auth = disk.read(disk.join(workspace, 'auth-args'));
            disk.write(disk.join(workspace, 'invalid-provider'), 'deny');
            await within(
                entry.panel.onSend(
                    'never turn provider data into credential flags'
                ),
                20000
            );
            eq(disk.read(disk.join(workspace, 'submitted')), before);
            eq(
                disk.read(disk.join(workspace, 'auth-args')),
                auth,
                'untrusted provider became CLI flags'
            );
            disk.remove(disk.join(workspace, 'invalid-provider'));
            app.dispose();
        });
    } finally {
        for (const app of sessions) app.dispose();
        try {
            const client = await within(connection.ready());
            for (const run of await client.list())
                if (run.state !== 'exited') await client.stop(run.run);
        } catch {
            /* daemon startup failure */
        }
        connection.dispose();
        daemon.stop();
        await until(() => daemonExited, 10000);
        platform().processes.findProgram = find;
    }
}
