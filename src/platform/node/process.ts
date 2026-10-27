// Processes on Node: child_process for a program run to the end (git) and for a long-running harness spoken to line by
// line.

import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { programNames } from './dirs';
import { openFirstTerminal } from '../terminals';
import type { ChildHandlers, ChildProcess, Processes, RunRequest, RunResult } from '../index';

const STDERR_TAIL = 8000;
const DRAIN_MS = 1500;   // grace period for reading remaining output after the process exits
const KILL_MS = 5000;    // SIGTERM ignored for this long → SIGKILL

// The exit status as the port reports it: the exit code, or 128 + the signal number.
export function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
    if (code !== null) return code;
    const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15 };
    return 128 + (signal ? numbers[signal] ?? 0 : 0);
}

// A run that has not finished by timeoutMs is stopped, and one whose output has not arrived lostMs
// after the program exited is settled as lost.
function run({ argv, cwd, env = {}, timeoutMs = 120000, lostMs = 5000 }: RunRequest): Promise<RunResult | null> {
    const name = basename(argv[0]);
    return new Promise(resolve => {
        let done = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const finish = (result: RunResult | null) => {
            if (done) return;
            done = true;
            for (const t of timers) clearTimeout(t);
            resolve(result);
        };
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawnChild(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: 'pipe' });
        } catch {
            finish(null);
            return;
        }
        let out = '', err = '';
        child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
        child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
        child.stdin.on('error', () => { /* a program that exits without reading its input */ });
        child.stdin.end();
        child.on('error', () => finish(null));   // not installed, or the folder does not exist
        child.on('exit', () => {
            timers.push(setTimeout(() => finish({ status: -1, out: '', err: `${name} finished but its result was lost; try again` }), lostMs));
        });
        child.on('close', (code, signal) => finish({ status: code ?? -1, out, err: signal && code === null ? err || `${name} was stopped by ${signal}` : err }));
        timers.push(setTimeout(() => {
            child.kill('SIGKILL');
            finish({ status: -1, out: '', err: `${name} did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped` });
        }, timeoutMs));
    });
}

// Lines are split only at LF, matching pi's JSONL framing.
function lineSplitter(onLine: (text: string) => void): { push(chunk: string): void; end(): void } {
    let rest = '';
    return {
        push(chunk) {
            const parts = (rest + chunk).split('\n');
            rest = parts.pop()!;
            for (const line of parts) onLine(line);
        },
        end() { if (rest) onLine(rest); rest = ''; },
    };
}

function spawn(argv: string[], cwd: string, handlers: ChildHandlers): ChildProcess {
    // Node reports a program that cannot be run asynchronously; the contract throws, so it is checked first.
    accessSync(argv[0], constants.X_OK);
    if (!statSync(cwd).isDirectory()) throw new Error(`${cwd} is not a folder`);
    const child = spawnChild(argv[0], argv.slice(1), { cwd, stdio: 'pipe' });
    let stderr = '';
    let status = 0;
    let exited = false, reported = false;
    let pending = 3;   // stdout ended, stderr ended, process exited
    let drainTimer: ReturnType<typeof setTimeout> | null = null, killTimer: ReturnType<typeof setTimeout> | null = null;
    let inputOpen = true;
    const closeInput = () => {
        if (!inputOpen) return;
        inputOpen = false;
        child.stdin.end();
    };
    const done = () => {
        if (--pending > 0 || reported) return;
        reported = true;
        if (drainTimer) clearTimeout(drainTimer);
        if (killTimer) clearTimeout(killTimer);
        closeInput();
        handlers.exit(status, stderr);
    };
    const out = lineSplitter(text => handlers.line(text));
    const err = lineSplitter(text => { stderr = `${stderr}${text}\n`.slice(-STDERR_TAIL); });
    const read = (stream: NodeJS.ReadableStream, lines: ReturnType<typeof lineSplitter>) => {
        let open = true;
        const close = () => { if (!open) return; open = false; lines.end(); done(); };
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => { if (open) lines.push(chunk); });
        stream.on('end', close);
        stream.on('error', close);
        return close;
    };
    const closers = [read(child.stdout, out), read(child.stderr, err)];
    child.stdin.on('error', () => { inputOpen = false; });
    child.on('error', () => { /* reported through exit */ });
    child.on('exit', (code, signal) => {
        exited = true;
        status = exitStatus(code, signal);
        // Grandchild processes may inherit the pipes and keep them open; do not wait for them indefinitely.
        if (pending > 1) drainTimer = setTimeout(() => { drainTimer = null; for (const close of closers) close(); }, DRAIN_MS);
        done();
    });
    return {
        write: line => {
            if (!inputOpen || exited) return false;
            try { child.stdin.write(`${line}\n`); return true; } catch { closeInput(); return false; }
        },
        closeInput,
        stop: () => {
            if (exited) return;
            child.kill('SIGTERM');
            if (!killTimer) killTimer = setTimeout(() => { killTimer = null; if (!exited) child.kill('SIGKILL'); }, KILL_MS);
        },
    };
}

function executable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return !statSync(path).isDirectory();
    } catch {
        return false;
    }
}

// Apps launched from the desktop menu often do not inherit the shell PATH (e.g. ~/.local/bin from the profile).
function findProgram(name: string): string | null {
    const windows = process.platform === 'win32';
    const names = programNames(windows ? 'win32' : 'linux', name, process.env.PATHEXT);
    const first = (paths: string[]): string | null => paths.find(executable) ?? null;
    if (name.includes('/') || (windows && name.includes('\\'))) return first(names);
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const own = windows ? [join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm')]
        : ['.local/bin', '.npm-global/bin', 'bin', '.local/share/mise/shims'].map(dir => join(homedir(), dir));
    for (const dir of [...dirs, ...own]) {
        const found = first(names.map(n => join(dir, n)));
        if (found) return found;
    }
    return null;
}

function launch(argv: string[]): boolean {
    if (!findProgram(argv[0])) return false;
    try {
        const child = spawnChild(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
        child.on('error', () => { /* it was found a moment ago; nothing to report to */ });
        child.unref();
        return true;
    } catch {
        return false;
    }
}

function openTerminal(folder: string, command: string[] | null): boolean {
    return openFirstTerminal(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', { findProgram, launch }, folder, command);
}

export const nodeProcesses: Processes = { run, spawn, findProgram, launch, openTerminal, hostName: () => hostname() };
