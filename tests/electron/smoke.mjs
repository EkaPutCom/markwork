// A smoke test of the Electron window, driven by Playwright: the real main process, core, and renderer, on a copy of a
// folder of notes. It checks that the pieces are connected, not every behaviour (tests/unit/protocol.ts does that without
// a window). Run with `npm run test:electron` (built first, in Xvfb).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('electron');
writeFileSync(join(notes, 'note.md'), '# Note\n\nhello\n');
writeFileSync(join(notes, 'board.md'), '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n- [ ] Two\n\n## Done\n\n- [x] Old\n');

writeFileSync(join(notes, 'tasks.md'), '- [ ] ' + 'a long task that wraps onto the next line '.repeat(8) + '\n- [x] done\n\nsee [site](https://example.com) and [[note]]\n');

writeFileSync(join(notes, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(notes, 'pics.md'), '# Pics\n\n![a dot](dot.png)\n\n![gone](nothing.png)\n');

writeFileSync(join(notes, 'code.md'), '# Code\n\n```js\nconst answer = "forty-two"; // note ' + 'and a very long tail '.repeat(40) + '\n```\n');

writeFileSync(join(notes, 'grid.md'), '# Grid\n\n| Name | Qty |\n| :--- | ---: |\n| apple | **3** |\n| pear | 5 |\n\nafter\n');

writeFileSync(join(notes, 'diagram.md'), '# Diagram\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```\n\n```dbml\nTable users {\n  id int [pk]\n}\n```\n\n```mermaid\nnot a diagram at all\n```\n');

writeFileSync(join(notes, 'conflict.md'), '# Conflict\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n\nend\n');

const { steps, step } = stepper();

// These scenarios are the live view's (the visual editor off): the syntax shows on the cursor line. tests/electron/visual.mjs has the visual editor's.
const app = await launchApp({ scratch, notes, settings: { visual: false }, env: { MARKWORK_CHOOSE_FILE: join(notes, 'saved-as') } });   // the answer of the file chooser
let failed = false;
try {
    const page = await app.firstWindow();
    const editor = page.locator('.cm-content');
    const title = page.locator('.headerbar .title');
    // The text of the editor, and a way to put a text and a cursor in it (the keys under test need a known place to start).
    const docText = () => page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());
    const setDoc = (text, cursor = text.length) => page.evaluate(([t, c]) => {
        const view = document.querySelector('.cm-content').cmTile.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: c } });
        view.focus();
    }, [text, cursor]);
    

    await step('the window starts and lists the folder', async () => {
        await page.getByRole('treeitem', { name: /note\.md/ }).waitFor({ timeout: 15000 });
        await page.getByRole('treeitem', { name: /board\.md/ }).waitFor();
    });

    await step('a file opens, typing reaches the core, and Ctrl+S writes it', async () => {
        await page.getByRole('treeitem', { name: /note\.md/ }).click();
        await assert.doesNotReject(title.getByText('note.md').waitFor());
        await editor.click();
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.type('world\n');
        await page.keyboard.press('ControlOrMeta+s');
        await page.locator('.headerbar .state', { hasText: /^Saved$/ }).waitFor();
        assert.equal(readFileSync(join(notes, 'note.md'), 'utf8'), '# Note\n\nhello\nworld\n');
    });

    await step('the counts at the foot are the text\'s', async () => {
        await page.locator('.statusbar').getByText(/words/).waitFor();
    });

    await step('clicking a task box flips it, and a wrapped list item hangs under its text', async () => {
        await page.getByRole('treeitem', { name: /tasks\.md/ }).click();
        await title.getByText('tasks.md').waitFor();
        await editor.locator('.cm-md-task').first().click();
        await editor.getByText('[x] a long task').waitFor();
        await editor.locator('.cm-md-taskdone').last().click();
        await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('[ ] done'));
        const indent = await editor.locator('.cm-line').first().evaluate(el => getComputedStyle(el).textIndent);
        assert.match(indent, /^-\d+(\.\d+)?px$/);
    });

    await step('Ctrl+click on a [[wikilink]] opens the note, and [[ suggests note names', async () => {
        await editor.locator('.cm-md-link', { hasText: 'note' }).click({ modifiers: ['ControlOrMeta'] });
        await title.getByText('note.md').waitFor();
        await editor.click();
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.type('[[boa');
        // The list narrows as the answers arrive; Enter takes what is selected, so wait for the last one.
        await page.waitForFunction(() => document.querySelectorAll('.cm-tooltip-autocomplete li').length === 1);
        await page.locator('.cm-tooltip-autocomplete').getByText('board').waitFor();
        await page.keyboard.press('Enter');
        await editor.getByText('[[board]]').waitFor();
        await page.keyboard.press('ControlOrMeta+z');
        await page.keyboard.press('ControlOrMeta+z');
    });

    await step('a picture shows under its line, a double click zooms it, and Escape closes it', async () => {
        await page.getByRole('treeitem', { name: /pics\.md/ }).click();
        await title.getByText('pics.md').waitFor();
        const img = editor.locator('.cm-md-pictures img[alt="a dot"]');
        await img.waitFor();
        await page.waitForFunction(() => document.querySelector('.cm-md-pictures img')?.naturalWidth > 0);
        await editor.locator('.cm-md-picture-missing').waitFor();
        await img.dblclick();
        await page.locator('.image-viewer img').waitFor();
        await page.keyboard.press('Escape');
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
    });

    await step('a code block is colored by its language', async () => {
        await page.getByRole('treeitem', { name: /code\.md/ }).click();
        await title.getByText('code.md').waitFor();
        const keyword = editor.locator('.tok-keyword', { hasText: 'const' });
        await keyword.waitFor();
        const color = (loc) => loc.evaluate(el => getComputedStyle(el).color);
        const plain = await color(editor.locator('.cm-md-codebox pre'));
        assert.notEqual(await color(keyword), plain);
        assert.notEqual(await color(editor.locator('.tok-string').first()), await color(keyword));
        const box = editor.locator('.cm-md-codebox');
        assert.ok(await box.evaluate(el => el.scrollWidth > el.clientWidth), 'a long line scrolls sideways');
        await box.click();
        await box.waitFor({ state: 'detached' });
        await page.keyboard.press('ControlOrMeta+Home');
        await box.waitFor();
    });

    await step('a table is a grid until the cursor goes in, and a click on a cell opens it there', async () => {
        await page.getByRole('treeitem', { name: /grid\.md/ }).click();
        await title.getByText('grid.md').waitFor();
        const grid = editor.locator('.cm-md-table-grid');
        await grid.waitFor();
        assert.equal(await grid.locator('tbody tr').count(), 2);
        assert.equal(await grid.locator('td .cm-md-bold').textContent(), '3', 'a cell is drawn as a line of text is');
        await grid.getByText('pear').click();
        await grid.waitFor({ state: 'detached' });
        await editor.getByText('| pear').waitFor();
        await page.keyboard.press('ControlOrMeta+Home');
        await grid.waitFor();
    });

    await step('Mermaid and DBML blocks are drawn, a broken one says why, a click picks one, and its Edit source opens the source', async () => {
        await page.getByRole('treeitem', { name: /diagram\.md/ }).click();
        await title.getByText('diagram.md').waitFor();
        const drawn = editor.locator('.cm-md-diagram > svg');
        await drawn.first().waitFor({ timeout: 20000 });
        await editor.locator('.cm-md-diagram.error').waitFor({ timeout: 20000 });
        assert.equal(await drawn.count(), 2);
        const first = editor.locator('.cm-md-diagram').first();
        await first.click();
        await editor.locator('.cm-md-diagram.picked').waitFor();
        await first.locator('.cm-md-block-tool[title="Edit source"]').click();
        await editor.getByText('flowchart LR').waitFor();
        await page.keyboard.press('ControlOrMeta+End');
    });

    await step('a git conflict has buttons above it, and Accept Incoming keeps their side in one undo step', async () => {
        await page.getByRole('treeitem', { name: /conflict\.md/ }).click();
        await title.getByText('conflict.md').waitFor();
        await editor.locator('.cm-md-conflict-bar').waitFor();
        assert.equal(await editor.locator('.cm-md-conflict').count(), 5);
        await editor.getByRole('button', { name: 'Accept Incoming' }).click();
        await editor.locator('.cm-md-conflict-bar').waitFor({ state: 'detached' });
        await editor.getByText('theirs').waitFor();
        assert.equal(await editor.getByText('ours').count(), 0);
        await page.keyboard.press('ControlOrMeta+z');
        await editor.locator('.cm-md-conflict-bar').waitFor();
    });

    await step('Focus Mode (F8) dims the other paragraphs and it is the core\'s setting', async () => {
        await page.getByRole('treeitem', { name: /note\.md/ }).click();
        await editor.click();
        await page.keyboard.press('ControlOrMeta+Home');
        await page.keyboard.press('F8');
        await editor.locator('.cm-md-dim').first().waitFor();
        await page.keyboard.press('F8');
        await editor.locator('.cm-md-dim').first().waitFor({ state: 'detached' });
    });

    await step('Enter and Tab in lists and tables do what the commands say', async () => {
        await page.keyboard.press('ControlOrMeta+n');
        await editor.click();
        const enter = async (from, expected, why) => {
            await setDoc(from);
            await page.keyboard.press('Enter');
            assert.equal(await docText(), expected, why);
        };
        await enter('- one', '- one\n- ', 'Enter continues a list');
        await page.keyboard.press('Enter');
        assert.equal(await docText(), '- one\n', 'Enter on an empty item ends the list');
        await enter('9. a', '9. a\n10. ', 'the number goes up');
        await enter('- [x] a', '- [x] a\n- [ ] ', 'a task list gets an empty box');
        await enter('> a', '> a\n> ', 'a quote continues');
        await setDoc('```\n- a\n```', 7);
        await page.keyboard.press('Enter');
        assert.equal(await docText(), '```\n- a\n\n```', 'no bullet in a code block');
        await setDoc('- a');
        await page.keyboard.press('Tab');
        assert.equal(await docText(), '    - a', 'Tab indents');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await docText(), '- a', 'Shift+Tab outdents');
        const table = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |';
        await setDoc(table, table.indexOf('1'));
        await page.keyboard.press('Tab');
        await page.keyboard.type('X');
        assert.equal(await docText(), table.replace('2', 'X2'), 'Tab goes to the next cell');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Y');
        assert.equal(await docText(), table.replace('2', 'X2').replace('4', 'Y4'), 'Enter goes to the same cell in the next row');
        await setDoc('plain', 5);
        await page.keyboard.press('Enter');
        assert.equal(await docText(), 'plain\n', 'Enter outside a table is a plain line break');
        // The Enter that runs a palette command stays in the palette, though the editor has the focus again right after.
        for (let i = 0; i < 2; i++) {
            await page.keyboard.press('ControlOrMeta+Shift+P');
            await page.locator('.palette input').fill('autosave');
            await page.keyboard.press('Enter');
            await page.locator('.palette').waitFor({ state: 'detached' });
        }
        assert.equal(await docText(), 'plain\n', 'Enter in the palette types nothing into the document');
        // Closing asks only once the core has the change, which the tab shows with its unsaved mark.
        await page.getByRole('tab', { selected: true, name: /Unsaved/ }).waitFor();
        await page.keyboard.press('ControlOrMeta+w');
        const dialog = page.getByRole('alertdialog');
        await dialog.getByRole('button', { name: 'Discard' }).click();
        await dialog.waitFor({ state: 'detached' });
    });

    await step('a board shows its counts and the layout button, and text commands no longer apply', async () => {
        await page.getByRole('treeitem', { name: /board\.md/ }).click();
        await page.locator('.statusbar').getByText('2 lists · 3 cards').waitFor();
        await page.locator('.headerbar button[aria-label=Layout]', { hasText: 'Board' }).waitFor();
        await page.keyboard.press('ControlOrMeta+Shift+P');
        await page.locator('.palette input').fill('bold');
        await page.locator('.palette li.none').waitFor();
        await page.keyboard.press('Escape');
    });

    await step('Ctrl+Shift+D switches to dark, and the setting is the core\'s', async () => {
        const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        await page.keyboard.press('ControlOrMeta+Shift+D');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), before);
    });

    await step('a new document is saved where the file chooser says', async () => {
        await page.keyboard.press('ControlOrMeta+n');
        await editor.click();
        await page.keyboard.type('# Saved as\n');
        await page.keyboard.press('ControlOrMeta+Shift+S');
        await title.getByText('saved-as.md').waitFor();
        await waitFor(() => existsSync(join(notes, 'saved-as.md')));   // the title changes a moment before the file is written
        assert.equal(readFileSync(join(notes, 'saved-as.md'), 'utf8'), '# Saved as\n');
    });

    await step('closing an unsaved document asks in the window\'s dialog, and Cancel keeps it', async () => {
        await page.keyboard.press('ControlOrMeta+n');
        await editor.click();
        await page.keyboard.type('unsaved');
        await page.keyboard.press('ControlOrMeta+w');
        const dialog = page.getByRole('alertdialog');
        await dialog.getByText('Save Changes?').waitFor();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
        await editor.getByText('unsaved').waitFor();
    });
    await step('closing the window asks about the unsaved document, and Discard lets it go', async () => {
        const closed = page.waitForEvent('close');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        const dialog = page.getByRole('alertdialog');
        await dialog.getByText('Save Changes?').waitFor();
        await dialog.getByRole('button', { name: 'Discard' }).click();
        await closed;
    });
} catch {
    failed = true;
} finally {
    // A window that waits for an answer about unsaved documents does not close by itself: give it a moment, then end it.
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron window');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
