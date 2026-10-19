// Agents of the GTK window (tests/gui/: harness, agentshost) run against the Electron window with Playwright: the real main
// process, core, and renderer, a real git repository for the project, and a fake agent program (tests/electron-agent.mjs) in
// place of pi. What the core decides is also in tests/unit/protocol.ts. Run with `npm run test:electron`.

import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'markwork-agents-'));
const notes = join(scratch, 'notes');
const project = join(scratch, 'project');
mkdirSync(notes);
mkdirSync(project);
const identity = { GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 'tester@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 'tester@example.com' };
const git = (...args) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim();

git('init', '-q');
writeFileSync(join(project, 'readme.md'), '# Project\n');
git('add', '.');
git('commit', '-q', '-m', 'First');
writeFileSync(join(notes, 'board.md'), '---\nlayout: board\n---\n\n## Todo\n\n- [ ] Write the notes\n\n## Done\n\n- [x] Old\n');

async function waitFor(condition, ms = 10000) {
    for (const end = Date.now() + ms; Date.now() < end;) { if (await condition()) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail('timed out');
}

const steps = [];
async function step(name, run) {
    try {
        await run();
        steps.push(`  ✓ ${name}`);
        console.log(steps.at(-1));
    } catch (e) {
        steps.push(`  ✗ ${name}\n    ${String(e?.message ?? e).split('\n').join('\n    ')}`);
        console.log(steps.at(-1));
        throw e;
    }
}

const app = await electron.launch({
    args: [repo, notes], cwd: repo,
    env: {
        ...process.env, ...identity, XDG_CONFIG_HOME: join(scratch, 'config'),
        MARKWORK_PICK_FOLDER: project,   // the answer of the folder chooser
        MARKWORK_TEST_HARNESS: pathToFileURL(join(repo, 'tests/electron-agent.mjs')).href,
    },
});
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const card = () => page.getByRole('group', { name: 'Write the notes' });
    const menuItem = name => page.getByRole('menuitem', { name });
    const openMenu = async () => { await card().click({ button: 'right' }); await page.getByRole('menu').waitFor(); };
    const badge = () => card().locator('.chip.agent');

    await step('the board opens and a card offers to be worked on by an agent', async () => {
        await page.getByRole('treeitem', { name: /board\.md/ }).waitFor({ timeout: 15000 });
        await page.getByRole('treeitem', { name: /board\.md/ }).click();
        await card().waitFor();
        await openMenu();
        await menuItem('Work on it with pi').waitFor();
        assert.equal(await menuItem('Stop pi').count(), 0, 'nothing runs yet');
        await page.keyboard.press('Escape');
    });

    await step('assigning asks for the project folder, starts the run, and the card shows that it waits for an answer', async () => {
        await openMenu();
        await menuItem('Work on it with pi').click();
        await badge().filter({ hasText: 'waiting for an answer' }).waitFor({ timeout: 15000 });
        await card().getByText('#project/project').waitFor();   // the card remembers its project; the board is saved with the document
    });

    await step('the log of the run opens in a window of its own and closes with Escape', async () => {
        await openMenu();
        await menuItem('View pi Log').click();
        const log = page.getByRole('dialog', { name: /pi Log/ });
        await log.getByRole('tree', { name: 'Steps' }).waitFor();
        await log.getByRole('treeitem').first().waitFor();
        await page.keyboard.press('Escape');
        await log.waitFor({ state: 'detached' });
    });

    await step('the agent\'s question is a dialog; Later leaves it waiting, Allow answers it and the run finishes', async () => {
        await openMenu();
        await menuItem('Answer pi…').click();
        const ask = page.getByRole('dialog', { name: 'Run the tests?' });
        await ask.getByText('npm test').waitFor();
        await ask.getByRole('button', { name: 'Later' }).click();
        await ask.waitFor({ state: 'detached' });
        await badge().filter({ hasText: 'waiting for an answer' }).waitFor();
        await openMenu();
        await menuItem('Answer pi…').click();
        await page.getByRole('dialog', { name: 'Run the tests?' }).getByRole('button', { name: 'Allow' }).click();
        await badge().filter({ hasText: 'done' }).waitFor({ timeout: 15000 });
    });

    await step('Review Changes opens the worktree: the files with a box each, the diff, and a comment on a line', async () => {
        await openMenu();
        await menuItem('Review Changes').click();
        const files = page.getByRole('navigation', { name: 'Changed files' });
        await files.getByRole('button', { name: /notes\.md/ }).waitFor({ timeout: 15000 });
        assert.equal(await files.getByLabel('Take notes.md').isChecked(), true);
        const line = page.locator('pre.diff .line.add', { hasText: 'Written by the agent' });
        await line.waitFor();
        await line.hover();
        await line.getByRole('button', { name: /Comment on line/ }).click();
        await page.getByLabel('Comment', { exact: true }).fill('Make it longer');
        await page.getByRole('button', { name: 'Add Comment' }).click();
        await page.getByRole('button', { name: 'Reply (1)…' }).waitFor();
        await page.getByRole('tab', { name: 'Summary' }).click();
        await page.getByText('Commands it ran').waitFor();
    });

    await step('Reply opens the comments as a message for the agent; Cancel sends nothing', async () => {
        await page.getByRole('button', { name: 'Reply (1)…' }).click();
        const reply = page.getByRole('dialog', { name: 'Reply to pi' });
        await waitFor(async () => (await reply.getByRole('textbox').inputValue()).includes('Make it longer'));
        await reply.getByRole('button', { name: 'Cancel' }).click();
        await reply.waitFor({ state: 'detached' });
    });

    await step('merging asks first; a yes puts the work into the project and the review closes', async () => {
        await page.getByRole('button', { name: 'Merge', exact: true }).click();
        const ask = page.getByRole('alertdialog');
        await ask.getByText(/Merge “Write the notes” into/).waitFor();
        await ask.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(existsSync(join(project, 'notes.md')), false, 'a no merges nothing');
        await page.getByRole('button', { name: 'Merge', exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Merge', exact: true }).click();
        await waitFor(() => existsSync(join(project, 'notes.md')));
        assert.match(readFileSync(join(project, 'notes.md'), 'utf8'), /Written by the agent/);
        await page.getByRole('button', { name: 'Close the review' }).waitFor({ state: 'detached' });
        await card().waitFor();
    });

    await step('Preferences → Agents lists the project, changes its isolation, and adds and removes a machine', async () => {
        await page.getByRole('button', { name: 'Main Menu' }).click();
        await page.getByRole('menuitem', { name: /Preferences/ }).click();
        const prefs = page.getByRole('dialog', { name: 'Preferences' });
        await prefs.getByRole('tab', { name: 'Agents' }).click();
        await prefs.getByRole('button', { name: /project/ }).click();
        await prefs.getByText('A worktree per card').waitFor();
        const slots = prefs.getByLabel('Cards at the same time');
        await slots.fill('3');
        await waitFor(() => /slots\\?":3/.test(readFileSync(join(scratch, 'config', 'markwork-electron', 'settings.json'), 'utf8')));
        await prefs.getByRole('button', { name: '← Projects' }).click();
        await prefs.getByRole('button', { name: 'Add Machine…' }).click();
        const add = page.getByRole('dialog', { name: 'Add a Machine' });
        await add.getByLabel('Name').fill('build box');
        assert.equal(await add.getByRole('button', { name: 'Add', exact: true }).isDisabled(), true, 'a name with a space');
        await add.getByLabel('Name').fill('box');
        await add.getByLabel('SSH target').fill('me@box.example.org');
        await add.getByRole('button', { name: 'Add', exact: true }).click();
        await prefs.getByRole('button', { name: 'Remove box' }).waitFor();
        await prefs.getByRole('combobox', { name: 'Run agents' }).selectOption('box');
        await prefs.getByRole('button', { name: 'Remove box' }).click();
        await prefs.getByRole('button', { name: 'Remove box' }).waitFor({ state: 'detached' });
        assert.equal(await prefs.getByRole('combobox', { name: 'Run agents' }).inputValue(), '', 'the choice goes with the machine');
    });
} catch (e) {
    failed = true;
    steps.push(`  ! ${String(e?.message ?? e).split('\n')[0]}`);
    if (page) await page.screenshot({ path: join(scratch, 'failure.png') }).catch(() => {});
} finally {
    // A window closed with an agent at work asks first, so the app is ended from outside.
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    console.log(`Electron agents (${scratch})\n${steps.join('\n')}`);
    process.exit(failed ? 1 : 0);
}
