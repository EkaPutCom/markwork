// Files and folders on GJS: GLib for whole-file reads and atomic writes, Gio for background writes, listings, lookups,
// and folder monitors. Raw: the queueing per path and the app's change notices are in files.ts.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { EntryInfo, EntryKind, FileSystem } from '../index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Background writes report back on their own main context, not the default one. Waiting for them (pumpWrites(true))
// then runs only their completions, never other application callbacks such as timers or input.
const ioContext = new GLib.MainContext();

function pumpWrites(wait: boolean): void {
    ioContext.push_thread_default();
    try {
        if (wait) ioContext.iteration(true);
        while (ioContext.iteration(false)) { /* run all ready completions */ }
    } finally {
        ioContext.pop_thread_default();
    }
}

// Gio writes to a temporary file, fsyncs, then atomically replaces the target file in a worker thread, so the fsync
// pause (tens of milliseconds on a slow disk) is not felt on the main thread.
function startWrite(path: string, text: string, done: (error: unknown) => void): void {
    ioContext.push_thread_default();
    try {
        Gio.File.new_for_path(path).replace_contents_bytes_async(new GLib.Bytes(enc.encode(text)), null, false,
            Gio.FileCreateFlags.NONE, null, (file, result) => {
                try {
                    file!.replace_contents_finish(result);
                    done(null);
                } catch (e) {
                    done(e);
                }
            });
    } catch (e) {
        done(e);
    } finally {
        ioContext.pop_thread_default();
    }
}

const ATTRIBUTES = 'standard::name,standard::type,standard::is-symlink,standard::size,time::modified,time::modified-usec';

function kindOf(info: Gio.FileInfo): EntryKind {
    if (info.get_is_symlink()) return 'symlink';
    const type = info.get_file_type();
    return type === Gio.FileType.REGULAR ? 'file' : type === Gio.FileType.DIRECTORY ? 'directory' : 'other';
}

const entryOf = (info: Gio.FileInfo): EntryInfo => ({
    name: info.get_name(),
    kind: kindOf(info),
    size: info.get_size(),
    stamp: `${info.get_size()}:${info.get_modification_date_time()?.to_unix() ?? 0}:${info.get_attribute_uint32('time::modified-usec')}`,
});

function listInfo(dir: string): EntryInfo[] {
    const enumerator = Gio.File.new_for_path(dir).enumerate_children(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    const entries: EntryInfo[] = [];
    try {
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) entries.push(entryOf(info));
    } finally {
        enumerator.close(null);
    }
    return entries;
}

function kind(path: string): EntryKind {
    try {
        return kindOf(Gio.File.new_for_path(path).query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null));
    } catch (e) {
        if (e instanceof GLib.Error && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) return 'missing';
        throw e;
    }
}

function watchDir(dir: string, onChange: (path: string) => void): () => void {
    const monitor = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
    monitor.connect('changed', (_m, file, other) => {
        onChange(file.get_path() ?? dir);
        const moved = other?.get_path();
        if (moved) onChange(moved);
    });
    return () => monitor.cancel();
}

export const gjsFiles: FileSystem = {
    readText: path => dec.decode(GLib.file_get_contents(path)[1]),
    writeText: (path, text) => { GLib.file_set_contents(path, enc.encode(text)); },
    append: (path, text) => {
        const stream = Gio.File.new_for_path(path).append_to(Gio.FileCreateFlags.NONE, null);
        try { stream.write_all(enc.encode(text), null); } finally { stream.close(null); }
    },
    startWrite,
    pumpWrites,
    exists: path => GLib.file_test(path, GLib.FileTest.EXISTS),
    remove: path => { Gio.File.new_for_path(path).delete(null); },
    makeDirs: (path, mode) => { GLib.mkdir_with_parents(path, mode); },
    setMode: (path, mode) => { Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', mode, Gio.FileQueryInfoFlags.NONE, null); },
    list: dir => listInfo(dir).map(e => e.name),
    kind,
    isDirectory: path => GLib.file_test(path, GLib.FileTest.IS_DIR),
    trash: path => { Gio.File.new_for_path(path).trash(null); },
    move: (from, to) => { Gio.File.new_for_path(from).move(Gio.File.new_for_path(to), Gio.FileCopyFlags.NONE, null, null); },
    info: path => entryOf(Gio.File.new_for_path(path).query_info(ATTRIBUTES, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)),
    listInfo,
    watchDir,
};
