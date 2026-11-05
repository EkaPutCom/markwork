// Exercise the real vault with Electron safeStorage, independently of pi authentication.
// Assistant chat no longer has a Markwork API-key editor. No user's credentials are touched.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, stepper, repo } from './support.mjs';

const { scratch, notes } = scratchFolder('secrets');
writeFileSync(join(notes, 'plan.md'), '# Plan\n');
const KEY = 'sk-test-vault-key-123';
if (process.platform === 'darwin' && process.env.CI) {
    console.log('Electron secrets: skipped because CI cannot unlock the login Keychain');
    process.exit(0);
}
setTimeout(() => { console.error('Electron vault test deadline exceeded'); process.exit(1); }, 120000).unref();
const module = join(scratch, 'vault.cjs');
await build({ configFile: false, logLevel: 'warn', build: { outDir: scratch, emptyOutDir: false, target: 'node22', ssr: true, minify: false,
    lib: { entry: join(repo, 'src/platform/node/vault.ts'), formats: ['cjs'], fileName: () => 'vault.cjs' }, rollupOptions: { external: [/^node:/] } } });
const launch = async () => {
    const app = await launchApp({ scratch, notes, settings: { welcomed: true, home: false }, env: { MARKWORK_SECRETS: 'vault', MARKWORK_TEST_PLAIN_STORAGE: '1', DEEPSEEK_API_KEY: '' } });
    const page = await app.firstWindow();
    await page.getByRole('treeitem', { name: /plan\.md/ }).click();
    await page.locator('.text-editor:not([hidden]) .cm-content').waitFor();
    return app;
};
const { step, steps } = stepper({ echo: true });
let app, failed = false;
try {
    app = await launch();
    await app.firstWindow();
    const available = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    if (!available) console.log('safeStorage has no encryption here; the vault deliberately stores nothing (covered by core tests)');
    else {
        const action = op => app.evaluate(async ({ app: electronApp, safeStorage }, { url, op, key }) => {
            const require = process.getBuiltinModule('module').createRequire(url);
            const { SecretVault } = require(url);
            const { join } = process.getBuiltinModule('path');
            const vault = new SecretVault(join(electronApp.getPath('userData'), 'vault-integration-test.json'), {
                available: () => safeStorage.isEncryptionAvailable(),
                encrypt: text => safeStorage.encryptString(text),
                decrypt: data => safeStorage.decryptString(Buffer.from(data)),
            });
            if (op === 'save') vault.store('markwork-test', { provider: 'test' }, key);
            if (op === 'clear') vault.clear('markwork-test', { provider: 'test' });
            return vault.lookup('markwork-test', { provider: 'test' });
        }, { url: module, op, key: KEY });
        await step('the real vault encrypts a credential with Electron safeStorage', async () => {
            assert.equal(await action('save'), KEY);
            const userData = await app.evaluate(({ app }) => app.getPath('userData'));
            assert.ok(!readFileSync(join(userData, 'vault-integration-test.json'), 'utf8').includes(KEY));
        });
        await step('the credential survives restarting Electron without involving Assistant chat', async () => {
            await app.close(); app = await launch(); await app.firstWindow();
            assert.equal(await action('lookup'), KEY);
        });
        await step('clearing the vault removes the credential', async () => { assert.equal(await action('clear'), null); });
    }
} catch (error) { failed = true; console.error(error); }
finally {
    if (app) {
        const child = app.process();
        let timer;
        await Promise.race([app.close().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
    }
    console.log(`Electron secrets: ${steps.length} steps, ${failed ? 'FAILED' : 'passed'}`);
}
if (failed) process.exitCode = 1;
