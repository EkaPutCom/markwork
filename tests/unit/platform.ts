// The platform port: the credential order (environment, keyring, file) against a fake platform, so no keyring or real
// config folder is touched; the contract of the installed platform (files, idle work, processes), so every
// implementation is held to the same behaviour; and the runtime-free base64 that builds the git credential header.

import { clearCredential, readCredential, saveCredential, type Credential } from '../../src/credentials.js';
import { Cancellable } from '../../src/cancel.js';
import { base64 } from '../../src/forge/contribute.js';
import { platform, setPlatform, type Platform } from '../../src/platform/index.js';
import { section, test, eq, ok, within, tmp } from '../framework.js';
import { host } from '../host.js';

const CREDENTIAL: Credential = { envVar: 'TEST_KEY', schema: 'com.example.test', attributes: { provider: 'x' }, label: 'Test key', file: 'test.key' };

// A platform with an in-memory disk, environment, and keyring; keyring = false behaves like a desktop without one.
function fakePlatform(options: { env?: Record<string, string>; keyring?: boolean } = {}) {
    const files = new Map<string, string>();
    const modes = new Map<string, number>();
    const ring = new Map<string, string>();
    const key = (schema: string, attributes: Record<string, string>) => `${schema}|${JSON.stringify(attributes)}`;
    const fake: Platform = {
        os: 'linux',
        fs: {
            readText: path => { const text = files.get(path); if (text === undefined) throw new Error(`no ${path}`); return text; },
            writeText: (path, text) => { files.set(path, text); },
            append: (path, text) => { files.set(path, (files.get(path) ?? '') + text); },
            exists: path => files.has(path),
            remove: path => { if (!files.delete(path)) throw new Error(`no ${path}`); },
            makeDirs: () => {},
            setMode: (path, mode) => { modes.set(path, mode); },
            list: () => [],
            kind: path => files.has(path) ? 'file' : 'missing',
            isDirectory: () => false,
            trash: path => { files.delete(path); },
            move: (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
            copy: (from, to) => { files.set(to, files.get(from)!); },
            startWrite: (path, text, done) => { files.set(path, text); done(null); },
            pumpWrites: () => {},
            info: path => { if (!files.has(path)) throw new Error(`no ${path}`); return { name: path.slice(path.lastIndexOf('/') + 1), kind: 'file', size: files.get(path)!.length, stamp: '' }; },
            listInfo: () => [],
            watchDir: () => () => {},
        },
        paths: {
            join: (...parts) => parts.join('/'),
            dirname: path => path.slice(0, path.lastIndexOf('/')),
            resolve: path => path,
            relative: (dir, path) => path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null,
            basename: path => path.slice(path.lastIndexOf('/') + 1),
            isAbsolute: path => path.startsWith('/'),
            same: (a, b) => a === b,
            configDir: () => '/config',
            homeDir: () => '/home/test',
            runtimeDir: () => '/run',
        },
        secrets: {
            lookup: async (schema, attributes) => options.keyring === false ? null : ring.get(key(schema, attributes)) ?? null,
            store: async (schema, attributes, _label, secret) => { if (options.keyring === false) return false; ring.set(key(schema, attributes), secret); return true; },
            clear: async (schema, attributes) => { ring.delete(key(schema, attributes)); },
        },
        http: async () => ({ status: 200, body: '' }),
        httpStream: async () => { throw new Error('no network in this fake'); },
        scheduler: { idle: () => () => {}, idleAfter: () => () => {} },
        translations: { text: t => t, plural: (one, many, n) => n === 1 ? one : many, context: (_c, t) => t },
        links: { socket: () => { throw new Error('no daemon in this fake'); }, command: () => { throw new Error('no daemon in this fake'); } },
        processes: { run: async () => null, spawn: () => { throw new Error('no processes in this fake'); }, findProgram: () => null, launch: () => false, openTerminal: () => false, hostName: () => 'fake' },
        env: name => options.env?.[name] ?? null,
        realName: () => null,
        monotonicMs: () => 0,
    };
    return { fake, files, modes, ring };
}

// Runs fn with a fake platform installed, then puts the real one back.
async function withPlatform(fake: Platform, fn: () => Promise<void>): Promise<void> {
    const real = platform();
    setPlatform(fake);
    try { await fn(); } finally { setPlatform(real); }
}

export async function platformTests(): Promise<void> {
    section('Platform: credentials');

    await test('the environment wins over the keyring and the file', async () => {
        const { fake, ring, files } = fakePlatform({ env: { TEST_KEY: '  from-env \n' } });
        ring.set('com.example.test|{"provider":"x"}', 'from-ring');
        files.set('/config/markwork/test.key', 'from-file');
        await withPlatform(fake, async () => eq(await within(readCredential(CREDENTIAL)), { value: 'from-env', source: 'env' }));
    });

    await test('saving goes to the keyring and removes an older fallback file', async () => {
        const { fake, ring, files } = fakePlatform();
        files.set('/config/markwork/test.key', 'old');
        await withPlatform(fake, async () => {
            eq(await within(saveCredential(CREDENTIAL, 'sekret')), 'keyring');
            eq(ring.get('com.example.test|{"provider":"x"}'), 'sekret');
            ok(!files.has('/config/markwork/test.key'), 'fallback file removed');
            eq(await within(readCredential(CREDENTIAL)), { value: 'sekret', source: 'keyring' });
        });
    });

    await test('without a keyring the secret goes to a file only its owner can read', async () => {
        const { fake, files, modes } = fakePlatform({ keyring: false });
        await withPlatform(fake, async () => {
            eq(await within(saveCredential(CREDENTIAL, 'sekret')), 'file');
            eq(files.get('/config/markwork/test.key'), 'sekret');
            eq(modes.get('/config/markwork/test.key'), 0o600);
            eq(await within(readCredential(CREDENTIAL)), { value: 'sekret', source: 'file' });
        });
    });

    await test('clearing removes it from the keyring and the file, and a missing one reads as null', async () => {
        const { fake, ring, files } = fakePlatform();
        ring.set('com.example.test|{"provider":"x"}', 'a');
        files.set('/config/markwork/test.key', 'b');
        await withPlatform(fake, async () => {
            await within(clearCredential(CREDENTIAL));
            eq(ring.size + files.size, 0);
            eq(await within(readCredential(CREDENTIAL)), null);
            await within(clearCredential(CREDENTIAL));   // nothing left to clear is not an error
        });
    });

    section('Platform: cancelling');

    await test('cancel runs each listener once, in order, and later cancels do nothing', async () => {
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

    await test('a listener added after cancelling runs at once; a removed one never runs', async () => {
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

    section(`Platform on ${host().runtime}: files`);
    const installed = platform();

    await test('kind tells files, folders, symbolic links, and missing paths apart without following links', async () => {
        const { fs, paths } = installed;
        const dir = paths.join(tmp, 'platform-kind');
        fs.makeDirs(paths.join(dir, 'sub'), 0o755);
        fs.writeText(paths.join(dir, 'a.md'), 'a');
        host().symlink(paths.join(dir, 'sub'), paths.join(dir, 'link'));
        eq(fs.kind(paths.join(dir, 'a.md')), 'file');
        eq(fs.kind(paths.join(dir, 'sub')), 'directory');
        eq(fs.kind(paths.join(dir, 'link')), 'symlink');
        eq(fs.kind(paths.join(dir, 'nope')), 'missing');
        eq(fs.list(dir).sort(), ['a.md', 'link', 'sub']);
        let threw = false;
        try { fs.list(paths.join(dir, 'nope')); } catch (e) { threw = true; }
        ok(threw, 'listing a missing folder throws');
    });

    await test('info and listInfo give kind, size, and a stamp that changes with the contents; watchDir reports a new file', async () => {
        const { fs, paths } = installed;
        const dir = paths.join(tmp, 'platform-info');
        fs.makeDirs(dir, 0o755);
        const file = paths.join(dir, 'a.md');
        fs.writeText(file, 'one');
        const before = fs.info(file);
        eq([before.name, before.kind, before.size], ['a.md', 'file', 3]);
        fs.writeText(file, 'three');
        ok(fs.info(file).stamp !== before.stamp, 'stamp did not change');
        eq(fs.listInfo(dir).map(e => [e.name, e.kind]), [['a.md', 'file']]);
        let threw = false;
        try { fs.info(paths.join(dir, 'nope')); } catch (e) { threw = true; }
        ok(threw, 'info of a missing path throws');
        const seen = new Promise<string>(resolve => {
            const stop = fs.watchDir(dir, path => { if (path.endsWith('b.md')) { stop(); resolve(path); } });
            setTimeout(() => fs.writeText(paths.join(dir, 'b.md'), 'new'), 50);
        });
        eq(await within(seen), paths.join(dir, 'b.md'));
    });

    await test('copy takes a folder with its files and links as they are, and refuses a target that exists', async () => {
        const { fs, paths } = installed;
        const dir = paths.join(tmp, 'platform-copy');
        fs.makeDirs(paths.join(dir, 'from', 'sub'), 0o755);
        fs.writeText(paths.join(dir, 'from', 'a.md'), 'a');
        fs.writeText(paths.join(dir, 'from', 'sub', 'b.md'), 'b');
        host().symlink('a.md', paths.join(dir, 'from', 'link.md'));
        fs.copy(paths.join(dir, 'from'), paths.join(dir, 'to'));
        eq(fs.list(paths.join(dir, 'to')).sort(), ['a.md', 'link.md', 'sub']);
        eq(fs.readText(paths.join(dir, 'to', 'sub', 'b.md')), 'b');
        eq(fs.kind(paths.join(dir, 'to', 'link.md')), 'symlink', 'a link stays a link');
        fs.copy(paths.join(dir, 'from', 'a.md'), paths.join(dir, 'single.md'));
        eq(fs.readText(paths.join(dir, 'single.md')), 'a');
        let threw = false;
        try { fs.copy(paths.join(dir, 'from', 'a.md'), paths.join(dir, 'single.md')); } catch { threw = true; }
        ok(threw, 'copying onto something that exists throws');
    });

    await test('background writes finish through pumpWrites, in order, and report their errors', async () => {
        const { fs, paths } = installed;
        const file = paths.join(tmp, 'platform-bg.md');
        const results: unknown[] = [];
        fs.startWrite(file, 'first', e => results.push(e));
        fs.startWrite(paths.join(tmp, 'no-such-folder', 'x.md'), 'x', e => results.push(e ? 'error' : e));
        while (results.length < 2) fs.pumpWrites(true);
        ok(results.includes(null) && results.includes('error'), JSON.stringify(results));
        eq(fs.readText(file), 'first');
    });

    await test('idle work runs until it says stop, and a cancelled one never runs', async () => {
        const { scheduler } = installed;
        let runs = 0, cancelledRan = false;
        const done = new Promise<void>(resolve => scheduler.idle(() => { runs++; if (runs < 3) return true; resolve(); return false; }));
        scheduler.idleAfter(10, () => { cancelledRan = true; })();
        await within(done);
        await within(new Promise<void>(resolve => scheduler.idleAfter(30, resolve)));
        eq([runs, cancelledRan], [3, false]);
    });

    section(`Platform on ${host().runtime}: processes`);

    await test('run collects the output, the exit status, and the extra environment; a missing program gives null', async () => {
        const { processes } = installed;
        const r = await within(processes.run({ argv: ['sh', '-c', 'echo "$GREETING"; echo oops >&2; exit 3'], cwd: tmp, env: { GREETING: 'hello' } }));
        eq(r, { status: 3, out: 'hello\n', err: 'oops\n' });
        eq(await within(processes.run({ argv: ['markwork-no-such-program'], cwd: tmp })), null);
    });

    await test('spawn speaks line by line: stdin in, stdout lines out, the exit status after both outputs are drained', async () => {
        const lines: string[] = [];
        const ended = new Promise<[number, string]>(resolve => {
            const child = installed.processes.spawn([installed.processes.findProgram('sh')!, '-c', 'while read -r l; do echo "got $l"; done; echo bye >&2; exit 4'], tmp, {
                line: text => lines.push(text),
                exit: (status, stderr) => resolve([status, stderr]),
            });
            ok(child.write('one') && child.write('two'), 'writes accepted');
            child.closeInput();
            ok(!child.write('late'), 'no writes after stdin is closed');
        });
        eq(await within(ended), [4, 'bye\n']);
        eq(lines, ['got one', 'got two']);
    });

    await test('stop ends a child that does not end by itself', async () => {
        const ended = new Promise<number>(resolve => {
            const child = installed.processes.spawn([installed.processes.findProgram('sleep')!, '30'], tmp, { line: () => {}, exit: status => resolve(status) });
            child.stop();
        });
        eq(await within(ended), 128 + 15);   // SIGTERM
    });

    await test('findProgram finds a program on PATH and not one that does not exist', async () => {
        ok(/(^|[\\/])node(\.exe)?$/i.test(installed.processes.findProgram('node') ?? ''), 'node not found');
        eq(installed.processes.findProgram('markwork-no-such-program'), null);
    });

    section('Platform: base64');

    await test('RFC 4648 for every padding length', async () => {
        const vectors: [string, string][] = [['', ''], ['e', 'ZQ=='], ['ek', 'ZWs='], ['eka', 'ZWth'], ['eka:', 'ZWthOg=='], ['eka:s', 'ZWthOnM='],
            ['eka:sekret', 'ZWthOnNla3JldA=='], ['ünïcödé:✓', 'w7xuw69jw7Zkw6k64pyT']];
        for (const [text, expected] of vectors) eq(base64(new TextEncoder().encode(text)), expected, JSON.stringify(text));
    });
}
