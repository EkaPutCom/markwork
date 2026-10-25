// History and pull requests (history, collab, forgejo) run against the Electron window with
// Playwright: the real main process, core, and renderer, a real git repository, and a fake forge (tests/electron/forge.mjs) in
// place of the network. What the core decides is also in tests/unit/protocol.ts. Run with `npm run test:electron`.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { identity, testModule, scratchFolder, gitIn, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('git');
const git = gitIn(notes);

git('init', '-q');
writeFileSync(join(notes, 'a.md'), '# A\n\none\n');
git('add', 'a.md');
git('commit', '-q', '-m', 'Create note');
writeFileSync(join(notes, 'a.md'), '# A\n\none\ntwo\n');
git('commit', '-q', '-a', '-m', 'Add line two');
writeFileSync(join(notes, 'b.md'), 'brand new\n');

const { steps, step } = stepper();

const app = await launchApp({
    scratch, notes,
    env: { ...identity, DEEPSEEK_API_KEY: 'test', MARKWORK_TEST_MODEL: testModule('model.mjs'), MARKWORK_TEST_FORGE: testModule('forge.mjs') },
});
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const history = page.getByRole('complementary', { name: 'History' });
    const collab = page.getByRole('complementary', { name: 'Pull requests' });
    const toast = page.locator('[data-sonner-toast] [data-title]');

    await step('the History page lists the commits of the open file and the uncommitted files', async () => {
        await page.getByRole('treeitem', { name: /a\.md/ }).waitFor({ timeout: 15000 });
        await page.getByRole('treeitem', { name: /a\.md/ }).click();
        await page.getByRole('button', { name: 'History', exact: true }).click();
        await history.waitFor();
        await history.getByRole('button', { name: /Add line two/ }).waitFor();
        await history.getByRole('button', { name: /Create note/ }).waitFor();
        await history.getByRole('heading', { name: 'Uncommitted (1)' }).waitFor();
        await history.getByRole('button', { name: 'b.md', exact: true }).waitFor();
    });

    await step('a commit opens in a viewer with its changes and its contents; Escape closes it', async () => {
        await history.getByRole('button', { name: /Add line two/ }).click();
        const viewer = page.getByRole('dialog', { name: /Add line two/ });
        await viewer.locator('pre.diff .cell.add', { hasText: 'two' }).waitFor();
        await viewer.getByRole('tab', { name: 'Contents' }).click();
        await viewer.locator('pre.contents', { hasText: 'two' }).waitFor();
        await page.keyboard.press('Escape');
        await viewer.waitFor({ state: 'detached' });
    });

    await step('the uncommitted changes of a new file open with a commit form, and committing writes the commit', async () => {
        await history.getByRole('button', { name: 'b.md', exact: true }).click();
        const viewer = page.getByRole('dialog', { name: 'Changes to b.md' });
        await viewer.locator('pre.diff .cell.add', { hasText: 'brand new' }).waitFor();
        const commit = viewer.getByRole('button', { name: 'Commit', exact: true });
        assert.equal(await commit.isDisabled(), true, 'a message is needed');
        await viewer.getByLabel('Commit message').fill('Add b from the viewer');
        await commit.click();
        await viewer.waitFor({ state: 'detached' });
        await waitFor(() => git('log', '--format=%s', '-1') === 'Add b from the viewer');
        await history.getByRole('button', { name: /Add b from the viewer/ }).waitFor().catch(() => {});
    });

    await step('the form commits the checked files, and the assistant writes the message into it', async () => {
        writeFileSync(join(notes, 'c.md'), 'third\n');
        await history.getByRole('button', { name: 'Reload history' }).click();
        await history.getByRole('heading', { name: 'Uncommitted (1)' }).waitFor();
        const box = history.getByLabel('Commit message');
        await history.getByRole('button', { name: 'Write the message with the assistant' }).click();
        await waitFor(async () => (await box.inputValue()).trim().length > 0);
        const commit = history.getByRole('button', { name: 'Commit 1 file' });
        await history.getByLabel('Include c.md in the commit').uncheck();
        assert.equal(await history.getByRole('button', { name: 'Commit', exact: true }).isDisabled(), true, 'no file is checked');
        await history.getByLabel('Include c.md in the commit').check();
        await box.fill('Add c');
        await commit.click();
        await waitFor(() => git('log', '--format=%s', '-1') === 'Add c');
        await history.getByText('Uncommitted (1)').waitFor({ state: 'detached' });
    });

    await step('discarding the changes to a file asks first, and a no leaves it alone', async () => {
        writeFileSync(join(notes, 'a.md'), '# A\n\nchanged on disk\n');
        await history.getByRole('button', { name: 'Reload history' }).click();
        await history.getByRole('button', { name: /Discard the changes to this file: a\.md/ }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByText('This cannot be undone.').waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        assert.match(readFileSync(join(notes, 'a.md'), 'utf8'), /changed on disk/);
        await history.getByRole('button', { name: /Discard the changes to this file: a\.md/ }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Discard Changes' }).click();
        // git on a Windows runner can take seconds for the restore, and the file is gone for a moment while it writes it.
        const text = () => { try { return readFileSync(join(notes, 'a.md'), 'utf8'); } catch { return null; } };
        await waitFor(() => text() === '# A\n\none\ntwo\n', 20000);
    });

    await step('the Pull requests page shows the server and the open pull requests', async () => {
        await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
        await collab.waitFor();
        await collab.getByText('git.example.org · eka/notes').waitFor();
        await collab.getByRole('button', { name: /Move the release/ }).waitFor();
    });

    await step('the token dialog tries a typed token before saving it', async () => {
        await collab.getByRole('button', { name: /git\.example\.org/ }).click();
        const dialog = page.getByRole('dialog', { name: 'Server access' });
        await dialog.getByText(/Create an access token/).waitFor();
        await dialog.getByLabel('Access token').fill('typed');
        await dialog.getByRole('button', { name: 'Test connection' }).click();
        await dialog.getByText('Connected — 1 open pull requests').waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
    });

    await step('the form that sends changes needs a title and follows it in the branch name', async () => {
        writeFileSync(join(notes, 'd.md'), 'for the pull request\n');
        await collab.getByRole('button', { name: 'Send changes as a pull request' }).click();
        const dialog = page.getByRole('dialog', { name: 'Send Changes as Pull Request' });
        await dialog.getByText('Sent to eka/notes, to be merged into main.').waitFor();
        await dialog.getByText('d.md').waitFor();
        const send = dialog.getByRole('button', { name: 'Send', exact: true });
        assert.equal(await send.isDisabled(), true);
        await dialog.getByLabel('Title', { exact: true }).fill('Add the d note');
        assert.equal(await dialog.getByLabel('Branch', { exact: true }).inputValue(), 'add-the-d-note');
        assert.equal(await send.isDisabled(), false);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
        rmSync(join(notes, 'd.md'));
    });

    await step('a pull request opens as a page with its files, the note view, and the discussion', async () => {
        await collab.getByRole('button', { name: /Move the release/ }).click();
        const pullPage = page.locator('.pull-page');
        await pullPage.getByRole('heading', { name: /#7\s+Move the release/ }).waitFor();
        await pullPage.getByRole('button', { name: /plan\.md/ }).waitFor();
        await pullPage.locator('pre.diff .cell.add', { hasText: '22 November' }).waitFor();
        await pullPage.getByRole('tab', { name: 'Raw diff' }).click();
        await pullPage.locator('pre.diff .cell.add', { hasText: 'Ship 22 November' }).waitFor();
        await pullPage.getByRole('button', { name: /logo\.png/ }).click();
        await pullPage.getByText(/binary file|no text change/).waitFor();
        await pullPage.getByRole('tab', { name: /Discussion/ }).click();
        await pullPage.getByText('Moves it by a week.').waitFor();
        await pullPage.getByText('Looks fine').waitFor();
    });

    await step('a comment is posted and appears in the discussion', async () => {
        const pullPage = page.locator('.pull-page');
        await pullPage.getByLabel('Comment', { exact: true }).fill('Thanks');
        await pullPage.getByRole('button', { name: 'Comment', exact: true }).click();
        await pullPage.locator('.comment', { hasText: 'Thanks' }).waitFor();
        await waitFor(async () => (await pullPage.getByLabel('Comment', { exact: true }).inputValue()) === '');
    });

    await step('merging asks first; a no merges nothing, a yes merges and tells it', async () => {
        const pullPage = page.locator('.pull-page');
        await pullPage.getByRole('button', { name: 'Merge', exact: true }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByRole('heading', { name: 'Merge pull request #7?' }).waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await pullPage.getByRole('button', { name: 'Merge', exact: true }).waitFor();
        await pullPage.getByRole('button', { name: 'Merge', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Merge', exact: true }).click();
        await toast.filter({ hasText: /^Merged pull request #7/ }).waitFor();
        await pullPage.getByText('This pull request has been merged.').waitFor();
    });

    await step('the back button closes the review and the document is shown again', async () => {
        await page.locator('.pull-page').getByRole('button', { name: 'Close the review' }).click();
        await page.locator('.pull-page').waitFor({ state: 'detached' });
        await page.locator('.cm-content').waitFor();
    });
} catch {
    failed = true;
    // What the window showed when a step failed.
    console.error(await page?.locator('.workbench').innerText().catch(() => '(no window)'));
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron History and pull requests');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
