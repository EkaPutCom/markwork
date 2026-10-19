// The keyring where the OS has none for Node to reach (macOS, Windows). Electron's safeStorage encrypts with the user's
// keychain but only its main process can call it, while the core runs in a utility process. So the main process holds a
// SecretVault (encrypted values in a file) and the core's Secrets are a proxy that asks it over the process channel.
// Nothing here imports Electron: the cipher is handed in, so the same code runs in the core's tests.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Secrets } from '../index.js';

// What safeStorage offers: encrypt and decrypt a string with a key of the user's login keychain.
export interface Cipher {
    available(): boolean;
    encrypt(text: string): Uint8Array;
    decrypt(data: Uint8Array): string;
}

// What an item is called in the file: the schema and its attributes in a fixed order.
const itemKey = (schema: string, attributes: Record<string, string>) =>
    JSON.stringify([schema, Object.entries(attributes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);

// The main process's side: items encrypted one by one, in a JSON file only the user can read.
export class SecretVault {
    constructor(private readonly path: string, private readonly cipher: Cipher) {}

    private read(): Record<string, string> {
        try {
            const data: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
            return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, string> : {};
        } catch {
            return {};
        }
    }

    private write(items: Record<string, string>): void {
        mkdirSync(dirname(this.path), { recursive: true });
        const temp = `${this.path}.tmp`;
        writeFileSync(temp, JSON.stringify(items), { mode: 0o600 });
        renameSync(temp, this.path);
        try { chmodSync(this.path, 0o600); } catch { /* a file system without modes */ }
    }

    lookup(schema: string, attributes: Record<string, string>): string | null {
        if (!this.cipher.available()) return null;
        const stored = this.read()[itemKey(schema, attributes)];
        if (stored === undefined) return null;
        try {
            return this.cipher.decrypt(Buffer.from(stored, 'base64'));
        } catch {
            return null;   // sealed by another user or machine: as good as absent
        }
    }

    store(schema: string, attributes: Record<string, string>, secret: string): boolean {
        if (!this.cipher.available()) return false;
        try {
            const items = this.read();
            items[itemKey(schema, attributes)] = Buffer.from(this.cipher.encrypt(secret)).toString('base64');
            this.write(items);
            return true;
        } catch {
            return false;
        }
    }

    clear(schema: string, attributes: Record<string, string>): void {
        const items = this.read();
        const key = itemKey(schema, attributes);
        if (!(key in items)) return;
        delete items[key];
        try { this.write(items); } catch { /* the item stays; nothing more can be done */ }
    }
}

// A request from the core to the vault and the vault's answer, one object per post on the process channel.
export type SecretRequest =
    | { id: number; op: 'lookup' | 'clear'; schema: string; attributes: Record<string, string> }
    | { id: number; op: 'store'; schema: string; attributes: Record<string, string>; secret: string };
export interface SecretReply { id: number; value: string | null; ok: boolean }

// The main process answers a request from the vault. Anything that is not a well-formed request gets no answer.
export function answerSecret(vault: SecretVault, request: unknown): SecretReply | null {
    if (!request || typeof request !== 'object') return null;
    const r = request as Partial<SecretRequest>;
    if (typeof r.id !== 'number' || typeof r.schema !== 'string' || !r.attributes || typeof r.attributes !== 'object') return null;
    const attributes = r.attributes;
    if (!Object.values(attributes).every(v => typeof v === 'string')) return null;
    if (r.op === 'lookup') {
        const value = vault.lookup(r.schema, attributes);
        return { id: r.id, value, ok: value !== null };
    }
    if (r.op === 'store' && typeof (r as { secret?: unknown }).secret === 'string') {
        return { id: r.id, value: null, ok: vault.store(r.schema, attributes, (r as { secret: string }).secret) };
    }
    if (r.op === 'clear') {
        vault.clear(r.schema, attributes);
        return { id: r.id, value: null, ok: true };
    }
    return null;
}

// The core's side: Secrets that ask the main process. `send` posts a request; `receive` takes the answers. An answer
// that never comes (the main process is gone) ends as the contract's "no keyring" after the timeout.
export function remoteSecrets(send: (request: SecretRequest) => void, timeoutMs = 10000): { secrets: Secrets; receive(reply: SecretReply): void } {
    let next = 0;
    const waiting = new Map<number, (reply: SecretReply) => void>();
    const ask = (build: (id: number) => SecretRequest): Promise<SecretReply> => new Promise(resolve => {
        const id = ++next;
        const timer = setTimeout(() => { waiting.delete(id); resolve({ id, value: null, ok: false }); }, timeoutMs);
        waiting.set(id, reply => { clearTimeout(timer); resolve(reply); });
        send(build(id));
    });
    return {
        secrets: {
            lookup: async (schema, attributes) => (await ask(id => ({ id, op: 'lookup', schema, attributes }))).value,
            store: async (schema, attributes, _label, secret) => (await ask(id => ({ id, op: 'store', schema, attributes, secret }))).ok,
            clear: async (schema, attributes) => { await ask(id => ({ id, op: 'clear', schema, attributes })); },
        },
        receive(reply) {
            const done = waiting.get(reply.id);
            waiting.delete(reply.id);
            done?.(reply);
        },
    };
}
