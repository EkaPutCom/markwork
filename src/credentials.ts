// A secret the app needs (the model API key, a forge token) and where it lives. Order: an environment variable, then the
// system keyring, then a file in ~/.config/markwork (mode 0600) when the keyring is unavailable (e.g. a desktop without
// gnome-keyring). A secret is never written to settings.json.

import { platform } from './platform/index.js';

export type CredentialSource = 'env' | 'keyring' | 'file';

export interface Credential {
    envVar: string;
    schema: string;                         // the keyring schema name
    attributes: Record<string, string>;     // what identifies this secret in the keyring
    label: string;                          // shown by keyring managers such as Seahorse
    file: string;                           // the fallback file name in ~/.config/markwork
}

const filePath = (credential: Credential) => platform().paths.join(platform().paths.configDir(), 'markwork', credential.file);

function removeFile(credential: Credential): void {
    try { platform().fs.remove(filePath(credential)); } catch (e) { /* does not exist yet */ }
}

export async function readCredential(credential: Credential): Promise<{ value: string; source: CredentialSource } | null> {
    const { env, secrets, fs } = platform();
    const fromEnv = env(credential.envVar)?.trim();
    if (fromEnv) return { value: fromEnv, source: 'env' };
    const fromKeyring = await secrets.lookup(credential.schema, credential.attributes);
    if (fromKeyring) return { value: fromKeyring, source: 'keyring' };
    try {
        const path = filePath(credential);
        const fromFile = fs.exists(path) ? fs.readText(path).trim() : '';
        if (fromFile) return { value: fromFile, source: 'file' };
    } catch (e) { /* unreadable = does not exist yet */ }
    return null;
}

export async function saveCredential(credential: Credential, value: string): Promise<CredentialSource> {
    const { secrets, fs, paths } = platform();
    if (await secrets.store(credential.schema, credential.attributes, credential.label, value)) {
        removeFile(credential);
        return 'keyring';
    }
    const path = filePath(credential);
    fs.makeDirs(paths.dirname(path), 0o700);
    fs.writeText(path, value);
    // Restrict access: only the owner may read it.
    fs.setMode(path, 0o600);
    return 'file';
}

export async function clearCredential(credential: Credential): Promise<void> {
    await platform().secrets.clear(credential.schema, credential.attributes);
    removeFile(credential);
}
