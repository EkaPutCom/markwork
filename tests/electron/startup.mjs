// Launch without a path, as from the desktop: saved tabs must belong to the restored work folder.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { scratchFolder, launchApp, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('startup');
const outside = join(scratch, 'all-formats.md');
writeFileSync(outside, '# Another workspace\n');
writeFileSync(join(notes, 'Test.md'), '# Manusya\n');
const { step, steps } = stepper({ echo: true });
const errors = [];
try {
    for (const mixed of [true, false]) {
        await step(`startup restores ${mixed ? 'only the workspace file from mixed tabs' : 'Home when every file tab is outside'}`, async () => {
            const started = performance.now();
            const app = await launchApp({ scratch, settings: {
                folder: notes, welcomed: true, home: true, 'active-tab': 0,
                tabs: [[outside, 0], ...(mixed ? [[join(notes, 'Test.md'), 0]] : [])],
            } });
            try {
                const page = await app.firstWindow();
                page.on('pageerror', e => errors.push(e.message));
                page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
                await page.getByRole('treeitem', { name: /Test\.md/ }).waitFor();
                if (mixed) await page.locator('.cm-content').getByText('Manusya', { exact: true }).waitFor();
                else await page.getByRole('tab', { name: /Home/ }).waitFor();
                assert.equal(await page.getByRole('tab', { name: /all-formats/ }).count(), 0);
                assert.equal(await page.locator('.cm-content').getByText('Another workspace').count(), 0);
                console.log(`  startup to ${mixed ? 'workspace document' : 'Home'}: ${(performance.now() - started).toFixed(0)} ms`);
                if (process.env.MARKWORK_STARTUP_SCREENSHOTS) {
                    mkdirSync(process.env.MARKWORK_STARTUP_SCREENSHOTS, { recursive: true });
                    await page.screenshot({ path: join(process.env.MARKWORK_STARTUP_SCREENSHOTS, mixed ? 'workspace-tab.png' : 'workspace-home.png') });
                }
                assert.deepEqual(errors, []);
            } finally {
                await app.close();
            }
        });
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
console.log(`Electron startup: ${steps.length} passed`);
