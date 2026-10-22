// The sidebar like VS Code's, against the Electron window with Playwright: the activity bar, the Files view with its
// sections (Open Editors, the folder, the Outline, the Timeline), folding and hiding them, their sizes, and the sidebar's
// width. Each of those is a setting the window writes, so a step also reads settings.json.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper, gitIn } from './support.mjs';

const { scratch, notes } = scratchFolder('sidebar');
mkdirSync(join(notes, 'plans'));
writeFileSync(join(notes, 'plans', 'launch.md'), '# Launch\n\n## Goal\n\ntext\n\n## Schedule\n');
writeFileSync(join(notes, 'a.md'), '# Alpha\n');
writeFileSync(join(notes, 'b.md'), '# Beta\n');
const git = gitIn(notes);
git('init', '-q');
git('add', '.');
git('commit', '-q', '-m', 'Draft the launch plan');
writeFileSync(join(notes, 'plans', 'launch.md'), '# Launch\n\n## Goal\n\nmore text\n\n## Schedule\n');
git('commit', '-q', '-am', 'Add the goal text');

const settingsFile = join(scratch, 'config', 'markwork-electron', 'settings.json');
const saved = () => { try { return JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return {}; } };

const { steps, step } = stepper();
const app = await launchApp({ scratch, notes, settings: { welcomed: true } });
let failed = false;
let page;
try {
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    const activity = page.getByRole('navigation', { name: 'Sidebar pages' });
    // Programs says how many are missing in its name, which depends on what the machine has installed.
    const view = name => activity.getByRole('button', name === 'Programs' ? { name: /^Programs/ } : { name, exact: true });
    const files = page.getByRole('complementary', { name: 'Files' });
    const section = id => page.locator(`.section[data-section="${id}"]`);
    const head = id => section(id).locator('.section-head');
    const open = async name => { await page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }).click(); await page.locator('.headerbar .title').getByText(name).waitFor(); };

    await page.getByRole('treeitem', { name: /a\.md/ }).waitFor({ timeout: 15000 });

    await step('the activity bar has the views, Programs, and Preferences; the one shown is pressed, and pressing it closes the sidebar', async () => {
        for (const name of ['Files', 'Search', 'History', 'Pull requests', 'Programs', 'Preferences']) await view(name).waitFor();
        assert.equal(await view('Files').getAttribute('aria-pressed'), 'true');
        await view('Files').click();
        await files.waitFor({ state: 'detached' });
        assert.equal(await view('Files').getAttribute('aria-pressed'), 'false');
        await view('Search').click();
        await page.getByRole('complementary', { name: 'Search' }).waitFor();
        assert.equal(await view('Search').getAttribute('aria-pressed'), 'true');
        await view('Files').click();
        await files.waitFor();
        assert.equal(await page.getByRole('complementary', { name: 'Search' }).count(), 0, 'one view at a time');
    });

    await step('Files has its four sections, and Home and Journal are not in the sidebar any more', async () => {
        for (const id of ['editors', 'folder', 'outline', 'timeline']) await section(id).waitFor();
        assert.equal(await head('editors').getAttribute('aria-expanded'), 'true');
        assert.equal(await head('timeline').getAttribute('aria-expanded'), 'false', 'the Timeline starts folded');
        assert.equal(await files.getByRole('button', { name: 'Home', exact: true }).count(), 0);
        assert.equal(await files.getByRole('button', { name: 'Journal', exact: true }).count(), 0);
    });

    await step('Open Editors lists the open documents, a click selects one, and its close button closes it', async () => {
        await open('a.md');
        await open('b.md');
        const list = page.getByRole('listbox', { name: 'Open Editors' });
        await waitFor(async () => (await list.getByRole('option').allTextContents()).join('|').includes('a.md') && (await list.getByRole('option').count()) >= 2);
        assert.equal((await head('editors').locator('.count').textContent()).trim(), String(await list.getByRole('option').count()));
        assert.equal(await list.getByRole('option', { name: /b\.md/ }).getAttribute('aria-selected'), 'true', 'the active document is selected');
        await list.getByRole('option', { name: /a\.md/ }).click();
        await page.locator('.headerbar .title').getByText('a.md').waitFor();
        assert.equal(await list.getByRole('option', { name: /a\.md/ }).getAttribute('aria-selected'), 'true');
        await list.getByRole('option', { name: /b\.md/ }).getByRole('button', { name: /Close editor b\.md/ }).click();
        await waitFor(async () => (await list.getByRole('option', { name: /b\.md/ }).count()) === 0);
    });

    await step('Outline follows the document, and a section folds and unfolds from its header (and the setting keeps it)', async () => {
        await open('launch.md').catch(async () => { await page.getByRole('treeitem', { name: /plans/ }).click(); await open('launch.md'); });
        const rows = section('outline').locator('.outline .row');
        await waitFor(async () => (await rows.allTextContents()).join('|') === 'Launch|Goal|Schedule');
        await head('outline').click();
        assert.equal(await head('outline').getAttribute('aria-expanded'), 'false');
        assert.equal(await rows.count(), 0, 'a folded section shows nothing');
        await waitFor(() => JSON.parse(saved()['sidebar-sections'] || '{}').outline?.open === false);
        await head('outline').click();
        await rows.first().waitFor();
        await waitFor(() => JSON.parse(saved()['sidebar-sections'] || '{}').outline?.open === true);
    });

    await step('the ⋯ menu hides and shows sections, and Collapse All folds them', async () => {
        const menu = files.getByRole('button', { name: 'Views and More Actions' });
        await menu.click();
        await page.getByRole('menuitemcheckbox', { name: 'Outline' }).click();
        await section('outline').waitFor({ state: 'detached' });
        assert.equal(JSON.parse(saved()['sidebar-sections']).outline.hidden, true);
        await menu.click();
        await page.getByRole('menuitemcheckbox', { name: 'Outline' }).click();
        await section('outline').waitFor();
        await menu.click();
        await page.getByRole('menuitem', { name: 'Collapse All Sections' }).click();
        for (const id of ['editors', 'folder', 'outline', 'timeline']) assert.equal(await head(id).getAttribute('aria-expanded'), 'false', id);
        await head('folder').click();
        await head('editors').click();
    });

    await step('the Timeline lists the commits of the open file once it is unfolded, and the core is told', async () => {
        await head('timeline').click();
        await waitFor(() => saved()['timeline-open'] === true);
        const commits = section('timeline').getByRole('button', { name: /Add the goal text|Draft the launch plan/ });
        await waitFor(async () => (await commits.count()) === 2);
        assert.match((await commits.first().textContent()) ?? '', /Add the goal text/);
        await head('timeline').click();
        await waitFor(() => saved()['timeline-open'] === false);
    });

    await step('the line between two sections is dragged to change their sizes', async () => {
        const before = await section('editors').boundingBox();
        const sash = await page.locator('.section-sash').first().boundingBox();
        await page.mouse.move(sash.x + 100, sash.y + 0.5);
        await page.mouse.down();
        await page.mouse.move(sash.x + 100, sash.y + 60, { steps: 6 });
        await page.mouse.up();
        const after = await section('editors').boundingBox();
        assert.ok(after.height > before.height + 30, `Open Editors grew: ${before.height} → ${after.height}`);
        await waitFor(() => JSON.parse(saved()['sidebar-sections']).editors.size > JSON.parse(saved()['sidebar-sections']).folder.size * 0.5);
    });

    await step('the sidebar edge is dragged to change its width, within limits, and the width is kept', async () => {
        const shell = page.locator('.side-shell');
        const before = (await shell.boundingBox()).width;
        const grip = await page.locator('.side-grip').boundingBox();
        await page.mouse.move(grip.x + 3, grip.y + 300);
        await page.mouse.down();
        await page.mouse.move(grip.x + 103, grip.y + 300, { steps: 6 });
        await page.mouse.up();
        const after = (await shell.boundingBox()).width;
        assert.ok(Math.abs(after - (before + 100)) < 3, `wider by 100: ${before} → ${after}`);
        await waitFor(() => saved()['sidebar-width'] === Math.round(after));
        await page.mouse.move(grip.x + 103, grip.y + 300);
        await page.mouse.down();
        await page.mouse.move(grip.x + 1000, grip.y + 300, { steps: 6 });
        await page.mouse.up();
        assert.equal(Math.round((await shell.boundingBox()).width), 480, 'no wider than 480');
    });

    await step('with the editor split, Open Editors groups the documents by pane', async () => {
        await page.getByRole('button', { name: 'Split Editor Right' }).click();
        await page.locator('.pane').nth(1).waitFor();
        const list = page.getByRole('listbox', { name: 'Open Editors' });
        await waitFor(async () => (await page.locator('.editors .group-title').allTextContents()).join('|') === 'Pane 1|Pane 2');
        assert.ok((await list.getByRole('option').count()) >= 2);
    });
} catch {
    failed = true;
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron sidebar');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
