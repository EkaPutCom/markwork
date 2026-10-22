// The split editor, against the Electron window with Playwright: splitting, one document in two panes, the focus, a tab
// dragged to an edge, a file dragged from the sidebar, a pane's own Visual / Markdown, a board in a pane, resizing, and
// closing. The layout operations themselves are tests/unit/panes.ts.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('panes');
writeFileSync(join(notes, 'a.md'), '# Alpha\n\nfirst text\n');
writeFileSync(join(notes, 'b.md'), '# Beta\n\nsecond text\n');
writeFileSync(join(notes, 'board.md'), '---\nlayout: board\n---\n\n## Todo\n\n- [ ] One\n- [ ] Two\n\n## Done\n\n- [x] Old\n');
writeFileSync(join(notes, 'c.md'), '# Gamma\n\nthird text\n');

const { steps, step } = stepper();
const app = await launchApp({ scratch, notes });
let failed = false;
let page;
try {
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    const panes = page.locator('.pane');
    const title = page.locator('.headerbar .title');
    // The text of the editor of the n-th pane (from 0), and typing into it.
    const textOf = n => panes.nth(n).locator('.cm-content').evaluate(el => el.cmTile.view.state.doc.toString());
    const putCursor = (n, at) => panes.nth(n).locator('.cm-content').evaluate((el, pos) => { const v = el.cmTile.view; v.dispatch({ selection: { anchor: pos } }); v.focus(); }, at);
    const shown = n => panes.nth(n).getByRole('tab', { selected: true }).textContent();
    const open = async name => { await page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }).click(); await title.getByText(name).waitFor(); };

    await page.getByRole('treeitem', { name: /a\.md/ }).waitFor({ timeout: 15000 });
    await open('a.md');
    await open('b.md');

    await step('one pane looks as before; the header split button makes a second with the same document', async () => {
        assert.equal(await panes.count(), 1);
        assert.equal(await page.locator('.pane-bar').count(), 0, 'no pane bar while there is one pane');
        await page.getByRole('button', { name: 'Split Editor Right' }).click();
        await waitFor(async () => (await panes.count()) === 2);
        assert.equal(await page.locator('.pane-bar').count(), 2, 'each pane has its own bar');
        assert.deepEqual([await shown(0), await shown(1)].map(t => t.trim()), ['b.md', 'b.md']);
        assert.equal(await page.locator('.headerbar .mode-switch').count(), 0, 'the Visual / Markdown switch is in the panes now');
        assert.equal(await page.locator('.pane.current').count(), 1);
    });

    await step('a document in two panes is one document: typing in one is in the other, and Save writes it once', async () => {
        const end = (await textOf(0)).length;
        await putCursor(0, end);
        await page.keyboard.type('X');
        await waitFor(async () => (await textOf(1)).endsWith('X'));
        assert.equal(await textOf(0), await textOf(1));
        await putCursor(1, 2);   // after the hidden "# " of the heading, which the cursor does not enter
        await page.keyboard.type('Y');
        await waitFor(async () => (await textOf(0)).startsWith('# YBeta'));
        await page.locator('.headerbar .state', { hasText: 'Unsaved' }).waitFor();
        await page.keyboard.press('ControlOrMeta+s');
        await page.locator('.headerbar .state', { hasText: /^Saved$/ }).waitFor();
        assert.equal(readFileSync(join(notes, 'b.md'), 'utf8'), await textOf(0));
        assert.equal(await page.locator('.pane-bar .tab .dot').count(), 0, 'no unsaved mark left in either pane');
    });

    await step('each pane has its own tabs: another document in the second pane, and the focus follows a click', async () => {
        await panes.nth(1).getByRole('tab', { name: /a\.md/ }).click().catch(() => {});
        // The second pane was made from b.md alone: a.md is opened into it from the sidebar.
        await page.getByRole('treeitem', { name: /a\.md/ }).dragTo(panes.nth(1).locator('.pane-body'), { targetPosition: { x: 200, y: 200 } });
        await waitFor(async () => (await shown(1)).trim() === 'a.md');
        assert.equal((await shown(0)).trim(), 'b.md', 'the first pane did not change');
        await title.getByText('a.md').waitFor();
        await panes.nth(0).locator('.cm-content').click();
        await title.getByText('b.md').waitFor();
        assert.equal(await page.locator('.pane.current').getAttribute('data-pane'), await panes.nth(0).getAttribute('data-pane'));
    });

    await step('a tab dragged to the edge of a pane makes a new pane', async () => {
        const tab = panes.nth(0).getByRole('tab', { name: /b\.md/ });
        const t = await tab.boundingBox(), target = await panes.nth(1).boundingBox();
        await page.mouse.move(t.x + 20, t.y + 10);
        await page.mouse.down();
        await page.mouse.move(t.x + 60, t.y + 40, { steps: 4 });
        await page.mouse.move(target.x + target.width - 40, target.y + 300, { steps: 10 });
        // A dragover comes only now and then, so the pointer keeps moving at the edge until the zone is the one asked for.
        await waitFor(async () => {
            await page.mouse.move(target.x + target.width - 40, target.y + 300, { steps: 2 });
            await page.mouse.move(target.x + target.width - 38, target.y + 302, { steps: 2 });
            return (await page.locator('.pane-zone span').textContent().catch(() => null)) === 'Split right';
        });
        await page.mouse.up();
        await waitFor(async () => (await panes.count()) === 3);
        assert.equal((await shown(2)).trim(), 'b.md');
    });

    await step('a file dragged from the sidebar to an edge opens in a new pane', async () => {
        const target = await panes.nth(0).boundingBox();
        await page.getByRole('treeitem', { name: /c\.md/ }).dragTo(panes.nth(0), { targetPosition: { x: 10, y: target.height / 2 } });
        await waitFor(async () => (await panes.count()) === 4);
        await waitFor(async () => (await shown(0)).trim() === 'c.md');
        await waitFor(async () => (await textOf(0)) === '# Gamma\n\nthird text\n');
    });

    await step('a pane has its own Visual / Markdown, and a board is drawn in its pane', async () => {
        const mode = n => panes.nth(n).getByRole('group', { name: 'Editing mode' });
        await mode(0).getByRole('button', { name: 'Markdown' }).click();
        await waitFor(async () => (await panes.nth(0).locator('.cm-editor.cm-source').count()) === 1);
        assert.equal(await panes.nth(1).locator('.cm-editor.cm-source').count(), 0, 'the other pane is still visual');
        assert.equal(await panes.nth(0).getByRole('toolbar', { name: 'Formatting' }).count(), 0, 'raw text has no toolbar');
        assert.equal(await panes.nth(1).getByRole('toolbar', { name: 'Formatting' }).count(), 1, 'the visual pane keeps its own');
        await mode(0).getByRole('button', { name: 'Visual' }).click();
        await waitFor(async () => (await panes.nth(0).locator('.cm-editor.cm-source').count()) === 0);
        await page.getByRole('treeitem', { name: /board\.md/ }).dragTo(panes.nth(1).locator('.pane-body'), { targetPosition: { x: 200, y: 200 } });
        await panes.nth(1).locator('.board').waitFor();
        assert.equal(await panes.nth(0).locator('.board').count(), 0);
        assert.equal(await panes.nth(1).getByRole('group', { name: 'Editing mode' }).getByRole('button', { name: 'Visual' }).getAttribute('aria-pressed'), 'true');
    });

    await step('the line between two panes is dragged to resize them', async () => {
        const before = await panes.nth(0).boundingBox();
        const sash = await page.locator('.sash.vertical').first().boundingBox();
        await page.mouse.move(sash.x + 0.5, sash.y + 200);
        await page.mouse.down();
        await page.mouse.move(sash.x + 80, sash.y + 200, { steps: 6 });
        await page.mouse.up();
        const after = await panes.nth(0).boundingBox();
        assert.ok(after.width > before.width + 40, `the first pane grew: ${before.width} → ${after.width}`);
    });

    await step('closing a tab keeps a document that another pane shows; closing a pane joins its tabs to the one before', async () => {
        const count = await panes.count();
        const bPanes = await page.getByRole('tab', { name: /b\.md/ }).count();
        assert.ok(bPanes >= 2, 'b.md is a tab of two panes');
        await panes.nth(count - 1).getByRole('tab', { name: /b\.md/ }).getByRole('button', { name: /Close b\.md/ }).click();
        await waitFor(async () => (await page.getByRole('tab', { name: /b\.md/ }).count()) === bPanes - 1);
        assert.ok((await page.getByRole('tab', { name: /b\.md/ }).count()) >= 1, 'the document is still open');
        const n = await panes.count();
        await panes.nth(n - 1).getByRole('button', { name: 'Pane actions' }).click();
        await page.getByRole('menuitem', { name: 'Close Pane' }).click();
        await waitFor(async () => (await panes.count()) === n - 1);
        await panes.nth(0).getByRole('button', { name: 'Pane actions' }).click();
        await page.getByRole('menuitem', { name: 'Join All Panes' }).click();
        await waitFor(async () => (await panes.count()) === 1);
        assert.equal(await page.locator('.pane-bar').count(), 0, 'back to the single-pane look');
        await page.locator('.headerbar .mode-switch').waitFor();
        assert.ok((await page.getByRole('tab').count()) >= 3, 'every tab is in the one pane');
    });

    await step('the keyboard splits: Ctrl+Alt+\\ to the right and Ctrl+Alt+Shift+\\ down, and the next tab stays in the pane', async () => {
        await panes.nth(0).locator('.cm-content').click();
        await page.keyboard.press('ControlOrMeta+Alt+\\');
        await waitFor(async () => (await panes.count()) === 2);
        await page.keyboard.press('ControlOrMeta+Alt+Shift+\\');
        await waitFor(async () => (await panes.count()) === 3);
        // The first pane kept all the tabs; the panes made by splitting have one each.
        await panes.nth(0).locator('.cm-content').click();
        const before = await shown(0);
        await page.keyboard.press('ControlOrMeta+Tab');
        await waitFor(async () => (await shown(0)).trim() !== before.trim());
        assert.equal(await panes.count(), 3);
        assert.equal(await panes.evaluateAll(els => els.findIndex(e => e.classList.contains('current'))), 0, 'the focus stayed in the pane');
        assert.equal((await shown(1)).trim(), (await shown(2)).trim(), 'the other panes did not change');
    });
} catch {
    failed = true;
    const tabs = await page?.getByRole('tab').evaluateAll(els => els.map(e => `${e.getAttribute('aria-selected') === 'true' ? '*' : ''}${e.textContent}`)).catch(() => []);
    console.error(`tabs: ${JSON.stringify(tabs)}`);
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron panes');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
