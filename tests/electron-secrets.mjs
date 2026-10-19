// The keyring of the core through Electron's safeStorage (Fase 7): where Node has no keyring (macOS, Windows) the core asks
// the main process, which keeps the item encrypted in its own folder. MARKWORK_SECRETS=vault does the same on Linux, so this
// runs everywhere. What the vault and the proxy decide is also in tests/unit/nodeplatform.ts. Run with `npm run test:electron`.

import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'markwork-secrets-'));
const notes = join(scratch, 'notes');
mkdirSync(notes);
writeFileSync(join(notes, 'plan.md'), '# Plan\n');
const KEY = 'sk-test-vault-key-123';

const steps = [];
async function step(name, run) {
    try {
        await run();
        steps.push(`  ✓ ${name}`);
    } catch (e) {
        steps.push(`  ✗ ${name}\n    ${String(e?.message ?? e).split('\n').join('\n    ')}`);
        throw e;
    }
}

const launch = () => electron.launch({
    args: [repo, notes], cwd: repo,
    env: { ...process.env, XDG_CONFIG_HOME: join(scratch, 'config'), MARKWORK_SECRETS: 'vault', MARKWORK_TEST_PLAIN_STORAGE: '1', DEEPSEEK_API_KEY: '' },
});

let app, failed = false;
try {
    app = await launch();
    let page = await app.firstWindow();
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    const settings = () => page.getByRole('complementary', { name: 'Assistant' }).getByRole('dialog', { name: 'Assistant settings' });
    const openSettings = async () => {
        await page.getByRole('treeitem', { name: /plan\.md/ }).waitFor({ timeout: 15000 });
        if (!(await page.getByRole('complementary', { name: 'Assistant' }).count())) await page.keyboard.press('Control+Shift+A');
        await page.getByRole('button', { name: 'Assistant settings' }).click();
    };

    if (!available) {
        steps.push('  – safeStorage has no encryption here (no keychain on this machine): the vault stores nothing, so the key falls back to a file');
    } else {
        await step('a key saved from the Assistant settings is kept by the main process, encrypted', async () => {
            await openSettings();
            await settings().getByText('No key yet.').waitFor();
            await settings().getByLabel('API key').fill(KEY);
            await settings().getByRole('button', { name: 'Save' }).click();
            await settings().getByText(/A key is set in the system keyring/).waitFor();
            const vault = join(userData, 'secrets.json');
            assert.ok(existsSync(vault), 'the vault file is there');
            assert.ok(!readFileSync(vault, 'utf8').includes(KEY), 'the key is not in it as text');
            assert.ok(!existsSync(join(scratch, 'config', 'markwork', 'deepseek-api-key')), 'and not in a file of the core');
        });

        await step('after a restart the core finds the key again', async () => {
            await app.close();
            app = await launch();
            page = await app.firstWindow();
            await openSettings();
            await settings().getByText(/A key is set in the system keyring/).waitFor();
        });

        await step('Forget removes it', async () => {
            await settings().getByRole('button', { name: 'Forget' }).click();
            await settings().getByText('No key yet.').waitFor();
            assert.ok(!readFileSync(join(userData, 'secrets.json'), 'utf8').includes('['), 'the vault holds no item');
        });
    }
} catch {
    failed = true;
} finally {
    await Promise.race([app?.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app?.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron secrets');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
