// The UI Gallery (docs/design/design-system.md, stage 4), against the Electron window with Playwright: it is there only
// in dev mode; it shows every part of the design system, each primitive answering, light and dark; and its sample
// document opens as a copy with every element of the editor drawn.

import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('ui-gallery');
writeFileSync(join(notes, 'plan.md'), '# Plan\n');
const settings = { welcomed: true };

const { steps, step } = stepper({ echo: true });
setTimeout(() => { console.log('  ✗ the UI Gallery test did not end within 2 minutes'); process.exit(1); }, 120_000).unref();
let failed = false;

const SECTIONS = ['Text sizes', 'Colors', 'Button and IconButton', 'Badge and Kbd', 'Input, Textarea, InputGroup, Label',
    'Checkbox, Switch, RadioGroup, Select, Toggle', 'Menus, Toast, Popover, Tooltip, Dialog, AlertDialog', 'Tabs, Card, Collapsible, Separator',
    'Command', 'Status, working, empty, error'];
// What the sample document draws in the visual editor: one of each.
const EDITOR_PARTS = ['.cm-md-h1', '.cm-md-checkbox', '.cm-md-codebox', '.cm-md-table-grid', '.cm-md-diagram', '.cm-md-picture', '.cm-md-picture-missing', '.cm-md-conflict-bar'];

async function run(env, test) {
    const app = await launchApp({ scratch, notes, settings, env });
    try {
        const page = await app.firstWindow();
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.getByRole('treeitem', { name: /plan\.md/ }).waitFor();
        await test(page, app);
    } finally {
        await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
        try { app.process().kill(); } catch { /* already gone */ }
    }
}

try {
    await run({}, async page => {
        await step('a normal start has no gallery: Ctrl+Alt+G does nothing', async () => {
            await page.keyboard.press('Control+Alt+g');
            await page.waitForTimeout(300);   // a pause to show that nothing happens
            assert.equal(await page.getByRole('region', { name: 'UI Gallery' }).count(), 0);
        });
    });

    await run({ MARKWORK_DEV: '1', MARKWORK_INSPECT_QUIET: '1' }, async (page, app) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        // The sample's missing picture is meant to fail to load; nothing else may.
        page.on('console', m => { if (m.type() === 'error' && !m.location().url.includes('not-there.png')) errors.push(m.text()); });
        const gallery = page.getByRole('region', { name: 'UI Gallery' });

        await step('dev mode: Ctrl+Alt+G opens the gallery with every part of the design system', async () => {
            await page.keyboard.press('Control+Alt+g');
            await gallery.waitFor();
            for (const name of SECTIONS) await gallery.getByRole('heading', { name, exact: true }).waitFor();
            await gallery.getByRole('button', { name: 'Search (icon-sm)' }).waitFor();
            await gallery.getByRole('switch').first().waitFor();
            await gallery.getByRole('alert').first().waitFor();
        });

        await step('the primitives answer: a menu, a select, a tooltip, a dialog', async () => {
            await gallery.getByRole('button', { name: 'Dropdown menu' }).click();
            await page.getByRole('menuitem', { name: /New Document/ }).waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('menuitem', { name: /New Document/ }).waitFor({ state: 'detached' });
            await gallery.getByRole('combobox', { name: 'Layout' }).click();
            await page.getByRole('option', { name: 'Table' }).click();
            await gallery.getByRole('combobox', { name: 'Layout' }).getByText('Table').waitFor();
            await gallery.getByRole('button', { name: 'Tooltip on hover and focus' }).hover();
            await page.getByRole('tooltip').getByText('Tooltip on hover and focus').waitFor();
            await gallery.getByRole('button', { name: 'AlertDialog' }).click();
            const ask = page.getByRole('alertdialog', { name: /Discard the changes/ });
            await ask.getByRole('button', { name: 'Discard Changes' }).waitFor();
            await ask.getByRole('button', { name: 'Cancel' }).click();
            await ask.waitFor({ state: 'detached' });
            await gallery.waitFor();
        });

        await step('the theme switches between light and dark, and the page follows', async () => {
            const ground = () => gallery.evaluate(el => getComputedStyle(el).backgroundColor);
            // The window starts on the system's theme, light under Xvfb.
            await gallery.getByRole('radio', { name: 'Light', checked: true }).waitFor();
            const light = await ground();
            await gallery.getByRole('radio', { name: 'Dark' }).click();
            await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
            await gallery.getByRole('radio', { name: 'Dark', checked: true }).waitFor();
            assert.notEqual(await ground(), light);
            await gallery.getByRole('radio', { name: 'Light' }).click();
            await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
            assert.equal(await ground(), light);
        });

        await step('Open Sample Document opens a copy with every element of the editor drawn', async () => {
            await gallery.getByRole('button', { name: 'Open Sample Document' }).click();
            await gallery.waitFor({ state: 'detached' });
            await page.locator('.headerbar .title').getByText('ui-gallery.md').waitFor();
            await page.locator('.cm-editor .cm-md-h1').first().waitFor();
            // CodeMirror draws only the lines near the screen, so the document is scrolled through, a screen at a time.
            const seen = await page.evaluate(async parts => {
                const scroller = document.querySelector('.cm-scroller');
                const found = new Set();
                for (let top = 0; ; top += scroller.clientHeight / 2) {
                    scroller.scrollTop = top;
                    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                    for (const part of parts) if (scroller.querySelector(part)) found.add(part);
                    if (top >= scroller.scrollHeight) return [...found];
                }
            }, EDITOR_PARTS);
            assert.deepEqual(EDITOR_PARTS.filter(part => !seen.includes(part)), [], 'every element of the editor is drawn');
            // The copy is in Electron's data folder for the app (outside the scratch folder on macOS and Windows), with its
            // pictures, not in the repository.
            const copy = join(await app.evaluate(({ app }) => app.getPath('userData')), 'ui-gallery');
            assert.ok(existsSync(join(copy, 'ui-gallery.md')), 'the copy is in the data folder');
            assert.ok(existsSync(join(copy, 'images', 'example.png')), 'with its pictures');
            rmSync(copy, { recursive: true, force: true });
        });

        await step('Ctrl+Alt+G opens it again and closes it', async () => {
            await page.keyboard.press('Control+Alt+g');
            await gallery.waitFor();
            await page.keyboard.press('Control+Alt+g');
            await gallery.waitFor({ state: 'detached' });
        });

        await step('no page or console error on the way', async () => {
            assert.deepEqual(errors, []);
        });
    });
} catch {
    failed = true;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
console.log(`UI Gallery: ${steps.length} steps`);
process.exit(failed ? 1 : 0);
