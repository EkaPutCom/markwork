// Links to a markworkd on Node: a Unix socket (net) or the stdio of a command (child_process).

import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import type { LineLink, Links } from '../index';
import { exitStatus } from './process';

const STDERR_TAIL = 2000;
const EXIT_WAIT_MS = 500;   // how long a command whose stdout closed gets to report how it ended

// A link over a readable and a writable stream. Lines end at LF; a trailing CR is dropped.
class StreamLink implements LineLink {
    onLine: ((line: string) => void) | null = null;
    onClose: ((reason: string | null) => void) | null = null;
    private ended = false;
    private rest = '';

    constructor(input: Readable, private readonly output: Writable, private readonly release: () => void, onEof?: (end: (reason: string | null) => void) => void) {
        input.setEncoding('utf8');
        input.on('data', (chunk: string) => {
            const parts = (this.rest + chunk).split('\n');
            this.rest = parts.pop()!;
            for (const line of parts) {
                if (this.ended) return;
                this.onLine?.(line.replace(/\r$/, ''));
            }
        });
        input.on('end', () => (onEof ?? (end => end(null)))(reason => this.end(reason)));
        input.on('error', e => this.end(e.message));
        output.on('error', () => this.end('write to the daemon failed'));
    }

    send(line: string): boolean {
        if (this.ended) return false;
        this.output.write(`${line}\n`);
        return true;
    }

    close(): void { this.end(null); }

    end(reason: string | null): void {
        if (this.ended) return;
        this.ended = true;
        this.release();
        this.onClose?.(reason);
    }
}

// Connects to a daemon listening on a Unix socket on this machine. Node connects asynchronously, so only a missing
// socket throws here; a socket nobody listens on any more (refused) ends the link right after, with the reason.
// Lines sent before the connection is made are queued by the socket.
function socket(path: string): LineLink {
    if (!lstatSync(path).isSocket()) throw new Error(`${path} is not a socket`);
    const connection = createConnection({ path });
    return new StreamLink(connection, connection, () => connection.destroy());
}

// Runs a command and talks over its stdin and stdout. The link ends when the command does; its stderr tail is the
// reason, so "Permission denied" from ssh reaches the user.
function command(argv: string[]): LineLink {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe' });
    let stderr = '';
    let exited = false;
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = `${stderr}${d}`.slice(-STDERR_TAIL); });
    const link = new StreamLink(child.stdout, child.stdin, () => {
        child.stdin.end();
        if (!exited) child.kill('SIGTERM');   // closing stdin already asks a bridge to finish; this is for a command that does not
    }, end => {
        // stdout closed, which usually means the command is exiting: wait for its exit status and stderr.
        setTimeout(() => end(null), EXIT_WAIT_MS);
    });
    child.on('error', e => link.end(e.message));   // not on PATH
    child.on('exit', (code, signal) => {
        exited = true;
        const status = exitStatus(code, signal);
        // stderr may still have bytes in flight; give it the same moment the end of stdout gets.
        setImmediate(() => link.end(status === 0 ? null : (stderr.trim() || `the command exited with status ${status}`)));
    });
    return link;
}

export const nodeLinks: Links = { socket, command };
