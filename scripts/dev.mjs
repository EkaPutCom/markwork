// npm run dev: rebuild + reopen the app every time a file is saved.
//
// GJS cannot reload running code (there is no HMR like in a browser), so every time a
// build finishes the app is closed and opened again.
// At the same time, `tsc --watch` checks types and reports errors in the same terminal
// (Vite itself does not check types).
//
// Arguments after `--` are passed on to the app:
//   npm run dev -- notes.md
//   npm run dev -- ~/notes
//
// Note: unsaved changes in the editor are lost every time the app is reopened.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_ARGS = process.argv.slice(2);

const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const log = (tag, code, message) => console.log(`${color(code, `[${tag}]`)} ${message}`);
const info = message => log('dev', 36, message);

// ---------- App ----------

let app = null;          // the gjs process that is running
let restarting = false;

function startApp() {
    const child = spawn('gjs', ['-m', 'dist/markwork.js', ...APP_ARGS], { cwd: ROOT, stdio: 'inherit' });
    app = child;
    child.on('exit', (code, signal) => {
        if (app !== child) return;  // old process that was deliberately stopped during restart
        app = null;
        if (!restarting) info(`app closed (${signal ?? `code ${code}`}); it will be reopened after the next change`);
    });
    child.on('error', error => info(`failed to run gjs: ${error.message}`));
}

// Stop the old app (if any) and wait until it has really exited.
function stopApp() {
    const child = app;
    if (!child) return Promise.resolve();
    app = null;
    return new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => {
            clearTimeout(force);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

async function restartApp() {
    restarting = true;
    const wasRunning = app !== null;
    await stopApp();
    startApp();
    restarting = false;
    info(wasRunning ? 'app reopened' : 'app opened');
}

// ---------- Type checking ----------

// detached: tsc runs in its own process group, so when stopping the whole
// group (npx and the tsc it launched) can be stopped at once.
const tsc = spawn('npx', ['tsc', '--noEmit', '--watch', '--preserveWatchOutput'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const prefixLines = stream => stream.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log('type', 35, line);
});
prefixLines(tsc.stdout);
prefixLines(tsc.stderr);

// ---------- Build ----------

const watcher = await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'warn', build: { watch: {} } });

// One build round: START → BUNDLE_END or ERROR → END. Vite still sends END
// even when the build fails, so the failure is recorded and the app is not reopened.
let failed = false;
watcher.on('event', event => {
    if (event.code === 'START') {
        failed = false;
        info('mem-build…');
    }
    if (event.code === 'BUNDLE_END') event.result?.close?.();
    if (event.code === 'ERROR') {
        failed = true;  // Vite already printed the error details
        event.result?.close?.();
    }
    if (event.code === 'END') {
        if (failed) log('dev', 31, 'build failed; the old app keeps running');
        else restartApp();
    }
});

// ---------- Exit (Ctrl+C) ----------

let exiting = false;
async function shutdown() {
    if (exiting) return;
    exiting = true;
    info('stopping');
    try {
        process.kill(-tsc.pid, 'SIGTERM');  // negative pid = the whole process group
    } catch {
        // already stopped
    }
    await watcher.close();
    await stopApp();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

info(`watching changes in src/ and tests/ (Ctrl+C to stop)${APP_ARGS.length ? `; app arguments: ${APP_ARGS.join(' ')}` : ''}`);
