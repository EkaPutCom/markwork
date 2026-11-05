// The ordinary Assistant uses deterministic pi RPC, never the old provider or a real API.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchFolder, testModule, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('assistant-pi');
writeFileSync(join(notes, 'plan.md'), '# Plan\n\nA workspace note.\n');
writeFileSync(join(notes, 'report.md'), '# Old report\n');
writeFileSync(join(notes, 'main.ts'), 'export function greet() {\n    return "hello";\n}\n');
mkdirSync(join(notes, '.markwork', 'chats'), { recursive: true });
const legacy = join(notes, '.markwork', 'chats', 'old.md');
writeFileSync(legacy, 'LEGACY TRANSCRIPT — do not import or delete\n');
const app = await launchApp({ scratch, notes, settings: { welcomed: true, chat: true }, env: { MARKWORK_TEST_PI: testModule('folderpi.mjs'), DEEPSEEK_API_KEY: 'never-forward-this-key' } });
const { step, steps } = stepper({ echo: true });
const errors = [];
let failed = false;
try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1280, height: 800 });
    const panel = page.getByRole('complementary', { name: 'Assistant', exact: true });
    const input = panel.getByRole('textbox', { name: 'Ask the Assistant', exact: true });
    const send = async text => {
        await panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
        await input.fill(text);
        await input.press('Enter');
    };
    const settled = () => panel.getByRole('button', { name: 'Send', exact: true }).waitFor();
    const activation = async () => {
        await panel.getByRole('button', { name: 'Activate pi Assistant', exact: true }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByRole('button', { name: 'Activate pi Assistant', exact: true }).click();
        await panel.getByText('pi Assistant activated', { exact: true }).waitFor();
    };
    await step('opening the panel requires explicit unsandboxed activation and preserves the draft on Cancel', async () => {
        await panel.waitFor();
        await input.fill('hello pi');
        assert.equal(await panel.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
        await panel.getByRole('button', { name: 'Activate pi Assistant', exact: true }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByText(/without individual approval/).waitFor();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await input.inputValue(), 'hello pi');
        await activation();
        assert.equal(await input.inputValue(), 'hello pi');
        await send('hello pi');
        await panel.locator('.chat-assistant', { hasText: 'Echo: hello pi' }).last().waitFor();
        await settled();
        assert.equal(await page.getByRole('dialog', { name: /Agent proposal/ }).count(), 0);
    });
    await step('settings use pi models and authentication rather than an Assistant API key', async () => {
        await panel.getByRole('button', { name: 'Assistant settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Assistant settings', exact: true });
        await settings.getByText(/Authentication and defaults come from pi/).waitFor();
        assert.equal(await settings.getByLabel('API key', { exact: true }).count(), 0);
        assert.equal(await settings.getByRole('combobox', { name: 'Model', exact: true }).innerText(), 'fake/test');
        assert.equal(await settings.getByLabel('Save conversation history', { exact: true }).isDisabled(), true);
        await page.keyboard.press('Escape');
    });
    await step('native pi writes directly and clean open files refresh without Apply', async () => {
        await page.getByRole('treeitem', { name: /report\.md/ }).click();
        await page.locator('.text-editor:not([hidden]) .cm-content').getByText('Old report').waitFor();
        await send('write report');
        await settled();
        await waitFor(() => readFileSync(join(notes, 'report.md'), 'utf8').includes('Research report'));
        await page.locator('.text-editor:not([hidden]) .cm-content').getByText('Research report').waitFor();
        assert.equal(await page.getByRole('dialog', { name: /Agent proposal/ }).count(), 0);
        assert.equal(readFileSync(legacy, 'utf8'), 'LEGACY TRANSCRIPT — do not import or delete\n');
    });
    await step('dirty drafts survive native writes and expose explicit resolution controls in the Assistant', async () => {
        const editor = page.locator('.text-editor:not([hidden]) .cm-content');
        await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' MY UNSAVED DRAFT');
        await send('write report'); await settled();
        await panel.getByText(/report\.md: changed on disk/).waitFor();
        assert.ok((await editor.innerText()).includes('MY UNSAVED DRAFT'));
        await panel.getByRole('button', { name: 'Use disk version', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Use disk version', exact: true }).click();
        await waitFor(async () => !(await editor.innerText()).includes('MY UNSAVED DRAFT'));
    });
    await step('Ask Assistant attaches selected code and remains reviewable before Send', async () => {
        await page.getByRole('treeitem', { name: /main\.ts/ }).click();
        const code = page.getByRole('textbox', { name: 'Code: main.ts', exact: true });
        await code.click(); await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('Shift+End');
        await page.getByRole('button', { name: 'Ask Assistant', exact: true }).click();
        await waitFor(async () => (await input.inputValue()).includes('export function greet()'));
        await input.fill('Explain this function\n\n' + await input.inputValue());
        const out = process.env.MARKWORK_ASSISTANT_SCREENSHOTS;
        if (out) {
            const closeNotice = page.getByRole('button', { name: 'Close toast', exact: true });
            if (await closeNotice.isVisible()) { await closeNotice.click(); await closeNotice.waitFor({ state: 'hidden' }); }
            mkdirSync(out, { recursive: true });
            for (const [theme, width] of [['light', 1280], ['dark', 1280], ['dark', 560]]) {
                await page.emulateMedia({ colorScheme: theme });
                await page.evaluate(() => { delete document.documentElement.dataset.theme; });
                await page.setViewportSize({ width, height: 800 });
                if (width < 900) await page.getByRole('button', { name: 'Ask Assistant', exact: true }).click();
                await input.waitFor();
                await input.evaluate(element => { element.scrollTop = 0; });
                await page.screenshot({ path: join(out, `assistant-pi-${theme}-${width}.png`), animations: 'disabled' });
            }
            await page.setViewportSize({ width: 1280, height: 800 });
        }
        if (!await input.isVisible()) await page.getByRole('button', { name: 'Ask Assistant', exact: true }).click();
        await input.press('Enter'); await settled();
        await panel.locator('.chat-assistant', { hasText: 'Explain this function' }).last().waitFor();
        assert.equal(readFileSync(join(notes, 'main.ts'), 'utf8'), 'export function greet() {\n    return "hello";\n}\n');
    });
    await step('new conversations and history use only pi bindings, never old Markdown transcripts', async () => {
        await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
        await panel.getByText(/Ask pi about your workspace/).waitFor();
        await panel.getByRole('button', { name: 'Conversations', exact: true }).click();
        const history = page.getByRole('dialog', { name: 'Conversations', exact: true });
        await history.getByRole('button', { name: /hello pi/ }).first().click();
        await panel.locator('.chat-user', { hasText: 'hello pi' }).first().waitFor();
        assert.equal(await page.getByRole('button', { name: /^Delete hello pi/ }).count(), 0);
    });
    await step('Stop ends a slow pi turn and does not claim to undo completed commands', async () => {
        await send('slow');
        await panel.getByRole('button', { name: 'Stop', exact: true }).click();
        await panel.locator('.chat-status.stopped').last().waitFor();
        await settled();
        assert.equal(await panel.getByRole('button', { name: 'Restore native session', exact: true }).count(), 0);
    });
    await step('measure the real Assistant window with deterministic pi, native resume and projection', async () => {
        const samples = [];
        for (let i = 0; i < 23; i++) {
            const start = performance.now();
            await send(`measurement ${i}`);
            await panel.locator('.chat-assistant', { hasText: new RegExp(`Echo: measurement ${i}(?:\\s|$)`) }).last().waitFor();
            await settled();
            if (i >= 3) samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        console.log(`  pi Assistant UI round trip: median ${samples[10].toFixed(1)} ms, p95 ${samples[18].toFixed(1)} ms, max ${samples[19].toFixed(1)} ms; 3 warmups, 20 samples; no real provider`);
    });
    await step('Add to Journal still records a line and Summarize Journal uses the pi Assistant', async () => {
        await page.getByRole('menubar').getByRole('menuitem', { name: 'Go', exact: true }).click();
        await page.getByRole('menuitem', { name: /Add to Journal/ }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByRole('textbox').fill('printer met at ten');
        await dialog.getByRole('button', { name: 'Add', exact: true }).click();
        const folder = join(notes, 'journal');
        await waitFor(() => existsSync(folder) && readdirSync(folder).some(name => name.endsWith('.md') && readFileSync(join(folder, name), 'utf8').includes('printer met at ten')));
        await page.getByRole('menubar').getByRole('menuitem', { name: 'Go', exact: true }).click();
        await page.getByRole('menuitem', { name: /Summarize Journal/ }).click();
        await panel.locator('.chat-user', { hasText: 'Close the day' }).last().waitFor();
        await settled();
    });
    assert.deepEqual(errors, []);
} catch (error) { failed = true; console.error(error); }
finally {
    // Cleanup is not a graceful-close assertion: Electron can leave app.close pending on macOS.
    const child = app.process();
    let closeTimer;
    try {
        await Promise.race([
            app.close().catch(error => { failed = true; console.error(error); }),
            new Promise(resolve => { closeTimer = setTimeout(resolve, 5000); }),
        ]);
    } finally {
        clearTimeout(closeTimer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    console.log(`${steps.length} pi Assistant steps, ${failed ? 'FAILED' : 'passed'}`);
}
if (failed) process.exitCode = 1;
