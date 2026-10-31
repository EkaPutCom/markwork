// New Agent uses the existing File menu, palette, and Explorer creation flow; it never calls a paid model.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { launchApp, scratchFolder, testModule, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('new-agent');
mkdirSync(join(notes, 'projects'));
writeFileSync(join(notes, 'notes.md'), '# Notes\n\nKeep the existing workspace visible.');
const { step, steps } = stepper({ echo: true });
const app = await launchApp({ scratch, notes, settings: { welcomed: true }, env: { MARKWORK_TEST_MODEL: testModule('model.mjs') } });
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1400, height: 900 });
    const dialog = page.getByRole('alertdialog', { name: 'New Agent', exact: true });
    const chat = page.getByRole('complementary', { name: 'Agent conversation', exact: true });
    const out = process.env.MARKWORK_NEW_AGENT_OUT;
    if (out) mkdirSync(out, { recursive: true });
    await step('File offers New Agent beside the existing document creation commands', async () => {
        await page.getByRole('menuitem', { name: 'File', exact: true }).click();
        await page.getByRole('menuitem', { name: 'New Agent…', exact: true }).click();
        await dialog.waitFor();
        await dialog.getByLabel('Folder name').fill('Research Assistant');
        if (out) for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
            await page.screenshot({ animations: 'disabled', path: join(out, `new-agent-dialog-${theme}.png`) });
        }
        const started = performance.now();
        await dialog.getByLabel('Folder name').press('Enter');
        await dialog.waitFor({ state: 'detached' });
        await chat.waitFor();
        await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).getByText('Research Assistant', { exact: true }).waitFor();
        console.log(`  New Agent submit to chat: ${(performance.now() - started).toFixed(1)} ms`);
        const root = join(notes, 'Research Assistant');
        assert.deepEqual(JSON.parse(readFileSync(join(root, 'agent.json'), 'utf8')), { version: 1, name: 'Research Assistant', instructions: 'instructions.md' });
        assert.ok(readFileSync(join(root, 'instructions.md'), 'utf8').includes('press Apply'));
        assert.equal(readFileSync(join(root, 'chats', '.gitignore'), 'utf8'), '*\n');
        const saved = readdirSync(join(root, 'chats')).filter(file => file.endsWith('.md'));
        assert.equal(saved.length, 1);
        assert.match(readFileSync(join(root, 'chats', saved[0]), 'utf8'), /^layout: chat$/m);
        assert.equal(existsSync(join(root, '.markwork')), false);
        assert.equal(await chat.locator('.chat-assistant').count(), 0, 'creation must not start a model turn');
        await page.getByRole('treeitem', { name: /^Research Assistant/ }).waitFor();
    });
    await step('the generated instructions remain editable in a normal Markdown tab', async () => {
        await page.getByRole('treeitem', { name: 'instructions.md', exact: true }).click();
        const editor = page.locator('.cm-content'); await editor.waitFor();
        await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' Use concise answers.');
        await page.getByRole('tab', { name: /New chat/ }).click();
        await chat.waitFor();
        await page.getByRole('tab', { name: /instructions\.md/ }).click();
        assert.match(await editor.innerText(), /Use concise answers\./);
        await page.getByRole('tab', { name: /New chat/ }).click();
        if (out) for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
            await page.screenshot({ animations: 'disabled', path: join(out, `new-agent-created-${theme}.png`) });
        }
    });
    await step('Explorer creates an agent inside the folder whose context menu was opened', async () => {
        await page.getByRole('treeitem', { name: 'projects', exact: true }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'New Agent…', exact: true }).click();
        await dialog.getByLabel('Folder name').fill('Project Agent');
        await dialog.getByLabel('Folder name').press('Enter');
        await dialog.waitFor({ state: 'detached' });
        await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).getByText('Project Agent', { exact: true }).waitFor();
        assert.ok(existsSync(join(notes, 'projects', 'Project Agent', 'agent.json')));
        assert.equal(existsSync(join(notes, 'Project Agent')), false);
    });
    await step('the palette offers New Agent and cancelling writes no folder', async () => {
        await page.keyboard.press('ControlOrMeta+Shift+P');
        const palette = page.getByRole('dialog', { name: 'Command Palette', exact: true });
        await palette.locator('input').fill('New Agent');
        await palette.getByRole('option', { name: 'New Agent…', exact: true }).click();
        await dialog.waitFor();
        await dialog.getByLabel('Folder name').fill('Cancelled Agent');
        if (out) {
            await page.setViewportSize({ width: 560, height: 800 });
            await page.screenshot({ animations: 'disabled', path: join(out, 'new-agent-dialog-narrow.png') });
        }
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(existsSync(join(notes, 'Cancelled Agent')), false);
        assert.equal(readdirSync(notes).some(name => name.startsWith('.markwork-new-agent-')), false);
    });
    await step('no renderer errors occurred', () => assert.deepEqual(errors, []));
} catch (error) { failed = true; console.error(error); if (page) console.error((await page.locator('body').innerText()).slice(-4000)); }
finally {
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
    try { app.process().kill(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
}
console.log(`New Agent: ${steps.length} steps`);
process.exit(failed ? 1 : 0);
