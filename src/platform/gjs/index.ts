// The platform port on GJS: GLib/Gio for files and paths, libsecret for the keyring, libsoup 3 for HTTP. The only place
// outside the base modules where the core's runtime needs meet gi://.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { fileExists, readTextFile, writeTextFile } from '../../files.js';
import { trashEntry } from '../../fileops.js';
import type { EntryKind, FileSystem, Platform, Secrets } from '../index.js';
import { soupStreamTransport, soupTransport } from './http.js';

// libsecret is loaded when needed; a missing typelib or a dead keyring service must not kill the app.
async function loadSecret() {
    try {
        return (await import('gi://Secret')).default;
    } catch (e) {
        return null;
    }
}

type Secret = NonNullable<Awaited<ReturnType<typeof loadSecret>>>;

const schemaOf = (Secret: Secret, name: string, attributes: Record<string, string>) =>
    Secret.Schema.new(name, Secret.SchemaFlags.NONE, Object.fromEntries(Object.keys(attributes).map(key => [key, Secret.SchemaAttributeType.STRING])));

const secrets: Secrets = {
    async lookup(schema, attributes) {
        const Secret = await loadSecret();
        if (!Secret) return null;
        try {
            return Secret.password_lookup_sync(schemaOf(Secret, schema, attributes), attributes, null) || null;
        } catch (e) {
            return null;
        }
    },

    async store(schema, attributes, label, secret) {
        const Secret = await loadSecret();
        if (!Secret) return false;
        try {
            return Secret.password_store_sync(schemaOf(Secret, schema, attributes), attributes, Secret.COLLECTION_DEFAULT, label, secret, null);
        } catch (e) {
            return false;
        }
    },

    async clear(schema, attributes) {
        const Secret = await loadSecret();
        if (!Secret) return;
        try { Secret.password_clear_sync(schemaOf(Secret, schema, attributes), attributes, null); } catch (e) { /* ignore */ }
    },
};

function listDir(dir: string): string[] {
    const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    const names: string[] = [];
    try {
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) names.push(info.get_name());
    } finally {
        enumerator.close(null);
    }
    return names;
}

function entryKind(path: string): EntryKind {
    let info: Gio.FileInfo;
    try {
        info = Gio.File.new_for_path(path).query_info('standard::is-symlink,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (e) {
        if (e instanceof GLib.Error && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) return 'missing';
        throw e;
    }
    if (info.get_is_symlink()) return 'symlink';
    const type = info.get_file_type();
    return type === Gio.FileType.REGULAR ? 'file' : type === Gio.FileType.DIRECTORY ? 'directory' : 'other';
}

const fs: FileSystem = {
    readText: readTextFile,
    writeText: writeTextFile,
    exists: fileExists,
    remove: path => { Gio.File.new_for_path(path).delete(null); },
    makeDirs: (path, mode) => { GLib.mkdir_with_parents(path, mode); },
    setMode: (path, mode) => { Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', mode, Gio.FileQueryInfoFlags.NONE, null); },
    list: listDir,
    kind: entryKind,
    trash: trashEntry,
};

export const gjsPlatform: Platform = {
    fs,
    paths: {
        join: (...parts) => GLib.build_filenamev(parts),
        dirname: path => GLib.path_get_dirname(path),
        isAbsolute: path => GLib.path_is_absolute(path),
        configDir: () => GLib.get_user_config_dir(),
        runtimeDir: () => GLib.get_user_runtime_dir(),
    },
    secrets,
    http: soupTransport,
    httpStream: soupStreamTransport,
    env: name => GLib.getenv(name),
    monotonicMs: () => GLib.get_monotonic_time() / 1000,
};
