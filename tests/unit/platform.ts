// The platform port: the credential order (environment, keyring, file) against a fake platform, so no keyring or real
// config folder is touched, and the runtime-free base64 that builds the git credential header.

import GLib from 'gi://GLib';
import { clearCredential, readCredential, saveCredential, type Credential } from '../../src/credentials.js';
import { Cancellable } from '../../src/cancel.js';
import { base64 } from '../../src/forge/contribute.js';
import { gjsPlatform } from '../../src/platform/gjs/index.js';
import { platform, setPlatform, type Platform } from '../../src/platform/index.js';
import { section, test, eq, ok, settle, tmp } from '../framework.js';

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
            list: () => [],
            kind: path => files.has(path) ? 'file' : 'missing',
            isDirectory: () => false,
            trash: path => { files.delete(path); },
        },
        paths: {
            join: (...parts) => parts.join('/'),
            dirname: path => path.slice(0, path.lastIndexOf('/')),
            basename: path => path.slice(path.lastIndexOf('/') + 1),
            isAbsolute: path => path.startsWith('/'),
            configDir: () => '/config',
            runtimeDir: () => '/run',
        },
        secrets: {
            lookup: async (schema, attributes) => options.keyring === false ? null : ring.get(key(schema, attributes)) ?? null,
            store: async (schema, attributes, _label, secret) => { if (options.keyring === false) return false; ring.set(key(schema, attributes), secret); return true; },
            clear: async (schema, attributes) => { ring.delete(key(schema, attributes)); },
        },
        http: async () => ({ status: 200, body: '' }),
        httpStream: async () => { throw new Error('no network in this fake'); },
        processes: { run: async () => null, spawn: () => { throw new Error('no processes in this fake'); }, findProgram: () => null, hostName: () => 'fake' },
        env: name => options.env?.[name] ?? null,
        monotonicMs: () => 0,
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

    section('Platform: cancelling');

    test('cancel runs each listener once, in order, and later cancels do nothing', () => {
        const c = new Cancellable();
        const seen: string[] = [];
        c.onCancel(() => seen.push('a'));
        c.onCancel(() => seen.push('b'));
        ok(!c.cancelled, 'not cancelled yet');
        c.cancel();
        c.cancel();
        eq(seen, ['a', 'b']);
        ok(c.cancelled, 'cancelled');
    });

    test('a listener added after cancelling runs at once; a removed one never runs', () => {
        const c = new Cancellable();
        const seen: string[] = [];
        const off = c.onCancel(() => seen.push('removed'));
        off();
        let selfOff = () => {};
        selfOff = c.onCancel(() => { seen.push('self'); selfOff(); });   // removing itself from inside is safe
        c.cancel();
        c.onCancel(() => seen.push('late'));
        eq(seen, ['self', 'late']);
    });

    section('Platform: GJS file system');

    test('kind tells files, folders, symbolic links, and missing paths apart without following links', () => {
        const { fs, paths } = gjsPlatform;
        const dir = paths.join(tmp, 'platform-kind');
        fs.makeDirs(paths.join(dir, 'sub'), 0o755);
        fs.writeText(paths.join(dir, 'a.md'), 'a');
        GLib.spawn_command_line_sync(`ln -sfn ${GLib.shell_quote(paths.join(dir, 'sub'))} ${GLib.shell_quote(paths.join(dir, 'link'))}`);
        eq(fs.kind(paths.join(dir, 'a.md')), 'file');
        eq(fs.kind(paths.join(dir, 'sub')), 'directory');
        eq(fs.kind(paths.join(dir, 'link')), 'symlink');
        eq(fs.kind(paths.join(dir, 'nope')), 'missing');
        eq(fs.list(dir).sort(), ['a.md', 'link', 'sub']);
        let threw = false;
        try { fs.list(paths.join(dir, 'nope')); } catch (e) { threw = true; }
        ok(threw, 'listing a missing folder throws');
    });

    section('Platform: GJS processes');

    test('run collects the output, the exit status, and the extra environment; a missing program gives null', () => {
        const { processes } = gjsPlatform;
        const r = settle(processes.run({ argv: ['sh', '-c', 'echo "$GREETING"; echo oops >&2; exit 3'], cwd: tmp, env: { GREETING: 'hello' } }));
        eq(r, { status: 3, out: 'hello\n', err: 'oops\n' });
        eq(settle(processes.run({ argv: ['markwork-no-such-program'], cwd: tmp })), null);
    });

    test('spawn speaks line by line: stdin in, stdout lines out, the exit status after both outputs are drained', () => {
        const lines: string[] = [];
        const ended = new Promise<[number, string]>(resolve => {
            const child = gjsPlatform.processes.spawn([gjsPlatform.processes.findProgram('sh')!, '-c', 'while read -r l; do echo "got $l"; done; echo bye >&2; exit 4'], tmp, {
                line: text => lines.push(text),
                exit: (status, stderr) => resolve([status, stderr]),
            });
            ok(child.write('one') && child.write('two'), 'writes accepted');
            child.closeInput();
            ok(!child.write('late'), 'no writes after stdin is closed');
        });
        eq(settle(ended), [4, 'bye\n']);
        eq(lines, ['got one', 'got two']);
    });

    test('stop ends a child that does not end by itself', () => {
        const ended = new Promise<number>(resolve => {
            const child = gjsPlatform.processes.spawn([gjsPlatform.processes.findProgram('sleep')!, '30'], tmp, { line: () => {}, exit: status => resolve(status) });
            child.stop();
        });
        eq(settle(ended), 128 + 15);   // SIGTERM
    });

    test('findProgram finds a program on PATH and not one that does not exist', () => {
        ok(gjsPlatform.processes.findProgram('sh')?.endsWith('/sh'), 'sh not found');
        eq(gjsPlatform.processes.findProgram('markwork-no-such-program'), null);
    });

    section('Platform: base64');

    test('matches GLib for every padding length', () => {
        for (const text of ['', 'e', 'ek', 'eka', 'eka:', 'eka:s', 'eka:sekret', 'ünïcödé:✓']) {
            const bytes = new TextEncoder().encode(text);
            eq(base64(bytes), GLib.base64_encode(bytes), JSON.stringify(text));
        }
    });
}
