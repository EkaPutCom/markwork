// The platform port on GJS: GLib/Gio for files and paths, libsecret for the keyring, libsoup 3 for HTTP. The only place
// outside the base modules where the core's runtime needs meet gi://.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { fileExists, readTextFile, writeTextFile } from '../../files.js';
import type { Platform, Secrets } from '../index.js';
import { soupTransport } from './http.js';

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

export const gjsPlatform: Platform = {
    fs: {
        readText: readTextFile,
        writeText: writeTextFile,
        exists: fileExists,
        remove: path => { Gio.File.new_for_path(path).delete(null); },
        makeDirs: (path, mode) => { GLib.mkdir_with_parents(path, mode); },
        setMode: (path, mode) => { Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', mode, Gio.FileQueryInfoFlags.NONE, null); },
    },
    paths: {
        join: (...parts) => GLib.build_filenamev(parts),
        dirname: path => GLib.path_get_dirname(path),
        isAbsolute: path => GLib.path_is_absolute(path),
        configDir: () => GLib.get_user_config_dir(),
    },
    secrets,
    http: soupTransport,
    env: name => GLib.getenv(name),
};
