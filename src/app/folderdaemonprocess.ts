// A numbered daemon stream is a transport, not a tool broker. Writes are
// deliberately never retried.
import type { ChildHandlers, ChildProcess } from '../platform/index';
import { platform } from '../platform/index';
import type { DaemonConnection, Follower } from '../agent/daemon/connection';
import {
    exitStatus,
    parseExit,
    type DaemonRecord,
} from '../agent/daemon/protocol';
import type { FolderStore } from '../agent/folderstore';

export async function daemonDeadline<T>(
    work: Promise<T>,
    ms = 15000
): Promise<T> {
    let cancel = () => {};
    const timeout = new Promise<never>((_, reject) => {
        cancel = platform().scheduler.idleAfter(ms, () =>
            reject(
                Error(
                    'markworkd did not answer; outcome unknown. Reconnect to the original run.'
                )
            )
        );
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        cancel();
    }
}

export class FolderDaemonProcess implements ChildProcess {
    private follower: Follower | null = null;
    private tail: Promise<void> = Promise.resolve();
    private ended = false;
    private detached = false;
    private inputClosed = false;
    private sequence = 0;
    private checkpointStop: (() => void) | null = null;
    settled = false;

    constructor(
        private readonly conn: DaemonConnection,
        private readonly store: FolderStore,
        private readonly chat: string,
        readonly run: string,
        private readonly handlers: ChildHandlers
    ) {}

    follow(from: number): void {
        this.follower?.stop();
        this.sequence = from - 1;
        this.follower = this.conn.follow(this.run, from, {
            record: (record) => this.record(record),
            end: () =>
                this.finish(
                    0,
                    'Background pi ended before its result could be read. Restore native history.'
                ),
            failed: (error) => this.finish(1, error.message),
        });
    }

    private record(record: DaemonRecord): void {
        if (this.detached || this.ended) return;
        if (record.seq !== this.sequence + 1 || record.truncated) {
            this.finish(
                1,
                'Incomplete pi event stream; explicit native recovery is required'
            );
            return;
        }
        this.sequence = record.seq;
        if (!this.checkpointStop)
            this.checkpointStop = platform().scheduler.idleAfter(500, () => {
                this.checkpointStop = null;
                this.checkpoint();
            });
        if (record.kind === 'out') {
            try {
                if (JSON.parse(record.line).type === 'agent_settled')
                    this.settled = true;
            } catch {
                /* PiRpc reports malformed JSON. */
            }
            this.handlers.line(record.line);
        } else if (record.kind === 'exit') {
            const exit = parseExit(record.line);
            this.finish(
                exitStatus(exit),
                exit.error || `Background pi ended (${exit.reason})`
            );
        }
    }

    private checkpoint(): void {
        try {
            this.store.checkpoint(this.chat, this.sequence);
        } catch (error) {
            this.finish(
                1,
                'Could not persist the background cursor: ' + String(error)
            );
        }
    }
    private finish(status: number, detail: string): void {
        if (this.ended || this.detached) return;
        this.ended = true;
        this.checkpointStop?.();
        this.checkpointStop = null;
        this.follower?.stop();
        this.follower = null;
        this.handlers.exit(status, detail);
    }

    private enqueue(work: () => Promise<void>): void {
        this.tail = this.tail
            .then(async () => {
                if (!this.detached && !this.ended) await daemonDeadline(work());
            })
            .catch((error) => this.finish(1, String(error)));
    }
    write(line: string): boolean {
        if (
            this.inputClosed ||
            this.ended ||
            this.detached ||
            line.length > 262144
        )
            return false;
        const command = JSON.parse(line);
        if (command.type === 'prompt') this.store.markPrompted(this.chat);
        this.enqueue(async () => {
            const client = await this.conn.ready();
            await client.write(this.run, line);
        });
        return true;
    }
    closeInput(): void {
        if (this.inputClosed) return;
        this.inputClosed = true;
        this.enqueue(async () => {
            const client = await this.conn.ready();
            await client.closeStdin(this.run);
        });
    }
    stop(): void {
        // A transport error is not permission to stop an unknown-outcome run.
        // Explicit Stop uses stopOriginal().
        if (!this.settled) return;
        void this.stopOriginal().catch((error) =>
            this.finish(1, String(error))
        );
    }
    async stopOriginal(): Promise<void> {
        const client = await daemonDeadline(this.conn.ready());
        await daemonDeadline(client.stop(this.run));
    }
    detach(): void {
        if (this.detached) return;
        this.checkpointStop?.();
        this.checkpointStop = null;
        this.checkpoint();
        this.detached = true;
        this.follower?.stop();
        this.follower = null;
    }
}
