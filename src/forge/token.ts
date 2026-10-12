// Access token of a forge, one per host. Order: the MARKWORK_FORGE_TOKEN environment variable, then the system keyring (libsecret),
// then a file ~/.config/markwork/forge-<host>.token (mode 0600) when the keyring is unavailable. Same approach as agent/apikey.ts.
// The token is never written to settings.json.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { fileExists, readTextFile, writeTextFile } from '../files.js';

export type TokenSource = 'env' | 'keyring' | 'file';

export interface TokenStore {
    get(host: string): Promise<{ token: string; source: TokenSource } | null>;
    set(host: string, token: string): Promise<TokenSource>;
    clear(host: string): Promise<void>;
}

const tokenFile = (host: string) => GLib.build_filenamev([GLib.get_user_config_dir(), 'markwork', `forge-${host.replace(/[^A-Za-z0-9.-]/g, '_')}.token`]);

function removeTokenFile(host: string): void {
    try { Gio.File.new_for_path(tokenFile(host)).delete(null); } catch (e) { /* does not exist yet */ }
}

// libsecret is loaded when needed; a missing typelib or a dead keyring service must not kill the app.
async function loadSecret() {
    try {
        const Secret = (await import('gi://Secret')).default;
        const schema = Secret.Schema.new('com.ekaput.markwork.forge', Secret.SchemaFlags.NONE, { host: Secret.SchemaAttributeType.STRING });
        return { Secret, schema };
    } catch (e) {
        return null;
    }
}

export const systemTokenStore: TokenStore = {
    async get(host) {
        const env = GLib.getenv('MARKWORK_FORGE_TOKEN')?.trim();
        if (env) return { token: env, source: 'env' };
        const secret = await loadSecret();
        if (secret) {
            try {
                const token = secret.Secret.password_lookup_sync(secret.schema, { host }, null);
                if (token) return { token, source: 'keyring' };
            } catch (e) { /* continue to the file */ }
        }
        try {
            const token = fileExists(tokenFile(host)) ? readTextFile(tokenFile(host)).trim() : '';
            if (token) return { token, source: 'file' };
        } catch (e) { /* unreadable = does not exist yet */ }
        return null;
    },

    async set(host, token) {
        const secret = await loadSecret();
        if (secret) {
            try {
                if (secret.Secret.password_store_sync(secret.schema, { host }, secret.Secret.COLLECTION_DEFAULT, `Markwork: access token for ${host}`, token, null)) {
                    removeTokenFile(host);
                    return 'keyring';
                }
            } catch (e) { /* keyring unavailable; use the file */ }
        }
        GLib.mkdir_with_parents(GLib.path_get_dirname(tokenFile(host)), 0o700);
        writeTextFile(tokenFile(host), token);
        // Restrict access: only the owner may read it.
        Gio.File.new_for_path(tokenFile(host)).set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        return 'file';
    },

    async clear(host) {
        const secret = await loadSecret();
        if (secret) {
            try { secret.Secret.password_clear_sync(secret.schema, { host }, null); } catch (e) { /* ignore */ }
        }
        removeTokenFile(host);
    },
};
