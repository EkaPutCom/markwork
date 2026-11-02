// The real shell, editable files and independent agent conversations, with no paid model requests.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { seedFolderAgent } from './folderpi.mjs';
import { launchApp, scratchFolder, testModule, stepper, waitFor } from './support.mjs';
const { scratch, notes } = scratchFolder('agent-folders');
seedFolderAgent({ scratch, notes });
writeFileSync(join(notes, 'plan.md'), '# Plan\n\nShip 15 November\n');
const { step, steps } = stepper({ echo: true });
const app = await launchApp({ scratch, notes, settings: { autosave: false, welcomed: true }, env: { DEEPSEEK_API_KEY: 'test', MARKWORK_TEST_MODEL: testModule('model.mjs'), MARKWORK_TEST_PI: testModule('folderpi.mjs') } });
let failed = false;
let page;
try {
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    const out = process.env.MARKWORK_AGENT_OUT; if (out) mkdirSync(out, { recursive: true });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const chat = page.getByRole('complementary', { name: 'Agent conversation', exact: true });
    const input = chat.getByLabel('Message', { exact: true });
    await step('agent folder opens its chat tab centrally and sessions on the right', async () => {
        await chat.waitFor({ timeout: 15000 });
        await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).waitFor();
        await page.getByRole('tab', { name: /New chat/ }).waitFor();
        assert.equal(existsSync(join(notes, '.markwork')), false);
        await page.getByRole('menuitem', { name: 'File', exact: true }).click();
        assert.equal(await page.getByRole('menuitem', { name: 'New Agent…', exact: true }).isDisabled(), true);
        await page.keyboard.press('Escape');
    });
    await step('pi requires an explicit unsandboxed activation before the first prompt', async () => {
        await page.getByRole('button', { name: 'Activate pi agent', exact: true }).click();
        const confirmation = page.getByRole('alertdialog', { name: 'Activate pi agent?', exact: true });
        await confirmation.waitFor();
        await confirmation.getByText(/workspace is not a sandbox/).waitFor();
        if (out) {
            for (const theme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: theme }); await page.screenshot({ animations: 'disabled', path: join(out, 'activation-' + theme + '.png') }); }
            await page.setViewportSize({ width: 560, height: 800 }); await page.screenshot({ animations: 'disabled', path: join(out, 'activation-narrow.png') });
            await page.setViewportSize({ width: 1400, height: 900 });
        }
        await confirmation.getByRole('button', { name: 'Activate pi agent', exact: true }).click();
        await confirmation.waitFor({ state: 'detached' });
    });
    await step('the model answer and history belong to this session', async () => {
        await input.fill('Hello agent'); await input.press('Enter');
        await chat.getByText('Echo: Hello agent', { exact: true }).waitFor();
        await chat.getByRole('button', { name: 'Send', exact: true }).waitFor();
        await page.getByRole('tab', { name: /Hello agent/ }).waitFor();
        assert.ok(existsSync(join(notes, 'chats')));
        const saved = readdirSync(join(notes, 'chats')).filter(name => name.endsWith('.md'));
        for (const name of saved) {
            const text = readFileSync(join(notes, 'chats', name), 'utf8');
            assert.match(text, /^layout: chat$/m);
            assert.doesNotMatch(text, /^agent: true$/m);
        }
    });
    await step('Markdown stays editable and switching back to chat preserves its text', async () => {
        await page.getByRole('treeitem', { name: /^plan\.md$/ }).click();
        const editor = page.locator('.cm-content'); await editor.waitFor();
        await page.getByRole('complementary', { name: 'Assistant', exact: true }).waitFor();
        assert.equal(await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).count(), 0);
        await page.getByRole('complementary', { name: 'Assistant', exact: true }).getByLabel('Ask the Assistant').fill('Draft for this document');
        await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' More notes.');
        await page.getByRole('tab', { name: /Hello agent/ }).click(); await chat.waitFor();
        await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).waitFor();
        assert.equal(await page.getByRole('complementary', { name: 'Assistant', exact: true }).count(), 0);
        await page.getByRole('tab', { name: /plan\.md/ }).click();
        assert.match(await editor.innerText(), /More notes\./);
        assert.equal(await page.getByRole('complementary', { name: 'Assistant', exact: true }).getByLabel('Ask the Assistant').inputValue(), 'Draft for this document');
        await page.getByRole('tab', { name: /Hello agent/ }).click();
    });
    await step('an Explorer transcript opens the existing chat rather than a Markdown document', async () => {
        await page.getByRole('tab', { name: /plan\.md/ }).click();
        const folder = page.getByRole('treeitem', { name: 'chats', exact: true });
        if (await folder.getAttribute('aria-expanded') === 'false') await folder.click();
        const file = readdirSync(join(notes, 'chats')).find(name => name.endsWith('.md'));
        await page.getByRole('treeitem', { name: file, exact: true }).click();
        await chat.waitFor();
        await chat.getByText('Echo: Hello agent', { exact: true }).waitFor();
        assert.equal(await page.getByRole('tab', { name: /Hello agent/ }).count(), 1);
        assert.equal(await page.getByRole('tab', { name: file, exact: true }).count(), 0);
    });
    await step('new chat gets a separate tab and previous history remains isolated', async () => {
        await page.getByRole('button', { name: 'New chat', exact: true }).click();
        await page.getByRole('tab', { name: /New chat/, selected: true }).waitFor();
        await chat.waitFor(); assert.equal(await chat.getByText('Echo: Hello agent', { exact: true }).count(), 0);
        await page.getByRole('tab', { name: /Hello agent/ }).click();
        await chat.getByText('Echo: Hello agent', { exact: true }).waitFor();
    });
    await step('session rows focus the matching chat and preserve its history', async () => {
        const sessions = page.getByRole('complementary', { name: 'Agent sessions', exact: true });
        await sessions.getByRole('button', { name: /New chat.*Saved conversation/ }).click();
        await page.getByRole('tab', { name: /New chat/, selected: true }).waitFor();
        assert.equal(await chat.getByText('Echo: Hello agent', { exact: true }).count(), 0);
        await sessions.getByRole('button', { name: /Hello agent.*Saved conversation/ }).click();
        await page.getByRole('tab', { name: /Hello agent/, selected: true }).waitFor();
        await chat.getByText('Echo: Hello agent', { exact: true }).waitFor();
        assert.equal(await page.getByRole('tab', { name: /Hello agent/ }).count(), 1);
    });
    await step('pi writes directly with visible tools while disk conflicts preserve unsaved drafts', async () => {
        await input.fill('write report'); await input.press('Enter');
        await chat.getByText('Echo: write report', { exact: true }).waitFor();
        assert.match(readFileSync(join(notes, 'workspace', 'report.md'), 'utf8'), /https:\/\/example.com/);
        assert.equal(await page.getByRole('dialog', { name: /Agent proposal/ }).count(), 0);
        writeFileSync(join(notes, 'plan.md'), '# External disk version');
        const conflicts = page.getByRole('region', { name: 'Disk conflicts', exact: true });
        await conflicts.waitFor();
        if (out) await page.screenshot({ animations: 'disabled', path: join(out, 'disk-conflict.png') });
        await page.getByRole('tab', { name: /plan\.md/ }).click();
        assert.match(await page.locator('.cm-content').innerText(), /More notes\./);
        await page.getByRole('tab', { name: /Hello agent/ }).click();
        await conflicts.getByRole('button', { name: 'Use disk version', exact: true }).click();
        const confirm = page.getByRole('alertdialog', { name: 'Use disk version?', exact: true });
        await confirm.getByRole('button', { name: 'Use disk version', exact: true }).click();
        await conflicts.waitFor({ state: 'detached' });
        await page.getByRole('tab', { name: /plan\.md/ }).click();
        await page.locator('.cm-content').getByText('External disk version', { exact: true }).waitFor();
        await page.getByRole('tab', { name: /Hello agent/ }).click();
    });
    await step('research tables render and nested shell outputs appear without a manual tree expansion', async () => {
        await input.fill('research table'); await input.press('Enter');
        const table = chat.getByRole('table'); await table.waitFor();
        assert.equal(await table.getByRole('columnheader').count(), 4);
        assert.equal(await table.getByRole('cell', { name: 'CVE-2026-0001', exact: true }).count(), 1);
        assert.equal(await table.locator('strong').innerText(), 'CVE-2026-0001');
        assert.equal(await table.locator('td.md-align-right code').innerText(), '9.8');
        await page.getByRole('treeitem', { name: 'cve-report.md', exact: true }).waitFor();
        assert.equal(await page.getByRole('tab', { name: /Hello agent/ }).getAttribute('aria-selected'), 'true');
        if (out) {
            const notice = page.getByRole('button', { name: 'Close toast' });
            if (await notice.isVisible()) { await notice.click(); await notice.waitFor({ state: 'hidden' }); }
            for (const theme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
                await page.screenshot({ animations: 'disabled', path: join(out, 'research-table-' + theme + '.png') });
            }
            await page.setViewportSize({ width: 560, height: 800 });
            await page.screenshot({ animations: 'disabled', path: join(out, 'research-table-narrow.png') });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'table overflowed the window');
            await page.setViewportSize({ width: 1400, height: 900 });
        }
    });
    await step('switching a streaming session keeps it working and another session queues independently', async () => {
        await input.fill('slow'); await input.press('Enter');
        await chat.getByRole('button', { name: 'Stop', exact: true }).waitFor();
        await page.getByRole('tab', { name: /New chat/ }).click();
        await input.fill('Queued question'); await input.press('Enter');
        await page.getByText('Queued', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Close Hello agent', exact: true }).click();
        await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).getByRole('button', { name: /Hello agent.*Working/ }).click();
        await chat.getByRole('button', { name: 'Stop', exact: true }).click();
        await page.getByRole('tab', { name: /Queued question/ }).waitFor();
        await page.getByRole('tab', { name: /Queued question/ }).click();
        await chat.getByText('Echo: Queued question', { exact: true }).waitFor();
    });
    await step('explicit native restore replaces a tampered readable projection without replaying tools', async () => {
        const projection = readdirSync(join(notes, 'chats')).find(name => name.endsWith('.md') && readFileSync(join(notes, 'chats', name), 'utf8').includes('Queued question'));
        assert.ok(projection); writeFileSync(join(notes, 'chats', projection), '# FORGED HISTORY');
        await page.getByRole('button', { name: 'Restore native session', exact: true }).click();
        const confirm = page.getByRole('alertdialog', { name: 'Restore native session?', exact: true });
        await confirm.getByRole('button', { name: 'Restore native session', exact: true }).click();
        await chat.getByText('Echo: Queued question', { exact: true }).waitFor();
        await waitFor(() => readFileSync(join(notes, 'chats', projection), 'utf8').includes('Echo: Queued question'));
        assert.match(readFileSync(join(notes, 'chats', projection), 'utf8'), /Echo: Queued question/);
        assert.equal(await chat.getByText('FORGED HISTORY', { exact: true }).count(), 0);
    });
    if (process.env.MARKWORK_AGENT_OUT) {
        mkdirSync(process.env.MARKWORK_AGENT_OUT, { recursive: true });
        for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme });
            await page.screenshot({ animations: 'disabled', path: join(process.env.MARKWORK_AGENT_OUT, `agent-folder-${theme}.png`) });
        }
        await page.setViewportSize({ width: 560, height: 800 });
        await page.screenshot({ animations: 'disabled', path: join(process.env.MARKWORK_AGENT_OUT, 'agent-folder-narrow.png') });
    }
    await step('no renderer errors occurred', () => assert.deepEqual(errors, []));
} catch (error) { failed = true; console.error(error); if (page) console.error((await page.locator('body').innerText()).slice(-6000)); }
finally {
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
    try { app.process().kill(); } catch {}
    rmSync(scratch, { recursive: true, force: true });
}
console.log(`Agent folders: ${steps.length} steps`);
process.exit(failed ? 1 : 0);
