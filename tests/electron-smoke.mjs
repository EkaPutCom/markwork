// A smoke test of the Electron window, driven by Playwright: the real main process, core, and renderer, on a copy of a
// folder of notes. It checks that the pieces are connected, not every behaviour (tests/unit/protocol.ts does that without
// a window). Run with `npm run test:electron` (built first, in Xvfb).

import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'markwork-electron-'));
const notes = join(scratch, 'notes');
mkdirSync(notes);
writeFileSync(join(notes, 'note.md'), '# Note\n\nhello\n');
writeFileSync(join(notes, 'board.md'), '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n- [ ] Two\n\n## Done\n\n- [x] Old\n');

const steps = [];
async function step(name, run) {
    try {
        await run();
        steps.push(`  ✓ ${name}`);
    } catch (e) {
        steps.push(`  ✗ ${name}\n    ${String(e?.message ?? e).split('\n').join('\n    ')}`);
        throw e;
    }
}

const app = await electron.launch({
    args: [repo, notes],
    cwd: repo,
    env: {
        ...process.env,
        XDG_CONFIG_HOME: join(scratch, 'config'),        // settings of this run only
        MARKWORK_CHOOSE_FILE: join(notes, 'saved-as'),   // the answer of the file chooser
    },
});
let failed = false;
try {
    const page = await app.firstWindow();
    const editor = page.locator('.cm-content');
    const title = page.locator('.headerbar .title');

    await step('the window starts and lists the folder', async () => {
        await page.getByRole('treeitem', { name: /note\.md/ }).waitFor({ timeout: 15000 });
        await page.getByRole('treeitem', { name: /board\.md/ }).waitFor();
    });

    await step('a file opens, typing reaches the core, and Ctrl+S writes it', async () => {
        await page.getByRole('treeitem', { name: /note\.md/ }).click();
        await assert.doesNotReject(title.getByText('note.md').waitFor());
        await editor.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type('world\n');
        await page.keyboard.press('Control+s');
        await page.waitForFunction(() => !document.querySelector('.headerbar .title')?.textContent?.startsWith('•'));
        assert.equal(readFileSync(join(notes, 'note.md'), 'utf8'), '# Note\n\nhello\nworld\n');
    });

    await step('the counts at the foot are the text\'s', async () => {
        await page.locator('.statusbar').getByText(/words/).waitFor();
    });

    await step('a board shows its counts and the layout button, and text commands no longer apply', async () => {
        await page.getByRole('treeitem', { name: /board\.md/ }).click();
        await page.locator('.statusbar').getByText('2 lists · 3 cards').waitFor();
        await page.locator('.headerbar button[aria-pressed=true]', { hasText: 'Board' }).waitFor();
        await page.keyboard.press('Control+Shift+P');
        await page.locator('.palette input').fill('bold');
        await page.locator('.palette li.none').waitFor();
        await page.keyboard.press('Escape');
    });

    await step('Ctrl+Shift+D switches to dark, and the setting is the core\'s', async () => {
        const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        await page.keyboard.press('Control+Shift+D');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), before);
    });

    await step('a new document is saved where the file chooser says', async () => {
        await page.keyboard.press('Control+n');
        await editor.click();
        await page.keyboard.type('# Saved as\n');
        await page.keyboard.press('Control+Shift+S');
        await title.getByText('saved-as.md').waitFor();
        assert.ok(existsSync(join(notes, 'saved-as.md')));
        assert.equal(readFileSync(join(notes, 'saved-as.md'), 'utf8'), '# Saved as\n');
    });

    await step('closing an unsaved document asks in the window\'s dialog, and Cancel keeps it', async () => {
        await page.keyboard.press('Control+n');
        await editor.click();
        await page.keyboard.type('unsaved');
        await page.keyboard.press('Control+w');
        const dialog = page.getByRole('alertdialog');
        await dialog.getByText('Save Changes?').waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
        await editor.getByText('unsaved').waitFor();
    });
} catch {
    failed = true;
} finally {
    await app.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron window');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
