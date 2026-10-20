// What every Electron test (tests/electron/*.mjs) shares: a scratch folder of its own, the app launched on it with its
// settings and data kept inside that folder on every system, the steps it reports, and waiting for a condition.

import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A module of tests/ as the URL the core imports it by (MARKWORK_TEST_MODEL and the like).
export const testModule = name => pathToFileURL(join(repo, 'tests', 'electron', name)).href;

// A fresh folder for one test file, with an empty notes/ folder in it.
export function scratchFolder(prefix) {
    const scratch = mkdtempSync(join(tmpdir(), `markwork-${prefix}-`));
    const notes = join(scratch, 'notes');
    mkdirSync(notes);
    return { scratch, notes };
}

// Git with a fixed author, so a test repository can commit on a machine without a git identity.
export const identity = { GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' };
export const gitIn = cwd => (...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim();

// The app on `notes`. Its settings and data stay in the scratch folder: XDG_CONFIG_HOME and XDG_DATA_HOME are read on
// macOS and Windows too (platform/node/dirs.ts), so one test file never sees what another left behind.
export function launchApp({ scratch, notes, env = {} }) {
    return electron.launch({
        args: [repo, notes], cwd: repo,
        env: { ...process.env, XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'), ...env },
    });
}

// Waits until `condition` (which may return a Promise) holds; fails after `ms`.
export async function waitFor(condition, ms = 10000) {
    for (const end = Date.now() + ms; Date.now() < end;) { if (await condition()) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail('timed out');
}

// The steps of a test file: each is reported with ✓ or ✗ and its error, and a failed one stops the file. `echo` prints
// each step as it ends (for a file whose last step may hang); `after` runs after each passed step and may add a line.
export function stepper({ echo = false, after } = {}) {
    const steps = [];
    const report = line => { steps.push(line); if (echo) console.log(line); };
    async function step(name, run) {
        try {
            await run();
            report(`  ✓ ${name}`);
            const extra = after ? await after() : null;
            if (extra) report(extra);
        } catch (e) {
            report(`  ✗ ${name}\n    ${String(e?.message ?? e).split('\n').join('\n    ')}`);
            throw e;
        }
    }
    return { steps, step };
}
