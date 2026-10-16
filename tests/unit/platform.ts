// The platform port: the credential order (environment, keyring, file) against a fake platform, so no keyring or real
// config folder is touched, and the runtime-free base64 that builds the git credential header.

import GLib from 'gi://GLib';
import { clearCredential, readCredential, saveCredential, type Credential } from '../../src/credentials.js';
import { base64 } from '../../src/forge/contribute.js';
import { platform, setPlatform, type Platform } from '../../src/platform/index.js';
import { section, test, eq, ok, settle } from '../framework.js';

const CREDENTIAL: Credential = { envVar: 'TEST_KEY', schema: 'com.example.test', attributes: { provider: 'x' }, label: 'Test key', file: 'test.key' };

// A platform with an in-memory disk, environment, and keyring; keyring = false behaves like a desktop without one.
function fakePlatform(options: { env?: Record<string, string>; keyring?: boolean } = {}) {
    const files = new Map<string, string>();
    const modes = new Map<string, number>();
    const ring = new Map<string, string>();
    const key = (schema: string, attributes: Record<string, string>) => `${schema}|${JSON.stringify(attributes)}`;
    const fake: Platform = {
        fs: {
            readText: path => { const text = files.get(path); if (text === undefined) throw new Error(`no ${path}`); return text; },
            writeText: (path, text) => { files.set(path, text); },
            exists: path => files.has(path),
            remove: path => { if (!files.delete(path)) throw new Error(`no ${path}`); },
            makeDirs: () => {},
            setMode: (path, mode) => { modes.set(path, mode); },
        },
        paths: {
            join: (...parts) => parts.join('/'),
            dirname: path => path.slice(0, path.lastIndexOf('/')),
            isAbsolute: path => path.startsWith('/'),
            configDir: () => '/config',
        },
        secrets: {
            lookup: async (schema, attributes) => options.keyring === false ? null : ring.get(key(schema, attributes)) ?? null,
            store: async (schema, attributes, _label, secret) => { if (options.keyring === false) return false; ring.set(key(schema, attributes), secret); return true; },
            clear: async (schema, attributes) => { ring.delete(key(schema, attributes)); },
        },
        http: async () => ({ status: 200, body: '' }),
        env: name => options.env?.[name] ?? null,
    };
    return { fake, files, modes, ring };
}

// Runs fn with a fake platform installed, then puts the real one back.
function withPlatform(fake: Platform, fn: () => void): void {
    const real = platform();
    setPlatform(fake);
    try { fn(); } finally { setPlatform(real); }
}

export function platformTests(): void {
    section('Platform: credentials');

    test('the environment wins over the keyring and the file', () => {
        const { fake, ring, files } = fakePlatform({ env: { TEST_KEY: '  from-env \n' } });
        ring.set('com.example.test|{"provider":"x"}', 'from-ring');
        files.set('/config/markwork/test.key', 'from-file');
        withPlatform(fake, () => eq(settle(readCredential(CREDENTIAL)), { value: 'from-env', source: 'env' }));
    });

    test('saving goes to the keyring and removes an older fallback file', () => {
        const { fake, ring, files } = fakePlatform();
        files.set('/config/markwork/test.key', 'old');
        withPlatform(fake, () => {
            eq(settle(saveCredential(CREDENTIAL, 'sekret')), 'keyring');
            eq(ring.get('com.example.test|{"provider":"x"}'), 'sekret');
            ok(!files.has('/config/markwork/test.key'), 'fallback file removed');
            eq(settle(readCredential(CREDENTIAL)), { value: 'sekret', source: 'keyring' });
        });
    });

    test('without a keyring the secret goes to a file only its owner can read', () => {
        const { fake, files, modes } = fakePlatform({ keyring: false });
        withPlatform(fake, () => {
            eq(settle(saveCredential(CREDENTIAL, 'sekret')), 'file');
            eq(files.get('/config/markwork/test.key'), 'sekret');
            eq(modes.get('/config/markwork/test.key'), 0o600);
            eq(settle(readCredential(CREDENTIAL)), { value: 'sekret', source: 'file' });
        });
    });

    test('clearing removes it from the keyring and the file, and a missing one reads as null', () => {
        const { fake, ring, files } = fakePlatform();
        ring.set('com.example.test|{"provider":"x"}', 'a');
        files.set('/config/markwork/test.key', 'b');
        withPlatform(fake, () => {
            settle(clearCredential(CREDENTIAL));
            eq(ring.size + files.size, 0);
            eq(settle(readCredential(CREDENTIAL)), null);
            settle(clearCredential(CREDENTIAL));   // nothing left to clear is not an error
        });
    });

    section('Platform: base64');

    test('matches GLib for every padding length', () => {
        for (const text of ['', 'e', 'ek', 'eka', 'eka:', 'eka:s', 'eka:sekret', 'ünïcödé:✓']) {
            const bytes = new TextEncoder().encode(text);
            eq(base64(bytes), GLib.base64_encode(bytes), JSON.stringify(text));
        }
    });
}
