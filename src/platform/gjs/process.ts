// Processes on GJS: Gio.Subprocess for a program run to the end (git), GLib.spawn with IOChannels for a long-running
// harness spoken to line by line.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { ChildHandlers, ChildProcess, Processes, RunRequest, RunResult } from '../index.js';

// GJS 1.80 can block an async callback that arrives while it is garbage collecting ("Attempting to run a JS
// callback during garbage collection"): communicate_utf8_async() then never calls back although the program has finished,
// and whatever awaits it (the History tab, an agent Git tool) waits forever. A watchdog settles the run instead,
// as a failure: the output is gone, and a commit must not be repeated blindly. It also stops a program that hangs,
// e.g. git on a signing passphrase prompt.
function run({ argv, cwd, env = {}, timeoutMs = 120000, lostMs = 5000 }: RunRequest): Promise<RunResult | null> {
    const name = GLib.path_get_basename(argv[0]);
    return new Promise(resolve => {
        let done = false, watchdog = 0;
        const finish = (result: RunResult | null) => {
            if (done) return;
            done = true;
            if (watchdog) GLib.source_remove(watchdog);
            resolve(result);
        };
        try {
            const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
            launcher.set_cwd(cwd);
            for (const [key, value] of Object.entries(env)) launcher.setenv(key, value, true);
            const proc = launcher.spawnv(argv);
            const started = GLib.get_monotonic_time();
            let exitedAt = 0;
            watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                const now = GLib.get_monotonic_time();
                if (!exitedAt && proc.get_identifier() === null) exitedAt = now;   // reaped: the program has exited
                const lost = exitedAt > 0 && now - exitedAt > lostMs * 1000;
                const hung = !exitedAt && now - started > timeoutMs * 1000;
                if (!lost && !hung) return GLib.SOURCE_CONTINUE;
                watchdog = 0;
                if (hung) proc.force_exit();
                finish({ status: -1, out: '', err: lost ? `${name} finished but its result was lost; try again` : `${name} did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped` });
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, null, (_proc, result) => {
                try {
                    const [, out, err] = proc.communicate_utf8_finish(result);
                    finish({ status: proc.get_if_exited() ? proc.get_exit_status() : -1, out: out ?? '', err: err ?? '' });
                } catch (e) {
                    finish(null);
                }
            });
        } catch (e) {
            finish(null);
        }
    });
}

const STDERR_TAIL = 8000;
const DRAIN_MS = 1500;   // grace period for reading remaining output after the process exits
const KILL_MS = 5000;    // SIGTERM ignored for this long → SIGKILL

// Pipes are read through GLib.IOChannel, not Gio.Subprocess.get_stdout_pipe(): after Gtk is loaded, GJS wraps
// that pipe as a Gio.UnixInputStream and prints a Gjs-WARNING "moved to a separate platform-specific library".
function spawn(argv: string[], cwd: string, handlers: ChildHandlers): ChildProcess {
    // Throws GLib.Error if the program cannot be run.
    const [, pid, stdinFd, stdout, stderrFd] = GLib.spawn_async_with_pipes(cwd, argv, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
    // stdin is the command channel (prompt, answers, steering); it is closed to end the harness.
    let input: GLib.IOChannel | null = GLib.IOChannel.unix_new(stdinFd);
    input.set_close_on_unref(true);
    // Bytes as is with an explicit length: a JS string with length -1 is not guaranteed to be NUL-terminated.
    input.set_encoding(null);
    const encoder = new TextEncoder();
    const closeInput = () => {
        if (!input) return;
        try { input.shutdown(true); } catch { /* the harness already exited */ }
        input = null;
    };
    let stderr = '';
    let status = 0;
    let exited = false;
    let pending = 3;   // stdout exhausted, stderr exhausted, process exited
    let drainTimer = 0, killTimer = 0;
    const streams: ((fromWatch?: boolean) => void)[] = [];   // closers of readers that are still running
    const done = () => {
        if (--pending > 0) return;
        if (drainTimer) GLib.source_remove(drainTimer);
        if (killTimer) GLib.source_remove(killTimer);
        drainTimer = killTimer = 0;
        closeInput();
        GLib.spawn_close_pid(pid!);
        handlers.exit(status, stderr);
    };

    // Lines are split only at LF, matching pi's JSONL framing.
    const readLines = (fd: number, onLine: (text: string) => void) => {
        const channel = GLib.IOChannel.unix_new(fd);
        channel.set_close_on_unref(true);
        channel.set_flags(GLib.IOFlags.NONBLOCK);
        let open = true;
        const close = (fromWatch = false) => {
            if (!open) return;
            open = false;
            if (!fromWatch) GLib.source_remove(watch);
            try { channel.shutdown(false); } catch { /* already closed */ }
            done();
        };
        const watch = GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, () => {
            for (;;) {
                let status: GLib.IOStatus, line: string;
                try { [status, line] = channel.read_line(); } catch { status = GLib.IOStatus.ERROR; line = ''; }
                if (status === GLib.IOStatus.NORMAL) { onLine(line.replace(/\n$/, '')); continue; }
                if (status === GLib.IOStatus.AGAIN) return GLib.SOURCE_CONTINUE;
                close(true);   // EOF or error; the watch source is removed through the return value
                return GLib.SOURCE_REMOVE;
            }
        });
        streams.push(close);
    };
    readLines(stdout, text => handlers.line(text));
    readLines(stderrFd, text => { stderr = `${stderr}${text}\n`.slice(-STDERR_TAIL); });

    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid!, (_pid, wait) => {
        exited = true;
        // POSIX wait status: the low 7 bits = signal (0 = normal exit), bits 8–15 = exit code.
        status = (wait & 0x7f) === 0 ? (wait >> 8) & 0xff : 128 + (wait & 0x7f);
        // Grandchild processes (e.g. commands from the harness's bash tool) may inherit the pipe and keep it open;
        // do not wait for them indefinitely.
        if (pending > 1) drainTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAIN_MS, () => { drainTimer = 0; for (const close of streams) close(); return GLib.SOURCE_REMOVE; });
        done();
    });
    // GLib has no kill(); signals are sent through the system's built-in kill command.
    const signal = (name: string) => { try { GLib.spawn_async(null, ['kill', `-${name}`, String(pid)], null, GLib.SpawnFlags.SEARCH_PATH, null); } catch { /* the process is gone */ } };
    return {
        write: line => {
            if (!input || exited) return false;
            try {
                // One small command per write; a write blocks briefly if the pipe is full, and that is enough here.
                const bytes = encoder.encode(`${line}\n`);
                input.write_chars(bytes, bytes.length);
                input.flush();
                return true;
            } catch {
                closeInput();
                return false;
            }
        },
        closeInput,
        stop: () => {
            if (exited) return;
            signal('TERM');
            if (!killTimer) killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KILL_MS, () => { killTimer = 0; if (!exited) signal('KILL'); return GLib.SOURCE_REMOVE; });
        },
    };
}

// Apps launched from the desktop menu often do not inherit the shell PATH (e.g. ~/.local/bin from the profile).
function findProgram(name: string): string | null {
    const found = GLib.find_program_in_path(name);
    if (found) return found;
    const home = GLib.get_home_dir();
    for (const dir of ['.local/bin', '.npm-global/bin', 'bin', '.local/share/mise/shims']) {
        const path = GLib.build_filenamev([home, dir, name]);
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) && !GLib.file_test(path, GLib.FileTest.IS_DIR)) return path;
    }
    return null;
}

function launch(argv: string[]): boolean {
    try { return GLib.spawn_async(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null)[0]; } catch { return false; }
}

export const gjsProcesses: Processes = { run, spawn, findProgram, launch, hostName: () => GLib.get_host_name() };
