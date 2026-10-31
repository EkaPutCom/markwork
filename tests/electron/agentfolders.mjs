// The real shell, editable files and independent agent conversations, with no paid model requests.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchFolder, testModule, stepper, waitFor } from './support.mjs';
const { scratch, notes } = scratchFolder('agent-folders');
writeFileSync(join(notes, 'agent.json'), JSON.stringify({ version: 1, name: 'Research Assistant', instructions: 'instructions.md' }));
writeFileSync(join(notes, 'instructions.md'), '# Research Assistant\n\nCite sources.\n');
writeFileSync(join(notes, 'plan.md'), '# Plan\n\nShip 15 November\n');
const { step, steps } = stepper({ echo: true });
const app = await launchApp({ scratch, notes, env: { DEEPSEEK_API_KEY: 'test', MARKWORK_TEST_MODEL: testModule('model.mjs') } });
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const chat = page.getByRole('complementary', { name: 'Agent conversation', exact: true });
    const input = chat.getByLabel('Ask the Assistant');
    await step('agent folder opens its chat tab centrally and sessions on the right', async () => {
        await chat.waitFor({ timeout: 15000 });
        await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).waitFor();
        await page.getByRole('tab', { name: /New chat/ }).waitFor();
        assert.equal(existsSync(join(notes, '.markwork')), false);
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
    await step('proposals require Apply and Undo checks the current document buffer', async () => {
        await input.fill('bump the date'); await input.press('Enter');
        const review = page.getByRole('dialog', { name: /Agent proposal/ });
        await review.waitFor();
        assert.match(readFileSync(join(notes, 'plan.md'), 'utf8'), /15 November/);
        await review.getByRole('button', { name: 'Apply', exact: true }).click();
        await review.waitFor({ state: 'detached' });
        await chat.getByText(/^Proposal answered:/).waitFor();
        await chat.getByRole('button', { name: 'Undo', exact: true }).last().click();
        await page.getByRole('tab', { name: /plan\.md/ }).click();
        assert.match(await page.locator('.cm-content').innerText(), /15 November/);
        await page.getByRole('tab', { name: /Hello agent/ }).click();
    });
    await step('switching a streaming session keeps it working and another session queues independently', async () => {
        await input.fill('slow'); await input.press('Enter');
        await chat.getByRole('button', { name: 'Stop', exact: true }).waitFor();
        await page.getByRole('tab', { name: /New chat/ }).click();
        await input.fill('Queued question'); await input.press('Enter');
        await page.getByText('Queued', { exact: true }).waitFor();
        await page.getByRole('tab', { name: /Hello agent/ }).click();
        await chat.getByRole('button', { name: 'Stop', exact: true }).click();
        await page.getByRole('tab', { name: /Queued question/ }).waitFor();
        await page.getByRole('tab', { name: /Queued question/ }).click();
        await chat.getByText('Echo: Queued question', { exact: true }).waitFor();
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
