// The platform port on GJS: GLib/Gio for files, paths, processes, idle work, and daemon links, libsecret for the keyring, libsoup 3 for HTTP. The only place
// outside the base modules where the core's runtime needs meet gi://.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { Platform, Scheduler, Secrets } from '../index.js';
import { gjsFiles } from './files.js';
import { gettextTranslations } from './i18n.js';
import { soupStreamTransport, soupTransport } from './http.js';
import { gjsLinks } from './links.js';
import { gjsProcesses } from './process.js';

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

// Idle sources run after drawing and input (GLib.PRIORITY_DEFAULT_IDLE), so background work never delays a frame.
const scheduler: Scheduler = {
    idle(fn) {
        let id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (fn()) return GLib.SOURCE_CONTINUE;
            id = 0;
            return GLib.SOURCE_REMOVE;
        });
        return () => { if (id) { GLib.source_remove(id); id = 0; } };
    },
    idleAfter(ms, fn) {
        let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, ms, () => { id = 0; fn(); return GLib.SOURCE_REMOVE; });
        return () => { if (id) { GLib.source_remove(id); id = 0; } };
    },
};

export const gjsPlatform: Platform = {
    fs: gjsFiles,
    paths: {
        join: (...parts) => GLib.build_filenamev(parts),
        dirname: path => GLib.path_get_dirname(path),
        resolve: path => Gio.File.new_for_path(path).get_path() ?? path,
        relative: (dir, path) => Gio.File.new_for_path(dir).get_relative_path(Gio.File.new_for_path(path)),
        basename: path => GLib.path_get_basename(path),
        isAbsolute: path => GLib.path_is_absolute(path),
        configDir: () => GLib.get_user_config_dir(),
        homeDir: () => GLib.get_home_dir(),
        runtimeDir: () => GLib.get_user_runtime_dir(),
    },
    secrets,
    http: soupTransport,
    httpStream: soupStreamTransport,
    processes: gjsProcesses,
    scheduler,
    links: gjsLinks,
    translations: gettextTranslations,
    env: name => GLib.getenv(name),
    realName: () => { const name = GLib.get_real_name(); return name && name !== 'Unknown' ? name : null; },
    monotonicMs: () => GLib.get_monotonic_time() / 1000,
};
