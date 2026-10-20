// The Markdown files of a work folder, for everything that reads the folder as a whole: the chat context, Home,
// [[note]] suggestions and links, and harness prompts.
//
// - A snapshot per folder holds the list of Markdown files with their size and modification time. Every folder in
//   it is watched (platform().fs.watchDir; a Gio.FileMonitor under GJS), so the folder is only walked again after
//   something changed. Changes the app makes itself arrive at once through files.ts (onDiskChange), before the
//   monitor reports them. A folder
//   that cannot be fully watched (too many folders, or a file system without monitors) is walked on every request,
//   as before. A read can ask to walk again regardless (see Freshness).
// - File contents are cached by size and modification time, least recently used first out, up to a memory limit.
// - warm() walks the folder and reads the contents in short slices from an idle callback, so opening a large
//   folder does not stall the window and the first chat question or Home refresh finds everything cached. A
//   request that arrives before warming finished completes the remaining walk synchronously.
// - Unsaved documents are read from their editor (the `unsaved` overlay), not from disk.

import { onDiskChange, readTextFile } from './files.js';
import { platform } from './platform/index.js';
import { atOrBelow } from './markdown/paths.js';

export interface WorkspaceFile {
    name: string;   // relative to the folder, with '/'
    text: string;
}

// How up to date a read must be:
// - cached:  the snapshot; outside changes appear once their monitor event is handled (Home, suggestions, previews)
// - current: walk the folder again; contents come from the cache when size and time match (the start of a chat turn)
// - fresh:   walk again and read every file from disk (verifying the result of a change)
export type Freshness = 'cached' | 'current' | 'fresh';

export interface ReadOptions {
    except?: string | null;              // absolute path to leave out (the active document)
    freshness?: Freshness;               // default cached
    keep?: (text: string) => boolean;    // filter by contents, applied before the file limit
    limit?: number;                      // the most files returned
}

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd)$/i;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build']);
export const MAX_FILES = 300;              // files returned by files() unless a limit is given
const MAX_FILE_BYTES = 2_000_000;          // larger files are not read as context
const MAX_ENTRIES = 20_000;                // the walk stops after this many Markdown files
const MAX_WATCHED_DIRS = 512;              // more folders than this: no monitors, walk on every request
const DEFAULT_CACHE_UNITS = 32 * 1024 * 1024;   // cached contents, in UTF-16 code units (≈ 64 MB)
const SNAPSHOTS = 4;                       // folders kept (work folder, a document's folder, a board's folder)
const SLICE_MS = 6;                        // time per idle slice while warming
const RESCAN_DELAY_MS = 150;               // consecutive changes are merged into one background walk

interface Entry {
    path: string;
    name: string;
    size: number;
    stamp: string;
}

type Item = Entry | { dir: string };

// Walk the Markdown files under root alphabetically (excluding dot files and the tools' built-in folders). Yields
// every folder before its contents, then its files; one folder listing is the unit of work between yields.
function* walk(dir: string, prefix: string): Generator<Item> {
    let children;
    try {
        children = platform().fs.listInfo(dir);
    } catch (e) {
        return;
    }
    yield { dir };
    children.sort((a, b) => a.name.localeCompare(b.name, 'id', { numeric: true }));
    for (const info of children) {
        const name = info.name;
        if (name.startsWith('.')) continue;
        const path = platform().paths.join(dir, name);
        // Symbolic links are not followed (listInfo reports them as such).
        if (info.kind === 'directory') {
            if (!SKIPPED_DIRS.has(name)) yield* walk(path, `${prefix}${name}/`);
        } else if (info.kind === 'file' && MARKDOWN_FILE.test(name)) {
            yield { path, name: `${prefix}${name}`, size: info.size, stamp: info.stamp };
        }
    }
}

class Snapshot {
    entries: Entry[] = [];
    index = new Map<string, Entry>();   // path → entry
    scanned = false;              // entries hold a complete walk
    dirty = true;                 // something changed since the last walk
    watched = false;              // every folder in the walk is monitored
    version = 0;                  // bumped on every change; a walk that saw a change during it stays dirty
    scan: Generator<void> | null = null;
    prefetch: Generator<void> | null = null;
    warm = false;                 // keep walking in the background after changes
    rescanTimer: (() => void) | null = null;          // cancels the pending background walk
    readonly monitors = new Map<string, () => void>();   // folder → stops watching it

    constructor(readonly root: string) {}

    // Can requests be answered without walking the folder?
    get valid(): boolean { return this.scanned && !this.dirty && this.watched && !this.scan; }

    contains(path: string): boolean { return atOrBelow(this.root, path); }

    close(): void {
        for (const stop of this.monitors.values()) stop();
        this.monitors.clear();
        this.rescanTimer?.();
        this.rescanTimer = null;
        this.scan = this.prefetch = null;
    }
}

export class WorkspaceRepository {
    private readonly snapshots = new Map<string, Snapshot>();
    private readonly texts = new Map<string, { stamp: string; text: string }>();   // insertion order = least recently used first
    private cachedUnits = 0;
    private idle: (() => void) | null = null;   // cancels the idle work
    private readonly stopListening: () => void;

    // unsaved: absolute path → editor text of documents with unsaved changes.
    constructor(private readonly unsaved: () => ReadonlyMap<string, string> = () => new Map(),
                private readonly cacheUnits = DEFAULT_CACHE_UNITS) {
        this.stopListening = onDiskChange(path => this.changed(path));
    }

    // Relative names of the Markdown files under root, without reading their contents (for [[note]] suggestions).
    names(root: string, limit = 5000): string[] {
        return this.snapshot(root, false).entries.slice(0, limit).map(e => e.name);
    }

    // The Markdown files under root with their contents (unsaved documents from their editor).
    files(root: string, options: ReadOptions = {}): WorkspaceFile[] {
        const { except = null, freshness = 'cached', keep, limit = MAX_FILES } = options;
        const fresh = freshness === 'fresh';
        const snap = this.snapshot(root, freshness !== 'cached');
        const unsaved = this.unsaved();
        const files: WorkspaceFile[] = [];
        for (const entry of snap.entries) {
            if (files.length >= limit) break;
            if (entry.path === except) continue;
            let text = unsaved.get(entry.path) ?? null;
            if (text === null) {
                if (entry.size > MAX_FILE_BYTES) continue;
                text = this.read(entry, fresh);
                if (text === null) continue;
            }
            if (keep && !keep(text)) continue;
            files.push({ name: entry.name, text });
        }
        return files;
    }

    // Walk root and read its contents in the background, and keep the snapshot up to date after changes.
    warm(root: string): void {
        const snap = this.get(normalize(root));
        snap.warm = true;
        if (!snap.valid && !snap.scan) snap.scan = this.scanner(snap);
        snap.prefetch ??= this.prefetcher(snap);
        this.schedule();
    }

    // The window closed: stop the monitors and background work, and drop the cache.
    close(): void {
        this.stopListening();
        for (const snap of this.snapshots.values()) snap.close();
        this.snapshots.clear();
        this.idle?.();
        this.idle = null;
        this.texts.clear();
        this.cachedUnits = 0;
    }

    // For tests: the contents currently cached, and whether background work is still queued.
    get cacheSize(): number { return this.cachedUnits; }
    get busy(): boolean { return this.idle !== null; }

    // ---------- Snapshots ----------

    private get(root: string): Snapshot {
        let snap = this.snapshots.get(root);
        if (snap) {
            this.snapshots.delete(root);   // most recently used last
        } else {
            snap = new Snapshot(root);
            const oldest = this.snapshots.size >= SNAPSHOTS ? this.snapshots.keys().next().value : undefined;
            if (oldest !== undefined) { this.snapshots.get(oldest)!.close(); this.snapshots.delete(oldest); }
        }
        this.snapshots.set(root, snap);
        return snap;
    }

    // An up-to-date snapshot of root: finishes a walk in progress, or walks again if anything changed (always if rescan).
    private snapshot(rawRoot: string, rescan: boolean): Snapshot {
        const snap = this.get(normalize(rawRoot));
        if (rescan) snap.scan = this.scanner(snap);
        // A change during the walk leaves the snapshot dirty; walk once more, then answer with what there is.
        for (let round = 0; round < 2 && (snap.scan || !snap.valid); round++) {
            const scan = snap.scan ??= this.scanner(snap);
            while (!scan.next().done) { /* walk to the end */ }
        }
        return snap;
    }

    private *scanner(snap: Snapshot): Generator<void> {
        const start = snap.version;
        const entries: Entry[] = [], dirs: string[] = [];
        for (const item of walk(snap.root, '')) {
            if ('dir' in item) dirs.push(item.dir);
            else if (entries.push(item) >= MAX_ENTRIES) break;
            yield;
        }
        if (snap.scan === null) return;   // closed meanwhile
        snap.entries = entries;
        snap.index = new Map(entries.map(e => [e.path, e]));
        snap.scanned = true;
        snap.dirty = snap.version !== start;
        snap.scan = null;
        this.watch(snap, dirs);
        // Forget contents of files under root that were deleted or moved, so the cache does not keep stale texts.
        if (entries.length < MAX_ENTRIES) {
            const present = new Set(entries.map(e => e.path));
            for (const path of [...this.texts.keys()]) if (snap.contains(path) && !present.has(path)) this.forget(path);
        }
    }

    // Monitor exactly the folders of the last walk; give up on monitoring when there are too many.
    private watch(snap: Snapshot, dirs: string[]): void {
        const wanted = new Set(dirs.length <= MAX_WATCHED_DIRS ? dirs : []);
        for (const [dir, stop] of snap.monitors) {
            if (!wanted.has(dir)) { stop(); snap.monitors.delete(dir); }
        }
        snap.watched = dirs.length > 0 && wanted.size === dirs.length;
        for (const dir of wanted) {
            if (snap.monitors.has(dir)) continue;
            try {
                snap.monitors.set(dir, platform().fs.watchDir(dir, path => this.changed(path, snap)));
            } catch (e) {
                // Cannot be monitored (for example a network file system): walk on every request instead.
                snap.watched = false;
            }
        }
    }

    // A path changed on disk. A file the snapshot already lists only gets its new size and time (autosave
    // does not cost a walk); anything else (a new, deleted, or moved file or folder) makes the snapshots
    // containing it walk again on their next use, or soon in the background if warm.
    private changed(path: string, only?: Snapshot): void {
        this.forget(path);
        const prefix = `${path}/`;
        for (const key of [...this.texts.keys()]) if (key.startsWith(prefix)) this.forget(key);
        for (const snap of only ? [only] : this.snapshots.values()) {
            if (!snap.contains(path)) continue;
            const entry = snap.index.get(path);
            if (entry && !snap.dirty && !snap.scan && restamp(entry)) continue;
            snap.version++;
            snap.dirty = true;
            if (snap.warm && !snap.rescanTimer) {
                snap.rescanTimer = platform().scheduler.idleAfter(RESCAN_DELAY_MS, () => {
                    snap.rescanTimer = null;
                    if (!snap.valid && !snap.scan) snap.scan = this.scanner(snap);
                    snap.prefetch ??= this.prefetcher(snap);
                    this.schedule();
                });
            }
        }
    }

    // ---------- Contents ----------

    private read(entry: Entry, fresh: boolean): string | null {
        const cached = this.texts.get(entry.path);
        if (cached && !fresh && cached.stamp === entry.stamp) {
            this.texts.delete(entry.path);   // most recently used last
            this.texts.set(entry.path, cached);
            return cached.text;
        }
        let text: string;
        try {
            text = readTextFile(entry.path);
        } catch (e) {
            return null;
        }
        this.store(entry.path, entry.stamp, text);
        return text;
    }

    private store(path: string, stamp: string, text: string): void {
        this.forget(path);
        if (text.length > this.cacheUnits) return;
        this.texts.set(path, { stamp, text });
        this.cachedUnits += text.length;
        for (const [oldest, entry] of this.texts) {
            if (this.cachedUnits <= this.cacheUnits) break;
            this.texts.delete(oldest);
            this.cachedUnits -= entry.text.length;
        }
    }

    private forget(path: string): void {
        const entry = this.texts.get(path);
        if (!entry) return;
        this.texts.delete(path);
        this.cachedUnits -= entry.text.length;
    }

    // Read the contents of a warm snapshot into the cache, one file per step, while the cache has room.
    private *prefetcher(snap: Snapshot): Generator<void> {
        for (const entry of snap.entries) {
            if (this.cachedUnits + entry.size > this.cacheUnits) break;
            if (entry.size <= MAX_FILE_BYTES && this.texts.get(entry.path)?.stamp !== entry.stamp) {
                try { this.store(entry.path, entry.stamp, readTextFile(entry.path)); } catch (e) { /* read on request */ }
            }
            yield;
        }
        snap.prefetch = null;
    }

    // ---------- Background work ----------

    private schedule(): void {
        if (this.idle) return;
        const { monotonicMs, scheduler } = platform();
        this.idle = scheduler.idle(() => {
            const end = monotonicMs() + SLICE_MS;
            while (monotonicMs() < end) {
                // Walk first; read contents only once the walk (and with it the entries) is complete.
                const snap = [...this.snapshots.values()].find(s => s.scan) ?? [...this.snapshots.values()].find(s => s.prefetch && !s.dirty);
                if (!snap) { this.idle = null; return false; }
                if (snap.scan) { if (snap.scan.next().done) snap.scan = null; }
                else if (snap.prefetch!.next().done) snap.prefetch = null;
            }
            return true;
        });
    }
}

// Refresh the size and time of a listed file that still exists as a regular file. false = it is gone or changed type.
function restamp(entry: Entry): boolean {
    try {
        const info = platform().fs.info(entry.path);
        if (info.kind !== 'file') return false;
        entry.size = info.size;
        entry.stamp = info.stamp;
        return true;
    } catch (e) {
        return false;
    }
}

const normalize = (root: string): string => root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
