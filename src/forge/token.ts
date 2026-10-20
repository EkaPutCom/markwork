// Access token of a forge, one per host: the MARKWORK_FORGE_TOKEN environment variable, then the system keyring, then the
// file ~/.config/markwork/forge-<host>.token (see base/credentials.ts for the order and the file's access mode). Same approach as
// agent/apikey.ts.

import { clearCredential, readCredential, saveCredential, type Credential, type CredentialSource } from '../base/credentials.js';

export type TokenSource = CredentialSource;

export interface TokenStore {
    get(host: string): Promise<{ token: string; source: TokenSource } | null>;
    set(host: string, token: string): Promise<TokenSource>;
    clear(host: string): Promise<void>;
}

const forgeToken = (host: string): Credential => ({
    envVar: 'MARKWORK_FORGE_TOKEN',
    schema: 'com.ekaput.markwork.forge',
    attributes: { host },
    label: `Markwork: access token for ${host}`,
    file: `forge-${host.replace(/[^A-Za-z0-9.-]/g, '_')}.token`,
});

export const systemTokenStore: TokenStore = {
    async get(host) {
        const found = await readCredential(forgeToken(host));
        return found && { token: found.value, source: found.source };
    },
    set: (host, token) => saveCredential(forgeToken(host), token),
    clear: host => clearCredential(forgeToken(host)),
};
