// Links to a markworkd over real file descriptors: a Unix socket (the daemon on this machine) or the stdio of a
// command (`ssh host markworkd bridge`, or `markworkd bridge` itself).
//
// The descriptors are driven with GLib main-loop watches (GLib.IOChannel), not with Gio's async stream calls: GJS
// 1.80 can drop an async callback that arrives while it is garbage collecting, and a lost callback here would
// leave a run unwatched. The same choice was made for the local harness in orchestrator.ts.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import type { Link } from './client.js';

const STDERR_TAIL = 2000;
const EXIT_WAIT_MS = 500;   // how long a command whose stdout closed gets to report how it ended

// Reads lines from a non-blocking descriptor on the main loop.
class LineReader {
    private readonly channel: GLib.IOChannel;
    private watch = 0;
    private open = true;

    constructor(fd: number, private readonly ownsFd: boolean, private readonly onLine: (line: string) => void, private readonly onEnd: () => void) {
        this.channel = GLib.IOChannel.unix_new(fd);
        this.channel.set_close_on_unref(false);
        this.channel.set_flags(GLib.IOFlags.NONBLOCK);
        this.watch = GLib.io_add_watch(this.channel, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, () => this.ready());
    }

    private ready(): boolean {
        for (;;) {
            let status: GLib.IOStatus, line: string;
            try { [status, line] = this.channel.read_line(); } catch { status = GLib.IOStatus.ERROR; line = ''; }
            if (status === GLib.IOStatus.NORMAL) {
                this.onLine(line.replace(/\r?\n$/, ''));
                if (!this.open) return GLib.SOURCE_REMOVE;
                continue;
            }
            if (status === GLib.IOStatus.AGAIN) return GLib.SOURCE_CONTINUE;
            this.watch = 0;               // the source is removed by the return value
            this.stop();
            this.onEnd();
            return GLib.SOURCE_REMOVE;
        }
    }

    stop(): void {
        if (!this.open) return;
        this.open = false;
        if (this.watch) { GLib.source_remove(this.watch); this.watch = 0; }
        if (this.ownsFd) try { this.channel.shutdown(false); } catch { /* already closed */ }
    }
}

// Writes whole lines to a non-blocking descriptor; what does not fit is kept and written when it becomes writable.
class LineWriter {
    private readonly channel: GLib.IOChannel;
    private readonly encoder = new TextEncoder();
    private pending: Uint8Array[] = [];
    private watch = 0;
    private open = true;

    constructor(fd: number, private readonly ownsFd: boolean, private readonly onError: () => void) {
        this.channel = GLib.IOChannel.unix_new(fd);
        this.channel.set_close_on_unref(false);
        this.channel.set_encoding(null);       // bytes as they are, with an explicit length
        this.channel.set_buffered(false);
        this.channel.set_flags(GLib.IOFlags.NONBLOCK);
    }

    write(line: string): boolean {
        if (!this.open) return false;
        this.pending.push(this.encoder.encode(`${line}\n`));
        return this.pump();
    }

    private pump(): boolean {
        while (this.pending.length) {
            const buf = this.pending[0];
            let status: GLib.IOStatus, written: number;
            try { [status, written] = this.channel.write_chars(buf, buf.length); } catch { return this.fail(); }
            if (written < buf.length) this.pending[0] = buf.subarray(written);
            else this.pending.shift();
            if (status === GLib.IOStatus.AGAIN) return this.waitWritable();
            if (status !== GLib.IOStatus.NORMAL) return this.fail();
        }
        return true;
    }

    private waitWritable(): boolean {
        if (this.watch) return true;
        this.watch = GLib.io_add_watch(this.channel, GLib.PRIORITY_DEFAULT, GLib.IOCondition.OUT | GLib.IOCondition.ERR | GLib.IOCondition.HUP, () => {
            this.watch = 0;
            this.pump();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    private fail(): boolean {
        this.stop();
        this.onError();
        return false;
    }

    stop(): void {
        if (!this.open) return;
        this.open = false;
        this.pending = [];
        if (this.watch) { GLib.source_remove(this.watch); this.watch = 0; }
        if (this.ownsFd) try { this.channel.shutdown(false); } catch { /* already closed */ }
    }
}

// A Link over a read side and a write side (the same descriptor for a socket, two pipes for a command).
class StreamLink implements Link {
    onLine: ((line: string) => void) | null = null;
    onClose: ((reason: string | null) => void) | null = null;
    private ended = false;
    private readonly reader: LineReader;
    private readonly writer: LineWriter;

    // onEof decides what the reader reaching its end means; by default the link ends cleanly.
    constructor(readFd: number, writeFd: number, ownsFds: boolean, private readonly release: () => void, onEof?: (end: (reason: string | null) => void) => void) {
        this.reader = new LineReader(readFd, ownsFds, line => this.onLine?.(line), () => (onEof ?? (end => end(null)))(r => this.end(r)));
        this.writer = new LineWriter(writeFd, ownsFds, () => this.end('write to the daemon failed'));
    }

    send(line: string): boolean { return !this.ended && this.writer.write(line); }
    close(): void { this.end(null); }

    end(reason: string | null): void {
        if (this.ended) return;
        this.ended = true;
        this.reader.stop();
        this.writer.stop();
        this.release();
        this.onClose?.(reason);
    }
}

// Connects to a daemon listening on a Unix socket on this machine. Throws if nobody listens there.
export function openSocketLink(path: string): Link {
    const connection = new Gio.SocketClient().connect(new Gio.UnixSocketAddress({ path }), null);
    const fd = connection.get_socket().get_fd();
    return new StreamLink(fd, fd, false, () => { try { connection.close(null); } catch { /* already closed */ } });
}

// Runs a command and talks over its stdin and stdout. The link ends when the command does; its stderr tail is the
// reason, so "Permission denied" from ssh reaches the user.
export function openCommandLink(argv: string[]): Link {
    const [, pid, stdinFd, stdoutFd, stderrFd] = GLib.spawn_async_with_pipes(null, argv, null, GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
    let stderr = '';
    let exited = false, status = 0;
    const errReader = new LineReader(stderrFd, true, text => { stderr = `${stderr}${text}\n`.slice(-STDERR_TAIL); }, () => { /* the command closed stderr */ });
    // GLib has no kill(); the system's kill is used, and its complaint about a process that just went away is dropped.
    const signal = (name: string) => {
        if (exited) return;
        try { GLib.spawn_async(null, ['kill', `-${name}`, String(pid)], null, GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.STDERR_TO_DEV_NULL, null); } catch { /* gone */ }
    };

    const link = new StreamLink(stdoutFd, stdinFd, true, () => {
        errReader.stop();
        signal('TERM');   // closing stdin already asks a bridge to finish; this is for a command that does not
    }, end => {
        // stdout closed, which usually means the command is exiting: wait for its exit status and stderr, which
        // are the reason worth showing ("Permission denied"), and only give up on them after a moment.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, EXIT_WAIT_MS, () => { end(null); return GLib.SOURCE_REMOVE; });
    });
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid!, (_pid, wait) => {
        exited = true;
        status = (wait & 0x7f) === 0 ? (wait >> 8) & 0xff : 128 + (wait & 0x7f);
        GLib.spawn_close_pid(pid!);
        link.end(status === 0 ? null : (stderr.trim() || `the command exited with status ${status}`));
    });
    return link;
}

export interface SshTarget {
    host: string;                  // a name from ~/.ssh/config, or user@host
    remoteCommand?: string;        // default "markworkd bridge"; give a full path if it is not on the non-interactive PATH
    options?: string[];            // extra ssh arguments, e.g. ['-p', '2222', '-i', '/path/key']
}

// The command that reaches a remote daemon: `ssh -T host markworkd bridge`. BatchMode makes a missing key or
// passphrase fail at once instead of waiting for a terminal this app does not have; the keep-alive notices a link
// that died without a clean close.
export function sshBridgeArgv(t: SshTarget): string[] {
    return [
        'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
        ...(t.options ?? []), '--', t.host, t.remoteCommand ?? 'markworkd bridge',
    ];
}
