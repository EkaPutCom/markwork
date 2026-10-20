// The adaptive layout of the window (the GTK test in tests/gui/gnome.ts: "a narrow window collapses the Assistant panel,
// then the sidebar becomes floating") with Playwright: below 900 px the Assistant panel floats over the editor, below
// 600 px the side panel does too and the header bar shows icons only, a click beside a floating panel closes it, and
// widening the window brings back the panels as they were. Run with `npm run test:electron`.

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper } from './electron-support.mjs';

const { scratch, notes } = scratchFolder('layout');
writeFileSync(join(notes, 'note.md'), '# Note\n\n' + 'Some text that fills the line. '.repeat(30) + '\n');
const { steps, step } = stepper();

const app = await launchApp({ scratch, notes, env: { DEEPSEEK_API_KEY: 'test' } });
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const resize = async width => {
        await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 700), width);
        await page.waitForFunction(w => window.innerWidth === w, width);
    };
    const chat = page.getByRole('complementary', { name: 'Assistant' });
    const files = page.getByRole('complementary', { name: 'Files' });
    const assistantButton = page.getByRole('button', { name: 'Assistant', exact: true });
    const sidebarButton = page.getByRole('button', { name: 'Toggle Sidebar' });
    // Whether a panel floats over the content (absolute) or takes its own width beside it.
    const floats = async locator => (await locator.evaluate(el => getComputedStyle(el).position)) === 'absolute';
    const editorWidth = () => page.locator('.editor-group').evaluate(el => el.getBoundingClientRect().width);
    const content = page.locator('.cm-content');

    await step('a wide window docks the side panel and the Assistant beside the editor', async () => {
        await resize(1100);
        await page.getByRole('treeitem', { name: /note\.md/ }).click();
        await content.waitFor();
        await assistantButton.click();
        await chat.waitFor();
        assert.equal(await floats(chat), false, 'the Assistant takes its own width');
        assert.equal(await floats(files), false, 'the side panel takes its own width');
        assert.equal(await assistantButton.getAttribute('aria-pressed'), 'true');
    });

    await step('below 900 px the Assistant closes and opens again floating over the editor', async () => {
        await resize(760);
        await chat.waitFor({ state: 'detached' });
        assert.equal(await assistantButton.getAttribute('aria-pressed'), 'false', 'the button follows what is shown');
        assert.equal(await floats(files), false, 'at 760 px the side panel is still docked');
        const before = await editorWidth();
        await assistantButton.click();
        await chat.waitFor();
        assert.equal(await floats(chat), true, 'the Assistant floats');
        assert.equal(await editorWidth(), before, 'the editor keeps its width');
    });

    await step('a click on the editor beside a floating panel closes it', async () => {
        const box = await page.locator('.editor-group').boundingBox();
        await page.mouse.click(box.x + 40, box.y + box.height / 2);
        await chat.waitFor({ state: 'detached' });
        await page.keyboard.press('ControlOrMeta+Shift+A');
        await chat.waitFor();
        assert.equal(await floats(chat), true, 'the key opens it floating too');
        await page.keyboard.press('ControlOrMeta+Shift+A');
        await chat.waitFor({ state: 'detached' });
    });

    await step('below 600 px the side panel floats too, one floating panel at a time, Escape closes it, and the header bar shows icons only', async () => {
        await resize(480);
        await files.waitFor({ state: 'detached' });
        assert.equal(await page.locator('.headerbar').getAttribute('class'), 'headerbar compact');
        assert.equal(await page.locator('.headerbar').getByText('New', { exact: true }).isVisible(), false, 'no label beside the New icon');
        await sidebarButton.click();
        await files.waitFor();
        assert.equal(await floats(files), true, 'the side panel floats');
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('complementary', { name: 'Search' }).waitFor();
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('complementary', { name: 'Search' }).waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        await files.waitFor();
        await assistantButton.click();
        await chat.waitFor();
        await files.waitFor({ state: 'detached' });   // one floating panel at a time: there is no room for two
        await page.keyboard.press('Escape');
        await chat.waitFor({ state: 'detached' });    // Escape closes a floating panel
        await sidebarButton.click();
        await files.waitFor();
        const box = await page.locator('.editor-group').boundingBox();
        await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
        await files.waitFor({ state: 'detached' });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'nothing sticks out of the window');
    });

    await step('widening the window docks the panels again as they were before it narrowed', async () => {
        await resize(1100);
        await files.waitFor();
        await chat.waitFor();
        assert.equal(await floats(chat), false);
        assert.equal(await floats(files), false);
    });

    await step('a panel closed on purpose stays closed when the window narrows and widens again', async () => {
        await page.keyboard.press('ControlOrMeta+Shift+A');
        await chat.waitFor({ state: 'detached' });
        await resize(760);
        await resize(1100);
        await page.waitForTimeout(200);   // the window has settled; the Assistant must not come back
        assert.equal(await chat.count(), 0, 'the closed Assistant stays closed');
        await files.waitFor();
    });

    await step('the window does not get smaller than 360 px', async () => {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(200, 200));
        let width = 0;
        await waitFor(async () => (width = await page.evaluate(() => window.innerWidth)) >= 360, 3000).catch(() => assert.fail(`the page is ${width} px wide`));
    });
} catch {
    failed = true;
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron adaptive layout');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
