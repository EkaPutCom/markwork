// API key storage. Order: the DEEPSEEK_API_KEY environment variable, then the system keyring (libsecret),
// then the file ~/.config/markwork/deepseek.key (mode 0600) if the keyring is unavailable (e.g. a desktop without gnome-keyring).
// The key is never written to settings.json.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { readTextFile, writeTextFile, fileExists } from '../files.js';

export type KeySource = 'env' | 'keyring' | 'file';

export interface KeyStore {
    get(): Promise<{ key: string; source: KeySource } | null>;
    set(key: string): Promise<KeySource>;
    clear(): Promise<void>;
}

const ATTRIBUTES = { provider: 'deepseek' };
const keyFile = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'markwork', 'deepseek.key']);

// libsecret is loaded when needed; a missing typelib or a dead keyring service must not kill the app.
function removeKeyFile(): void {
    try { Gio.File.new_for_path(keyFile()).delete(null); } catch (e) { /* does not exist yet */ }
}

async function loadSecret() {
    try {
        const Secret = (await import('gi://Secret')).default;
        const schema = Secret.Schema.new('com.ekaput.markwork', Secret.SchemaFlags.NONE, { provider: Secret.SchemaAttributeType.STRING });
        return { Secret, schema };
    } catch (e) {
        return null;
    }
}

export const systemKeyStore: KeyStore = {
    async get() {
        const env = GLib.getenv('DEEPSEEK_API_KEY')?.trim();
        if (env) return { key: env, source: 'env' };
        const secret = await loadSecret();
        if (secret) {
            try {
                const key = secret.Secret.password_lookup_sync(secret.schema, ATTRIBUTES, null);
                if (key) return { key, source: 'keyring' };
            } catch (e) { /* continue to the file */ }
        }
        try {
            const key = fileExists(keyFile()) ? readTextFile(keyFile()).trim() : '';
            if (key) return { key, source: 'file' };
        } catch (e) { /* unreadable = does not exist yet */ }
        return null;
    },

    async set(key) {
        const secret = await loadSecret();
        if (secret) {
            try {
                if (secret.Secret.password_store_sync(secret.schema, ATTRIBUTES, secret.Secret.COLLECTION_DEFAULT, 'Markwork: DeepSeek API key', key, null)) {
                    removeKeyFile();
                    return 'keyring';
                }
            } catch (e) { /* keyring unavailable; use the file */ }
        }
        GLib.mkdir_with_parents(GLib.path_get_dirname(keyFile()), 0o700);
        writeTextFile(keyFile(), key);
        // Restrict access: only the owner may read it.
        Gio.File.new_for_path(keyFile()).set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        return 'file';
    },

    async clear() {
        const secret = await loadSecret();
        if (secret) {
            try { secret.Secret.password_clear_sync(secret.schema, ATTRIBUTES, null); } catch (e) { /* ignore */ }
        }
        removeKeyFile();
    },
};
