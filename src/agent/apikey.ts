// API key storage: the DEEPSEEK_API_KEY environment variable, then the system keyring, then the file
// ~/.config/markwork/deepseek.key (see base/credentials.ts for the order and the file's access mode).

import { clearCredential, readCredential, saveCredential, type Credential, type CredentialSource } from '../base/credentials.js';

export type KeySource = CredentialSource;

export interface KeyStore {
    get(): Promise<{ key: string; source: KeySource } | null>;
    set(key: string): Promise<KeySource>;
    clear(): Promise<void>;
}

const DEEPSEEK: Credential = {
    envVar: 'DEEPSEEK_API_KEY',
    schema: 'com.ekaput.markwork',
    attributes: { provider: 'deepseek' },
    label: 'Markwork: DeepSeek API key',
    file: 'deepseek.key',
};

export const systemKeyStore: KeyStore = {
    async get() {
        const found = await readCredential(DEEPSEEK);
        return found && { key: found.value, source: found.source };
    },
    set: key => saveCredential(DEEPSEEK, key),
    clear: () => clearCredential(DEEPSEEK),
};
