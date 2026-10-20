// Files and folders on Node: node:fs for whole-file reads and atomic writes, listings, lookups, and folder watches; a
// worker thread for background writes. Raw: the queueing per path and the app's change notices are in base/files.ts.

import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, watch, writeSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { EntryInfo, EntryKind, FileSystem } from '../index.js';

let tempCounter = 0;

// Writes to a temporary file next to the target, fsyncs, then renames over it: a reader sees the old file or the new one.
function writeAtomic(path: string, text: string): void {
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${++tempCounter}.tmp`);
    const fd = openSync(temp, 'w', 0o644);
    try {
        writeSync(fd, text);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    try {
        renameSync(temp, path);
    } catch (e) {
        rmSync(temp, { force: true });
        throw e;
    }
}

// The background writer: the same atomic write, in a worker so the fsync pause is not felt on the main thread. It
// reports each finished write on a port the main thread reads synchronously (receiveMessageOnPort) and bumps a shared
// counter, so pumpWrites(true) can block on Atomics.wait.
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const signal = new Int32Array(workerData.signal);
const results = workerData.results;
let counter = 0;
parentPort.on('message', ({ id, path: target, text }) => {
    let error = null;
    const temp = path.join(path.dirname(target), '.' + path.basename(target) + '.' + process.pid + '.w' + (++counter) + '.tmp');
    try {
        const fd = fs.openSync(temp, 'w', 0o644);
        try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try { fs.renameSync(temp, target); } catch (e) { fs.rmSync(temp, { force: true }); throw e; }
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    }
    results.postMessage({ id, error });
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
});
`;

interface Writer {
    worker: Worker;
    results: MessageChannel['port1'];
    signal: Int32Array;
    seen: number;
    pending: Map<number, (error: unknown) => void>;
    nextId: number;
}
let writer: Writer | null = null;

function backgroundWriter(): Writer {
    if (writer) return writer;
    const shared = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER, { eval: true, workerData: { signal: shared, results: port2 }, transferList: [port2] });
    worker.unref();       // an idle writer does not keep the process alive
    port1.unref();
    writer = { worker, results: port1, signal: new Int32Array(shared), seen: 0, pending: new Map(), nextId: 0 };
    return writer;
}

function startWrite(path: string, text: string, done: (error: unknown) => void): void {
    try {
        const w = backgroundWriter();
        const id = ++w.nextId;
        w.pending.set(id, done);
        w.worker.postMessage({ id, path, text });
    } catch (e) {
        done(e);
    }
}

// Runs the done of every finished write; with wait, first blocks until at least one write has finished.
function pumpWrites(wait: boolean): void {
    const w = writer;
    if (!w || !w.pending.size) return;
    if (wait && Atomics.load(w.signal, 0) === w.seen) Atomics.wait(w.signal, 0, w.seen, 10000);
    w.seen = Atomics.load(w.signal, 0);
    for (let m = receiveMessageOnPort(w.results); m; m = receiveMessageOnPort(w.results)) {
        const { id, error } = m.message as { id: number; error: string | null };
        const done = w.pending.get(id);
        w.pending.delete(id);
        done?.(error === null ? null : new Error(error));
    }
}

function kindOf(stats: Stats): EntryKind {
    if (stats.isSymbolicLink()) return 'symlink';
    return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

const entryOf = (name: string, stats: Stats): EntryInfo => ({
    name,
    kind: kindOf(stats),
    size: stats.size,
    stamp: `${stats.size}:${stats.mtimeMs}`,
});

function kind(path: string): EntryKind {
    try {
        return kindOf(lstatSync(path));
    } catch (e) {
        if (isMissing(e)) return 'missing';
        throw e;
    }
}

// A move across file systems is a copy and a delete; something already at `to` is an error.
function move(from: string, to: string): void {
    if (kind(to) !== 'missing') throw new Error(`${to} already exists`);
    try {
        renameSync(from, to);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        rmSync(from, { recursive: true });
    }
}

// The freedesktop.org trash: the home trash for a file on the home file system, otherwise $topdir/.Trash-$uid.
function trashDir(path: string): string {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
    const home = join(dataHome, 'Trash');
    mkdirSync(dataHome, { recursive: true });
    const device = lstatSync(path).dev;
    if (statSync(dataHome).dev === device) return home;
    let top = dirname(path);
    while (dirname(top) !== top && statSync(dirname(top)).dev === device) top = dirname(top);
    return join(top, `.Trash-${process.getuid?.() ?? 0}`);
}

const trashInfo = (path: string) => [
    '[Trash Info]',
    `Path=${path.split('/').map(encodeURIComponent).join('/')}`,
    `DeletionDate=${new Date().toISOString().slice(0, 19)}`,
    '',
].join('\n');

function trashFreedesktop(path: string): void {
    const dir = trashDir(path);
    mkdirSync(join(dir, 'files'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'info'), { recursive: true, mode: 0o700 });
    const name = basename(path);
    let unique = name;
    for (let n = 2; existsSync(join(dir, 'info', `${unique}.trashinfo`)) || existsSync(join(dir, 'files', unique)); n++) unique = `${name}.${n}`;
    writeAtomic(join(dir, 'info', `${unique}.trashinfo`), trashInfo(path));
    try {
        renameSync(path, join(dir, 'files', unique));
    } catch (e) {
        rmSync(join(dir, 'info', `${unique}.trashinfo`), { force: true });
        throw e;
    }
}

// macOS: the user's ~/.Trash, under a name that is free there. (Finder's "Put Back" needs its own record, so it is not offered.)
function trashMac(path: string): void {
    const dir = join(homedir(), '.Trash');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = basename(path);
    let unique = name;
    for (let n = 2; existsSync(join(dir, unique)); n++) unique = `${name}.${n}`;
    renameSync(path, join(dir, unique));
}

// Windows: the Recycle Bin, through the shell's own call in PowerShell (there is no synchronous API in Node). The path
// goes in the environment, not in the script, so no quoting can change what is deleted.
const RECYCLE = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$p = $env:MARKWORK_TRASH_PATH',
    "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
].join('; ');

function trashWindows(path: string): void {
    try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', RECYCLE], {
            env: { ...process.env, MARKWORK_TRASH_PATH: path }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000,
        });
    } catch (e) {
        const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
        throw new Error(stderr || (e as Error).message);
    }
}

const trash = (path: string): void =>
    process.platform === 'darwin' ? trashMac(path) : process.platform === 'win32' ? trashWindows(path) : trashFreedesktop(path);

function listInfo(dir: string): EntryInfo[] {
    return readdirSync(dir).map(name => entryOf(name, lstatSync(join(dir, name))));
}

function isDirectory(path: string): boolean {
    try { return statSync(path).isDirectory(); } catch { return false; }
}

// inotify reports a move as two events, one per name, so both names reach onChange as the contract asks.
function watchDir(dir: string, onChange: (path: string) => void): () => void {
    const watcher = watch(dir, { persistent: false }, (_event, name) => onChange(name ? join(dir, name.toString()) : dir));
    watcher.on('error', () => { /* the folder went away; nothing more will change */ });
    return () => watcher.close();
}

export const nodeFiles: FileSystem = {
    readText: path => readFileSync(path, 'utf8'),
    writeText: writeAtomic,
    append: (path, text) => appendFileSync(path, text),
    startWrite,
    pumpWrites,
    exists: path => existsSync(path),   // follows a symbolic link
    remove: path => { if (lstatSync(path).isDirectory()) rmdirSync(path); else rmSync(path); },   // a file or an empty folder
    makeDirs: (path, mode) => { mkdirSync(path, { recursive: true, mode }); },
    setMode: (path, mode) => chmodSync(path, mode),
    list: dir => readdirSync(dir),
    kind,
    isDirectory,
    trash,
    move,
    copy: (from, to) => {
        if (kind(to) !== 'missing') throw new Error(`${to} already exists`);
        cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    },
    info: path => entryOf(basename(path), lstatSync(path)),
    listInfo,
    watchDir,
};
