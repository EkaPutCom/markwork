// The repros kept as tests (tests/electron/repros/*.mwrepro.json, written by `npm run editor -- test-from`): each is
// played again in a window in dev mode, with every check after every step (docs/design/debugger.md, section 10). A repro
// of a bug that was fixed passes; one that fails again names the step and the check.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const folder = fileURLToPath(new URL('./repros/', import.meta.url));
const editorScript = fileURLToPath(new URL('../../scripts/editor.mjs', import.meta.url));
const { scratch, notes } = scratchFolder('repros');
const { steps, step } = stepper();
let failed = false;

const cli = (...args) => new Promise(resolve => {
    execFile(process.execPath, [editorScript, ...args], { timeout: 120_000, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
        const answer = stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)) : null;
        resolve({ code: error ? error.code ?? 1 : 0, answer, stderr });
    });
});

let files = [];
try { files = readdirSync(folder).filter(f => f.endsWith('.mwrepro.json')).sort(); } catch { /* no folder: no repros yet */ }

if (files.length) {
    const app = await launchApp({ scratch, notes, env: { MARKWORK_DEV: '1' } });
    try {
        const page = await app.firstWindow();
        await page.setViewportSize({ width: 1400, height: 900 });
        const pid = ['--pid', String(await app.evaluate(() => process.pid))];
        await waitFor(async () => (await cli(...pid, 'hello')).answer?.ready === true, 30000);
        for (const file of files) {
            await step(`repro ${file.replace(/\.mwrepro\.json$/, '')}`, async () => {
                const { code, answer, stderr } = await cli(...pid, 'replay', join(folder, file));
                assert.ok(answer, stderr);
                const why = answer.first ? `step ${answer.first.step}: ${answer.first.finding.check}: ${answer.first.finding.message}` : answer.result === 'differs' ? `the text came out ${JSON.stringify(answer.doc)}` : stderr;
                assert.equal(answer.result, 'pass', why);
                assert.equal(code, 0);
            });
        }
    } catch {
        failed = true;
    } finally {
        await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
        try { app.process().kill(); } catch { /* already gone */ }
    }
} else {
    steps.push('  – no repros in tests/electron/repros yet');
}
rmSync(scratch, { recursive: true, force: true });

console.log('Electron repros');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
