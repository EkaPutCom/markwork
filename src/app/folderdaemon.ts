// The daemon owns pi's lifetime. Identity/native history stay in FolderStore;
// no prompt is replayed here.
import { PiRpc, type PiRecord } from '../agent/pirpc';
import type { FolderStore } from '../agent/folderstore';
import { DaemonError, parseExit } from '../agent/daemon/protocol';
import type { DaemonConnection } from '../agent/daemon/connection';
import type { FolderPiRuntime } from './folderpi';
import { FolderDaemonProcess, daemonDeadline } from './folderdaemonprocess';
import { platform, type ChildHandlers } from '../platform/index';

export class FolderDaemonPi implements FolderPiRuntime {
    readonly background = true;
    private process: FolderDaemonProcess | null = null;
    private rpc: PiRpc | null = null;
    constructor(
        private readonly conn: DaemonConnection,
        private readonly store: FolderStore,
        private readonly chat: string
    ) {}

    async discover(): Promise<string> {
        return 'pi';
    }

    private async probe(args: string[]): Promise<string> {
        const client = await daemonDeadline(this.conn.ready()),
            run = platform().newId();
        const lines: string[] = [];
        let finish!: (value: string) => void, fail!: (error: Error) => void;
        const result = new Promise<string>((resolve, reject) => {
            finish = resolve;
            fail = reject;
        });
        void result.catch(() => {});
        await daemonDeadline(
            client.spawn({
                run,
                program: 'pi',
                args,
                cwd: platform().paths.join(this.store.root, 'workspace'),
                idle_ttl_sec: 20,
            })
        );
        const follower = this.conn.follow(run, 1, {
            record: (record) => {
                if (
                    record.truncated ||
                    record.line.length > 16384 ||
                    lines.length > 100
                ) {
                    fail(Error('Invalid pi preflight output'));
                    return;
                }
                if (record.kind === 'out') lines.push(record.line);
                if (record.kind === 'exit') {
                    const exit = parseExit(record.line);
                    if (exit.reason !== 'exited' || exit.code !== 0)
                        fail(
                            Error(
                                'pi preflight failed on the execution' +
                                    ' machine. Check daemon programs,' +
                                    ' roots, and pi authentication.'
                            )
                        );
                }
            },
            end: () => finish(lines.join('\n')),
            failed: fail,
        });
        try {
            await daemonDeadline(client.closeStdin(run));
            return await daemonDeadline(result);
        } finally {
            follower.stop();
            // These probes cannot submit model work. Stop on a timeout and
            // retain daemon diagnostics on failure.
            void client.stop(run).catch(() => {});
        }
    }

    async verifyAuth(state: PiRecord): Promise<void> {
        const provider = state.model?.provider;
        if (
            typeof provider !== 'string' ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider)
        )
            throw Error(
                'Select a pi model with a valid' +
                    ' provider identifier on the execution' +
                    ' machine'
            );
        // Provider data must not become CLI flags, especially the
        // credential-printing --credentials flag.
        const output = await this.probe([
            'auth',
            'check',
            '--provider',
            provider,
            '--json',
            '--no-refresh',
        ]);
        let result: PiRecord;
        try {
            result = JSON.parse(output);
        } catch {
            throw Error('Invalid pi authentication-check response');
        }
        if (result.status !== 'ready')
            throw Error(
                'pi credentials are unavailable on the' +
                    ' execution machine. Authenticate there' +
                    ' using pi; Assistant credentials are' +
                    ' not forwarded.'
            );
    }

    async connect(argv: string[], cwd: string): Promise<PiRpc> {
        const client = await daemonDeadline(this.conn.ready());
        const run = this.store.beginRun(this.chat);
        // Persist before asking: even a lost spawn reply leaves an exact ID to
        // inspect, never a replacement run.
        await daemonDeadline(
            client.spawn({
                run,
                program: 'pi',
                args: argv.slice(1),
                cwd,
                lane: 'folder-' + this.store.config.id,
                lane_slots: 1,
                labels: {
                    kind: 'folder-pi',
                    agent: this.store.config.id,
                    chat: this.chat,
                },
            })
        );
        this.rpc = new PiRpc([], cwd, (_argv, _cwd, handlers) =>
            this.makeProcess(run, handlers)
        );
        this.process!.follow(1);
        return this.rpc;
    }
    private makeProcess(
        run: string,
        handlers: ChildHandlers
    ): FolderDaemonProcess {
        this.process = new FolderDaemonProcess(
            this.conn,
            this.store,
            this.chat,
            run,
            handlers
        );
        return this.process;
    }

    async attach(): Promise<{ rpc: PiRpc; question: string }> {
        const binding = this.store.get(this.chat),
            run = binding.run;
        if (!run?.prompted || !binding.native)
            throw Error(
                'Background startup outcome is unknown.' +
                    ' Inspect/stop the original run, then' +
                    ' explicitly restore native history.'
            );
        const client = await daemonDeadline(this.conn.ready()),
            summary = await daemonDeadline(client.get(run.id));
        if (
            summary.state !== 'running' ||
            summary.program !== 'pi' ||
            summary.labels?.kind !== 'folder-pi' ||
            summary.labels?.agent !== this.store.config.id ||
            summary.labels?.chat !== this.chat ||
            !platform().paths.same(
                summary.cwd,
                platform().paths.join(this.store.root, 'workspace')
            )
        )
            throw Error(
                'The original run is no longer running.' +
                    ' Explicit native recovery is required;' +
                    ' nothing was resubmitted.'
            );
        const rpc = new PiRpc([], summary.cwd, (_argv, _cwd, handlers) =>
            this.makeProcess(run.id, handlers)
        );
        this.rpc = rpc;
        // New command IDs have an instance nonce, so historical responses
        // cannot satisfy a fresh query.
        this.process!.follow(summary.last_seq + 1);
        const state = await rpc.command('get_state');
        if (
            state.sessionId !== binding.id ||
            state.sessionFile !== binding.native
        )
            throw Error(
                'The background run does not match its exact native binding'
            );
        return {
            rpc,
            question:
                this.store.draft(this.chat) ||
                '[Reattached turn; see native history]',
        };
    }
    replay(): Promise<void> {
        this.process!.follow(1);
        return Promise.resolve();
    }
    get settled(): boolean {
        return this.process?.settled === true;
    }
    detach(): void {
        this.process?.detach();
        this.rpc?.disconnect();
    }

    async finish(): Promise<void> {
        const run = this.store.get(this.chat).run;
        if (!run) return;
        const client = await daemonDeadline(this.conn.ready()),
            summary = await daemonDeadline(client.get(run.id));
        if (summary.state !== 'exited')
            throw Error(
                'Background shutdown is not confirmed.' +
                    ' The original run remains reserved;' +
                    ' reconnect or stop it explicitly.'
            );
        this.process?.detach();
        this.store.clearRun(this.chat);
    }
    async stopOriginal(): Promise<void> {
        const run = this.store.get(this.chat).run;
        if (!run) return;
        const client = await daemonDeadline(this.conn.ready());
        await daemonDeadline(client.stop(run.id));
        // DaemonClient has one subscription per run. A second follower here
        // would steal the RPC exit event.
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await daemonDeadline(client.get(run.id))).state === 'exited')
                return;
            await new Promise<void>((resolve) =>
                platform().scheduler.idleAfter(100, resolve)
            );
        }
        throw Error(
            'Background Stop was not confirmed; keep the original run reserved'
        );
    }
    async recoverOriginal(): Promise<void> {
        const run = this.store.get(this.chat).run;
        if (!run) return;
        const client = await daemonDeadline(this.conn.ready());
        try {
            const summary = await daemonDeadline(client.get(run.id));
            if (summary.state !== 'exited')
                throw Error(
                    'Stop the original background run and' +
                        ' wait for its exit before restoring' +
                        ' native history'
                );
        } catch (error) {
            if (!(error instanceof DaemonError) || error.code !== 'not_found')
                throw error;
        }
        this.store.clearRun(this.chat);
    }
}
