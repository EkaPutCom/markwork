// Phase 0 experiment only. Application transport must use the platform port.
import { spawn } from 'node:child_process';

export class SpikeRpc {
    constructor(
        program,
        args,
        { cwd, env = process.env, timeout = 30_000 } = {}
    ) {
        this.timeout = timeout;
        this.pending = new Map();
        this.listeners = new Set();
        this.sequence = 0;
        this.failure = null;
        this.stderr = '';
        this.child = spawn(program, args, {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.closed = new Promise((resolve) =>
            this.child.once('close', (code, signal) => {
                this.fail(new Error(`pi exited (${code ?? signal})`));
                resolve({ code, signal });
            })
        );
        this.child.on('error', (error) => this.fail(error));
        this.child.stdin.on('error', (error) => this.fail(error));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (text) => {
            this.stderr = (this.stderr + text).slice(-8192);
        });
        this.child.stdout.setEncoding('utf8');
        let buffer = '';
        this.child.stdout.on('data', (chunk) => {
            buffer += chunk;
            try {
                let end;
                while ((end = buffer.indexOf('\n')) >= 0) {
                    if (end > 8 * 1024 * 1024)
                        throw new Error('pi record exceeds 8 MiB');
                    const line = buffer.slice(0, end).replace(/\r$/, '');
                    buffer = buffer.slice(end + 1);
                    if (line) this.record(JSON.parse(line));
                }
                if (buffer.length > 8 * 1024 * 1024)
                    throw new Error('pi record exceeds 8 MiB');
            } catch (error) {
                this.fail(error);
                this.child.kill();
            }
        });
    }

    fail(error) {
        this.failure ??= error;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        for (const listener of this.listeners) listener(null, error);
    }

    record(record) {
        if (record.type === 'response') {
            const request = this.pending.get(record.id);
            if (request) {
                this.pending.delete(record.id);
                if (record.success) request.resolve(record.data);
                else
                    request.reject(
                        new Error(record.error || 'pi rejected command')
                    );
            }
        }
        for (const listener of this.listeners) listener(record);
    }

    onEvent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    waitFor(predicate, timeout = this.timeout) {
        let cancel;
        const promise = new Promise((resolve, reject) => {
            const finish = (error, value) => {
                clearTimeout(timer);
                this.listeners.delete(listener);
                if (error) reject(error);
                else resolve(value);
            };
            const listener = (record, error) => {
                if (error) finish(error);
                else if (predicate(record)) finish(null, record);
            };
            const timer = setTimeout(
                () => finish(new Error('pi event deadline exceeded')),
                timeout
            );
            cancel = () => finish(null, null);
            this.listeners.add(listener);
            if (this.failure) finish(this.failure);
        });
        // A wait can fail while a correlated command is still awaiting its
        // response.
        promise.catch(() => {});
        return { promise, cancel };
    }

    command(type, fields = {}, timeout = this.timeout) {
        if (this.failure) return Promise.reject(this.failure);
        const id = `spike-${++this.sequence}`;
        return new Promise((resolve, reject) => {
            const finish = (error, value) => {
                clearTimeout(timer);
                this.pending.delete(id);
                if (error) reject(error);
                else resolve(value);
            };
            const timer = setTimeout(
                () =>
                    finish(
                        new Error(
                            `pi ${type} deadline exceeded; outcome unknown`
                        )
                    ),
                timeout
            );
            this.pending.set(id, {
                resolve: (value) => finish(null, value),
                reject: (error) => finish(error),
            });
            // One write per record; the callback bounds the write together with
            // its acknowledgement.
            // This spike serializes commands except for cancellation and never
            // floods stdin.
            this.child.stdin.write(
                `${JSON.stringify({ ...fields, id, type })}\n`,
                (error) => {
                    if (error) finish(error);
                }
            );
        });
    }

    async prompt(message, timeout = 180_000) {
        const settled = this.waitFor(
            (event) => event.type === 'agent_settled',
            timeout
        );
        let failure = null;
        const off = this.onEvent((event) => {
            if (
                event?.type === 'message_end' &&
                event.message?.role === 'assistant' &&
                ['error', 'aborted'].includes(event.message.stopReason)
            ) {
                failure =
                    event.message.errorMessage || event.message.stopReason;
            }
        });
        try {
            const response = await this.command('prompt', { message });
            if (response?.disposition !== 'started')
                throw new Error(
                    `Unexpected disposition: ${response?.disposition}`
                );
            const result = await settled.promise;
            if (failure || result.aborted)
                throw new Error(failure || 'pi run aborted');
        } finally {
            off();
            settled.cancel();
        }
    }

    async stop() {
        await this.command('clear_queue');
        await this.command('abort');
    }

    async close() {
        this.child.stdin.end();
        const terminate = setTimeout(() => this.child.kill('SIGTERM'), 3000);
        const kill = setTimeout(() => this.child.kill('SIGKILL'), 5000);
        try {
            return await this.closed;
        } finally {
            clearTimeout(terminate);
            clearTimeout(kill);
        }
    }
}
