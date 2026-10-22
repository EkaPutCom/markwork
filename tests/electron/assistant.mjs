// The Assistant and the journal (chat, context, journal) run against the Electron window with
// Playwright: the real main process, core, and renderer, with a scripted model (tests/electron/model.mjs) in place of the
// network. What the core decides is also in tests/unit/protocol.ts. Run with `npm run test:electron`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { testModule, scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('assistant');
const read = name => readFileSync(join(notes, name), 'utf8');
const plan = () => read('plan.md');

writeFileSync(join(notes, 'plan.md'), '# Plan\n\nShip 15 November\n');
writeFileSync(join(notes, 'other.md'), '# Other\n\nSecond note\n');

const { steps, step } = stepper();

const app = await launchApp({ scratch, notes, env: { DEEPSEEK_API_KEY: 'test', MARKWORK_TEST_MODEL: testModule('model.mjs') } });
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    const input = page.getByLabel('Ask the Assistant');
    const review = page.getByRole('dialog', { name: /Agent proposal/ });
    // A question is sent once the turn before it is over (the button reads Send, not Stop).
    const ask = async text => { await page.getByRole('button', { name: /^(Send|Stop)$/ }).filter({ hasText: '' }).first().waitFor(); await page.getByRole('button', { name: 'Send', exact: true }).waitFor(); await input.fill(text); await input.press('Enter'); };
    // The text of the open document as the editor has it.
    const editorText = () => page.locator('.cm-content').innerText();

    await step('the window starts and lists the folder', async () => {
        await page.getByRole('treeitem', { name: /plan\.md/ }).waitFor({ timeout: 15000 });
        await page.getByRole('treeitem', { name: /plan\.md/ }).click();
    });

    await step('the Assistant button and Ctrl+Shift+A show and hide the panel', async () => {
        assert.equal(await panel.count(), 0);
        await page.getByRole('button', { name: 'Assistant', exact: true }).click();
        await panel.waitFor();
        await page.keyboard.press('ControlOrMeta+Shift+a');
        await panel.waitFor({ state: 'detached' });
        await page.keyboard.press('ControlOrMeta+Shift+a');
        await panel.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Ask the Assistant');
    });

    await step('a suggestion fills the box; Send is off while it is empty', async () => {
        const send = page.getByRole('button', { name: 'Send', exact: true });
        assert.equal(await send.isDisabled(), true);
        await panel.getByRole('button', { name: /Summarize this document/ }).click();
        assert.match(await input.inputValue(), /Summarize this document/);
        assert.equal(await send.isDisabled(), false);
        await input.fill('');
    });

    await step('a question gets a streamed answer, a status card, the usage line, and the actions', async () => {
        await ask('hello there');
        await panel.locator('.chat-user', { hasText: 'hello there' }).waitFor();
        await panel.locator('.chat-assistant', { hasText: 'Echo: hello there' }).waitFor();
        await panel.locator('.chat-status.done').waitFor();
        await panel.getByText(/1\.2k in \(200 from cache\) · 30 out/).waitFor();
        assert.equal(await input.inputValue(), '', 'the box is emptied');
        await panel.locator('.chat-status .head').click();
        await panel.getByText('Thinking process').waitFor();
        await panel.getByText(/^Context: ≈/).waitFor();
        for (const name of ['Copy', 'Insert into note', 'Retry', 'Log']) await panel.getByRole('button', { name, exact: true }).first().waitFor();
    });

    await step('Insert into note puts the answer into the open note', async () => {
        await panel.getByRole('button', { name: 'Insert into note' }).last().click();
        await panel.getByRole('button', { name: 'Inserted' }).waitFor();
        await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('Echo: hello there'));
    });

    await step('the context button shows what is sent, and its switches change it', async () => {
        const button = panel.getByRole('button', { name: /^Context/ });
        await button.click();
        const popover = panel.getByRole('dialog', { name: 'Context' });
        await popover.getByText(/Total ≈/).waitFor();
        await popover.getByLabel('Open document').uncheck();
        await page.waitForFunction(() => !document.querySelector('.chat-popover')?.textContent?.includes('Document: '));
        await popover.getByLabel('Open document').check();
        await page.keyboard.press('Escape');
        await popover.waitFor({ state: 'detached' });
    });

    await step('the settings popover tells where the key is kept and takes the model and switches', async () => {
        await panel.getByRole('button', { name: 'Assistant settings' }).click();
        const settings = panel.getByRole('dialog', { name: 'Assistant settings' });
        await settings.getByText(/A key is set from the DEEPSEEK_API_KEY environment variable/).waitFor();
        assert.equal(await settings.getByRole('button', { name: 'Forget' }).count(), 0, 'a key from the environment is not forgotten here');
        await settings.getByLabel('Thinking mode').check();
        await settings.getByLabel('Thinking mode').uncheck();
        assert.ok((await settings.getByLabel('Model').locator('option').count()) >= 1);
        await page.keyboard.press('Escape');
    });

    await step('a proposal opens the review with the diff; Apply writes the file and the card offers Undo', async () => {
        await ask('bump the date');
        await review.waitFor();
        await review.getByText('+Ship 22 November').waitFor();
        await review.getByText('-Ship 15 November').waitFor();
        assert.match(plan(), /15 November/, 'nothing is written before the decision');
        await review.getByRole('button', { name: 'Apply', exact: true }).click();
        await review.waitFor({ state: 'detached' });
        await panel.locator('.chat-proposal', { hasText: 'Applied.' }).waitFor();
        await panel.locator('.chat-assistant', { hasText: 'Proposal answered' }).waitFor();
        await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('22 November'));
        await page.keyboard.press('ControlOrMeta+s');
        await waitFor(() => /22 November/.test(plan()));
    });

    await step('Undo restores the file through the core', async () => {
        await panel.locator('.chat-proposal', { hasText: 'Applied.' }).last().getByRole('button', { name: 'Undo' }).click();
        await panel.locator('.chat-proposal', { hasText: 'Undone.' }).waitFor();
        await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('15 November'));
        await page.keyboard.press('ControlOrMeta+s');
        await waitFor(() => /15 November/.test(plan()));
    });

    await step('Reject with a note leaves the file alone and tells the agent', async () => {
        await ask('bump it again');
        await review.waitFor();
        await review.getByLabel('Note for the agent').fill('not now');
        await review.getByRole('button', { name: 'Reject' }).click();
        await review.waitFor({ state: 'detached' });
        await panel.locator('.chat-proposal', { hasText: 'Rejected: not now' }).waitFor();
        await panel.locator('.chat-assistant', { hasText: 'Proposal answered' }).last().waitFor();
        assert.match(plan(), /15 November/);
    });

    await step('closing the review with Escape is rejecting', async () => {
        await ask('bump once more');
        await review.waitFor();
        await page.keyboard.press('Escape');
        await review.waitFor({ state: 'detached' });
        await panel.locator('.chat-proposal', { hasText: 'Rejected.' }).last().waitFor();
        await panel.locator('.chat-proposal', { hasText: 'Rejected.' }).last().getByRole('button', { name: 'View diff' }).click();
        await panel.locator('pre.diff').last().getByText('+Ship 22 November').waitFor();
    });

    await step('Stop ends a running turn and the card says so, with Retry', async () => {
        await ask('slow question');
        const stop = page.getByRole('button', { name: 'Stop', exact: true });
        await stop.waitFor();
        await panel.locator('.chat-status.thinking').last().waitFor();
        await stop.click();
        await panel.locator('.chat-status.stopped').last().waitFor();
        await panel.getByText('Stopped before any answer').waitFor();
        await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
        await panel.locator('.chat-status.stopped').last().getByRole('button', { name: 'Retry' }).waitFor();
    });

    await step('the agent log shows the turns as a tree with the details of a step', async () => {
        await page.getByRole('button', { name: 'Agent log', exact: true }).click();
        const log = page.getByRole('dialog', { name: 'Agent log' });
        await log.getByRole('treeitem', { name: /hello there/ }).waitFor();
        await page.locator('.log-tree .step.round').first().waitFor();
        await log.getByRole('button', { name: 'Tools', exact: true }).click();
        await log.getByRole('treeitem', { name: /edit_file/ }).first().click();
        await log.getByRole('tab', { name: 'Arguments' }).click();
        await log.getByText(/old_text/).waitFor();
        await log.getByRole('button', { name: 'All', exact: true }).click();
        const rounds = await page.locator('.log-tree .step.round').count();
        await log.getByRole('treeitem', { name: /hello there/ }).getByRole('button', { name: 'Collapse' }).click();
        await page.waitForFunction(n => document.querySelectorAll('.log-tree .step.round').length < n, rounds);
        await log.getByRole('button', { name: 'Clear' }).click();
        await log.getByText(/No activity yet/).waitFor();
        await page.keyboard.press('Escape');
        await log.waitFor({ state: 'detached' });
    });

    await step('saved conversations: opened again with the turns, and deleted', async () => {
        const chats = join(notes, '.markwork', 'chats');
        await waitFor(() => existsSync(chats) && readdirSync(chats).some(f => f.endsWith('.md')));
        await panel.getByRole('button', { name: 'Conversations' }).click();
        const list = panel.getByRole('dialog', { name: 'Conversations' });
        await list.getByText('hello there').waitFor();
        await page.keyboard.press('Escape');
        await panel.getByRole('button', { name: 'New conversation' }).click();
        await panel.getByText(/Ask or request help/).waitFor();
        await panel.getByRole('button', { name: 'Conversations' }).click();
        await list.getByRole('button', { name: /hello there/ }).first().click();
        await panel.locator('.chat-user', { hasText: 'hello there' }).waitFor();
        await panel.locator('.chat-assistant', { hasText: 'Echo: hello there' }).waitFor();
        await panel.getByRole('button', { name: 'View diff · 1 file' }).first().waitFor();
        await panel.getByRole('button', { name: 'Conversations' }).click();
        await list.getByRole('button', { name: /^Delete hello there/ }).first().click();
        await list.getByText('hello there').waitFor({ state: 'detached' });
        await page.keyboard.press('Escape');
    });

    await step('Add to Journal asks for a line and records it in today\'s journal', async () => {
        await page.getByRole('menubar').getByRole('menuitem', { name: 'Go', exact: true }).click();
        await page.getByRole('menuitem', { name: /Add to Journal/ }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByText('Add to Journal').first().waitFor();
        await dialog.getByRole('textbox').fill('printer met at ten');
        await dialog.getByRole('button', { name: 'Add' }).click();
        await page.getByText("Recorded in today's journal").waitFor();
        const folder = join(notes, 'journal');
        await waitFor(() => existsSync(folder) && readdirSync(folder).length > 0);
        const file = readdirSync(folder)[0];
        assert.match(readFileSync(join(folder, file), 'utf8'), /printer met at ten/);
    });

    await step('Today\'s Journal opens the day, and Summarize Journal asks the Assistant about it', async () => {
        await page.getByRole('menubar').getByRole('menuitem', { name: 'Go', exact: true }).click();
        await page.getByRole('menuitem', { name: /Today's Journal/ }).click();
        await page.getByText('printer met at ten').first().waitFor();
        await page.getByRole('menubar').getByRole('menuitem', { name: 'Go', exact: true }).click();
        await page.getByRole('menuitem', { name: /Summarize Journal/ }).click();
        await panel.locator('.chat-user', { hasText: 'Close the day' }).waitFor();
        await panel.locator('.chat-assistant').last().waitFor();
    });

    await step('Home has a button for Add to Journal', async () => {
        await page.getByRole('menubar').getByRole('menuitem', { name: 'Go', exact: true }).click();
        await page.getByRole('menuitem', { name: /^Home/ }).click();
        await page.getByText("Today's journal", { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Add to Journal…', exact: true }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByRole('textbox').fill('from home');
        await dialog.getByRole('button', { name: 'Add' }).click();
        await page.getByText("Recorded in today's journal").waitFor();
    });
} catch {
    failed = true;
    // What the window showed when a step failed.
    console.error(await page?.locator('.chat-messages').innerText().catch(() => '(no panel)'));
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron Assistant and journal');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
