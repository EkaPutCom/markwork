// Pi owns the loop and native sessions. This transport only correlates bounded
// RPC commands and events.
import { platform, type ChildProcess, type Processes } from '../platform/index';

export type PiRecord = Record<string, any>;
export const parsePiRecord = (line: string): PiRecord =>
    JSON.parse(line.replace(/\r$/, ''));
export const piCommand = (
    type: string,
    id: string,
    fields: object = {}
): string => JSON.stringify({ id, type, ...fields });
const RECORD_LIMIT = 8 * 1024 * 1024;

export class PiRpc {
    private child: ChildProcess | null = null;
    private seq = 0;
    private readonly instance = platform().newId();
    private failure: Error | null = null;
    private readonly pending = new Map<
        string,
        { resolve(value: PiRecord): void; reject(error: Error): void }
    >();
    private readonly listeners = new Set<(event: PiRecord) => void>();
    private readonly failures = new Set<(error: Error) => void>();
    private exit: (() => void) | null = null;
    private closed = false;

    constructor(
        argv: string[],
        cwd: string,
        spawn: Processes['spawn'] = platform().processes.spawn
    ) {
        this.child = spawn(argv, cwd, {
            maxLineLength: RECORD_LIMIT,
            line: (line) => this.line(line),
            exit: (status, stderr) => {
                this.closed = true;
                this.fail(
                    Error(
                        status
                            ? `pi exited (${status}): ${stderr.slice(-1000)}`
                            : 'pi connection closed'
                    )
                );
                this.exit?.();
            },
        });
    }

    onEvent(listener: (event: PiRecord) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    onFailure(listener: (error: Error) => void): () => void {
        this.failures.add(listener);
        return () => this.failures.delete(listener);
    }

    private line(line: string): void {
        if (this.failure) return;
        try {
            if (line.length > RECORD_LIMIT)
                throw Error('pi record exceeded the limit');
            const record = parsePiRecord(line);
            if (!record || typeof record.type !== 'string')
                throw Error('Invalid pi RPC record');
            if (record.type === 'response') {
                const request = this.pending.get(record.id);
                if (request) {
                    this.pending.delete(record.id);
                    if (record.success) request.resolve(record.data ?? {});
                    else
                        request.reject(
                            Error(record.error || 'pi rejected the command')
                        );
                }
            }
            for (const listener of this.listeners) listener(record);
        } catch (error) {
            this.fail(error instanceof Error ? error : Error(String(error)));
            this.child?.stop();
        }
    }

    private fail(error: Error): void {
        if (this.failure) return;
        this.failure = error;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        for (const listener of this.failures) listener(error);
    }

    command(type: string, fields: object = {}, ms = 30000): Promise<PiRecord> {
        if (this.failure) return Promise.reject(this.failure);
        const id = `mw-pi-${this.instance}-${++this.seq}`;
        return new Promise((resolve, reject) => {
            const end = (error: Error | null, value: PiRecord = {}) => {
                stop();
                this.pending.delete(id);
                if (error) reject(error);
                else resolve(value);
            };
            const stop = platform().scheduler.idleAfter(ms, () =>
                end(
                    Error(
                        `pi ${type} did not answer; outcome unknown. Do not resend automatically.`
                    )
                )
            );
            this.pending.set(id, {
                resolve: (value) => end(null, value),
                reject: (error) => end(error),
            });
            const line = piCommand(type, id, fields);
            if (line.length > 262144 || !this.child?.write(line))
                end(
                    Error(
                        'pi input is unavailable or too large; outcome unknown'
                    )
                );
        });
    }

    async prompt(message: string): Promise<boolean> {
        return this.waitSettled(async () => {
            const accepted = await this.command('prompt', { message });
            if (accepted.disposition !== 'started')
                throw Error(
                    `pi did not start this turn (${accepted.disposition})`
                );
        });
    }

    // Reattaching observes the original run; start only subscribes, never
    // submits a prompt.
    async waitSettled(
        start: () => Promise<void>,
        ms = 600000
    ): Promise<boolean> {
        let finish!: (aborted: boolean) => void,
            reject!: (error: Error) => void;
        const settled = new Promise<boolean>((yes, no) => {
            finish = yes;
            reject = no;
        });
        void settled.catch(() => {});
        let failure = '';
        const off = this.onEvent((event) => {
            if (
                event.type === 'message_end' &&
                event.message?.role === 'assistant' &&
                event.message.stopReason === 'error'
            )
                failure = event.message.errorMessage || 'pi model failed';
            if (event.type === 'extension_error')
                failure = event.error || 'pi extension failed';
            if (event.type === 'agent_settled')
                failure
                    ? reject(Error(failure))
                    : finish(event.aborted === true);
        });
        const failed = this.onFailure(reject);
        const timeout = platform().scheduler.idleAfter(ms, () =>
            reject(
                Error(
                    'pi observation deadline exceeded; inspect the original run before continuing'
                )
            )
        );
        try {
            await start();
            return await settled;
        } finally {
            off();
            failed();
            timeout();
        }
    }

    disconnect(): void {
        this.closed = true;
        this.fail(Error('Detached from pi; the original run is retained'));
    }

    async stop(): Promise<void> {
        await this.command('clear_queue');
        await this.command('abort');
    }

    async close(): Promise<void> {
        if (this.closed) return;
        const ended = new Promise<void>((resolve) => {
            this.exit = resolve;
        });
        const terminate = platform().scheduler.idleAfter(3000, () =>
            this.child?.stop()
        );
        // A lost exit notification must not keep application shutdown waiting
        // forever.
        const deadline = platform().scheduler.idleAfter(10000, () => {
            this.fail(Error('pi shutdown was not confirmed'));
            this.exit?.();
        });
        this.child?.closeInput();
        try {
            await ended;
        } finally {
            terminate();
            deadline();
        }
    }
}

export async function discoverPi(): Promise<string> {
    const program = platform().processes.findProgram('pi');
    if (!program)
        throw Error(
            'pi is not installed. Install pi and authenticate using pi before activating this agent.'
        );
    return program;
}
