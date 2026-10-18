// The platform port on Node: node:fs, node:path, child_process, net, and fetch; the keyring through secret-tool. It shows
// that the core runs on a runtime other than GJS, and it is what a frontend whose core runs in Node (an Electron main
// process, or a sidecar next to Tauri or GPUI) starts from.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { OS, Platform, Scheduler, Secrets } from '../index.js';
import { samePath, userDirs } from './dirs.js';
import { catalogTranslations, userCatalog } from './i18n.js';
import { nodeFiles } from './files.js';
import { fetchStreamTransport, fetchTransport } from './http.js';
import { nodeLinks } from './links.js';
import { nodeProcesses } from './process.js';

// secret-tool (libsecret's command line) speaks to the same Secret Service the GJS port uses; libsecret stores a
// schema's name as the xdg:schema attribute, so passing it keeps the items shared with the GTK app. Without
// secret-tool or a keyring the answers are the ones the contract gives for a missing keyring.
function secretTool(args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
    return new Promise(resolveRun => {
        const child = execFile('secret-tool', args, { timeout: 10000 }, (error, out) => resolveRun({ ok: !error, out }));
        child.on('error', () => resolveRun({ ok: false, out: '' }));
        child.stdin?.end(input ?? '');
    });
}
const attributeArgs = (schema: string, attributes: Record<string, string>) =>
    ['xdg:schema', schema, ...Object.entries(attributes).flat()];

const os: OS = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const dirs = () => userDirs(os, process.env, homedir(), join);

// Only Linux has secret-tool. Elsewhere the answers are the ones the contract gives for a missing keyring, and the
// credentials fall back to a file in the user's config folder. A frontend with a keychain of its own (Electron's
// safeStorage, which only its main process can reach) replaces this port's secrets.
const noKeyring: Secrets = {
    lookup: async () => null,
    store: async () => false,
    clear: async () => { /* nothing is kept */ },
};

const secretToolKeyring: Secrets = {
    async lookup(schema, attributes) {
        const { ok, out } = await secretTool(['lookup', ...attributeArgs(schema, attributes)]);
        return ok && out ? out : null;
    },
    async store(schema, attributes, label, secret) {
        return (await secretTool(['store', `--label=${label}`, ...attributeArgs(schema, attributes)], secret)).ok;
    },
    async clear(schema, attributes) {
        await secretTool(['clear', ...attributeArgs(schema, attributes)]);
    },
};

const secrets = os === 'linux' ? secretToolKeyring : noKeyring;

// Node has no frames to wait for; idle work runs after the pending I/O callbacks (setImmediate).
const scheduler: Scheduler = {
    idle(fn) {
        let handle: ReturnType<typeof setImmediate> | null = setImmediate(function again() {
            handle = fn() ? setImmediate(again) : null;
        });
        return () => { if (handle) { clearImmediate(handle); handle = null; } };
    },
    idleAfter(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
    },
};


// The full name from the passwd entry (the GECOS field up to the first comma), as GLib.get_real_name() reads it.
function realName(): string | null {
    if (os === 'win32') return null;
    try {
        const user = userInfo().username;
        const entry = readFileSync('/etc/passwd', 'utf8').split('\n').find(line => line.startsWith(`${user}:`));
        const name = entry?.split(':')[4]?.split(',')[0].trim();
        return name || null;
    } catch {
        return null;
    }
}

export const nodePlatform: Platform = {
    os,
    fs: nodeFiles,
    paths: {
        join: (...parts) => join(...parts),
        dirname: path => dirname(path),
        resolve: path => resolve(path),
        relative: (dir, path) => {
            const rel = relative(resolve(dir), resolve(path));
            return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
        },
        basename: path => basename(path),
        isAbsolute: path => isAbsolute(path),
        same: (a, b) => samePath(os, a, b, resolve),
        configDir: () => dirs().config,
        homeDir: () => homedir(),
        runtimeDir: () => dirs().runtime,
    },
    secrets,
    http: fetchTransport,
    httpStream: fetchStreamTransport,
    processes: nodeProcesses,
    scheduler,
    links: nodeLinks,
    translations: catalogTranslations(userCatalog()),
    env: name => process.env[name] ?? null,
    realName,
    monotonicMs: () => performance.now(),
};
