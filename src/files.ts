// Read/write UTF-8 text files the way the app does: a write first waits for older background writes to the same
// path, and every change is announced (onDiskChange). Throws on failure; handling is up to the caller. The disk itself
// is the platform's (platform().fs; GLib and Gio under GJS).

import { platform } from './platform/index.js';
import { atOrBelow } from './markdown/pathbelow.js';

export function readTextFile(path: string): string {
    return platform().fs.readText(path);
}

export function writeTextFile(path: string, text: string): void {
    flushWrites(path);
    platform().fs.writeText(path, text);
    notifyDiskChange(path);
}

export const fileExists = (path: string): boolean => platform().fs.exists(path);

// An absolute path as a file:// URI, each part percent-encoded. A Windows path (C:\a b\c) becomes file:///C:/a%20b/c.
export function fileUri(path: string): string {
    const encode = (parts: string[]) => parts.map(encodeURIComponent).join('/');
    if (/^[A-Za-z]:[\\/]/.test(path)) {
        const [drive, ...rest] = path.replace(/\\/g, '/').split('/');
        return `file:///${drive}/${encode(rest)}`;
    }
    return `file://${encode(path.split('/'))}`;
}

// Where `path` lies inside `root`, as a name with / for a separator (the form notes and boards use whatever the system's
// separator is); null when it is not strictly inside (the root itself, or elsewhere).
export function insideName(root: string, path: string): string | null {
    const rel = platform().paths.relative(root, path);
    return rel && platform().os === 'win32' ? rel.replace(/\\/g, '/') : rel;
}

// Move to the Trash (recoverable), not a permanent delete.
export function trashFile(path: string): void {
    try {
        flushWrites(path);
        platform().fs.trash(path);
    } catch (e) {
        throw new Error(`Failed to delete: ${(e as Error).message}`);
    }
    notifyDiskChange(path);
}

// Changes the app itself makes on disk (writes here, file operations in fileops.ts). Listeners (the
// workspace snapshot) hear of them right away, before a file monitor would report them.
const diskListeners = new Set<(path: string) => void>();

export function onDiskChange(listener: (path: string) => void): () => void {
    diskListeners.add(listener);
    return () => diskListeners.delete(listener);
}

export function notifyDiskChange(...paths: string[]): void {
    for (const listener of diskListeners) for (const path of paths) listener(path);
}

type Done = (error: unknown) => void;

// Background writes per path: at most one runs at a time, and at most one waits behind it. A newer
// write replaces the waiting one (its text is newer), so an older version can never finish last.
// The callbacks of a replaced write are called when the write that replaced it finishes.
interface Queue {
    running: Done[];
    next: { text: string; done: Done[] } | null;
}
const queues = new Map<string, Queue>();

// Finished writes whose callbacks have not been called yet. Called only from the main loop, never from flushWrites.
const finished: { done: Done[]; error: unknown }[] = [];
let pumpTimer: ReturnType<typeof setInterval> | null = null;

// The main loop drives the background writes with a short timer while any are running.
function ensurePump(): void {
    if (pumpTimer) return;
    pumpTimer = setInterval(() => {
        platform().fs.pumpWrites(false);
        for (const { done, error } of finished.splice(0)) for (const d of done) d(error);
        if (queues.size || finished.length) return;
        clearInterval(pumpTimer!);
        pumpTimer = null;
    }, 4);
}

function start(path: string, text: string, queue: Queue): void {
    const complete = (error: unknown) => {
        if (!error) notifyDiskChange(path);
        finished.push({ done: queue.running, error });
        const next = queue.next;
        queue.next = null;
        if (next) {
            queue.running = next.done;
            start(path, next.text, queue);
        } else {
            queues.delete(path);
        }
    };
    platform().fs.startWrite(path, text, complete);
}

// Write a file without blocking the main thread: the platform writes to a temporary file, fsyncs, then
// atomically replaces the target file off the main thread. Used by autosave so the fsync pause
// (can be tens of milliseconds on a slow disk) is not felt while the user keeps typing.
// Writes to the same path finish in the order they were requested; a write that has not started
// yet is replaced by a newer one. done is called later from the default main loop, never during
// this call or during flushWrites; error = null on success.
export function writeTextFileAsync(path: string, text: string, done: Done): void {
    const queue = queues.get(path);
    if (queue) {
        queue.next = { text, done: [...queue.next?.done ?? [], done] };
    } else {
        const fresh: Queue = { running: [done], next: null };
        queues.set(path, fresh);
        start(path, text, fresh);
    }
    ensurePump();
}

// Finish the background writes to `path` (or to files inside the folder `path`), including any
// waiting ones. Called before writing, moving, or deleting a file, so the result of an older
// background write does not overwrite later changes. Only write completions run while it waits;
// their done callbacks follow later from the main loop. Rarely waits: a background write takes
// only a few milliseconds.
export function flushWrites(path: string): void {
    const busy = () => [...queues.keys()].some(p => atOrBelow(path, p));
    while (busy()) platform().fs.pumpWrites(true);
}

