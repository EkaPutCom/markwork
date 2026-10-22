// The visual editor, against the Electron window with Playwright: the toolbar and the Visual / Markdown switch, the syntax
// hidden on the cursor line too, the cursor kept out of a line's hidden prefix, Backspace over what is seen, the
// checkboxes, the / menu, and the selection menu. What the commands do to the text is tests/unit/editcommands.ts.

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('visual');
writeFileSync(join(notes, 'plan.md'), '# Plan\n\nsome **bold** text\n');
const boardText = '---\nlayout: board\n---\n\n## Todo\n\n- [ ] One\n- [ ] Two\n\n## Done\n\n- [x] Old\n';
writeFileSync(join(notes, 'board.md'), boardText);
writeFileSync(join(notes, 'inbox.md'), '---\nlayout: list\n---\n\n# Inbox\n\n- A first note\n');
writeFileSync(join(notes, 'data.csv'), 'name,qty\napple,3\npear,5\n');

const { steps, step } = stepper();
const app = await launchApp({ scratch, notes });
let failed = false;
try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });   // the switch gives way in a narrow header
    const editor = page.locator('.cm-content');
    const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
    const mode = page.getByRole('group', { name: 'Editing mode' });
    const docText = () => page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());
    const setDoc = (text, anchor = text.length, head = anchor) => page.evaluate(([t, a, h]) => {
        const view = document.querySelector('.cm-content').cmTile.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: a, head: h } });
        view.focus();
    }, [text, anchor, head]);
    const cursor = () => page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.selection.main.head);
    const cursorInTable = () => page.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; return v.state.doc.lineAt(v.state.selection.main.head).text.startsWith('|'); });
    const lineText = n => editor.locator('.cm-line').nth(n).textContent();
    const openFile = async name => { await page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }).click(); await page.locator('.headerbar .title').getByText(name).waitFor(); };
    const pageOf = selector => page.locator(selector);
    const lineTexts = () => page.evaluate(() => [...document.querySelectorAll('.cm-content > .cm-line')].map(l => l.textContent));

    await page.getByRole('treeitem', { name: /plan\.md/ }).click();
    await page.locator('.headerbar .title').getByText('plan.md').waitFor();

    await step('the visual editor is on at first: the switch, the toolbar, and no syntax on the cursor line', async () => {
        assert.equal(await mode.getByRole('button', { name: 'Visual' }).getAttribute('aria-pressed'), 'true');
        await toolbar.waitFor();
        await setDoc('# Plan\n\nsome **bold** text', 2);
        assert.equal(await lineText(0), 'Plan', 'the # is hidden on the cursor line');
        assert.equal(await toolbar.getByRole('button', { name: 'Text style' }).textContent(), 'Heading 1');
        await setDoc('# Plan\n\nsome **bold** text', 15);
        assert.equal(await lineText(2), 'some bold text', 'the ** are hidden on the cursor line');
        assert.equal(await toolbar.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed'), 'true', 'Bold is pressed in bold text');
    });

    await step('the toolbar formats the selection and turns a line into a list, a numbered list, and a to-do list', async () => {
        await setDoc('one word', 4, 8);
        await toolbar.getByRole('button', { name: 'Italic' }).click();
        assert.equal(await docText(), 'one *word*');
        await toolbar.getByRole('button', { name: 'Bulleted List' }).click();
        assert.equal(await docText(), '- one *word*');
        await toolbar.getByRole('button', { name: 'Numbered List' }).click();
        assert.equal(await docText(), '1. one *word*', 'the bullet is replaced, not kept');
        await toolbar.getByRole('button', { name: 'To-do List' }).click();
        assert.equal(await docText(), '- [ ] one *word*');
        await toolbar.getByRole('button', { name: 'Text style' }).click();
        await page.getByRole('menuitemradio', { name: 'Heading 2' }).click();
        assert.equal(await docText(), '## one *word*');
        await waitFor(async () => await editor.evaluate(el => el === document.activeElement || el.contains(document.activeElement)));
    });

    await step('the cursor stays out of a hidden prefix, and Backspace there makes the line a paragraph', async () => {
        await setDoc('# Title', 7);
        await page.keyboard.press('Home');
        assert.equal(await cursor(), 2, 'Home goes to where the text starts, not before the #');
        await page.keyboard.type('My ');
        assert.equal(await docText(), '# My Title');
        await page.keyboard.press('Home');
        await page.keyboard.press('Backspace');
        assert.equal(await docText(), 'My Title', 'Backspace at the start of a heading removes the heading');
        await setDoc('a\n- item', 8);
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowLeft');
        assert.equal(await cursor(), 1, 'Left from the start of a list item goes to the line above, not into the "- "');
    });

    await step('Backspace and Delete remove what is seen, not a hidden marker', async () => {
        await setDoc('a **bold** b', 10);
        await page.keyboard.press('Backspace');
        assert.equal(await docText(), 'a **bol** b', 'the letter before the hidden ** goes');
        await setDoc('a **bold** b', 2);
        await page.keyboard.press('Delete');
        assert.equal(await docText(), 'a **old** b', 'the letter after the hidden ** goes');
        await setDoc('first\n- second', 5);
        await page.keyboard.press('Delete');
        assert.equal(await docText(), 'firstsecond', 'Delete at a line end joins the next line\'s text without its "- "');
    });

    await step('a task is a checkbox, and a click writes the other state', async () => {
        await setDoc('- [ ] call Rani\n- [x] book the room\n', 0);
        await editor.getByRole('checkbox', { name: 'Not done' }).click();
        await waitFor(async () => (await docText()).startsWith('- [x] call Rani'));
        assert.equal(await editor.getByRole('checkbox', { name: 'Done' }).count(), 2);
        assert.ok(!(await lineText(0)).includes('-'), 'no "-" before a checkbox');
    });

    await step('a list item\'s first letter lines up with the lines that wrap under it: bulleted, nested, to-do, and numbered', async () => {
        const long = 'words that go on and on until the line has to wrap '.repeat(5).trim();
        await setDoc(`- ${long}\n  - nested ${long}\n- [ ] ${long}\n1. ${long}\n    1. deeper ${long}\n\nafter`, 0);
        const marks = editor.locator('.cm-line:has(.cm-md-listmark)');
        await waitFor(async () => (await marks.count()) === 5);
        for (let i = 0; i < 5; i++) {
            const where = await marks.nth(i).evaluate(line => {
                const mark = line.querySelector('.cm-md-listmark').getBoundingClientRect(), box = line.getBoundingClientRect();
                return { textStart: mark.right, wrapped: box.left + parseFloat(getComputedStyle(line).paddingLeft), height: box.height, rows: Math.round(box.height / parseFloat(getComputedStyle(line).lineHeight)) };
            });
            assert.ok(where.rows >= 2, `item ${i + 1} wraps (${where.rows} rows)`);
            assert.ok(Math.abs(where.textStart - where.wrapped) < 1.5, `item ${i + 1}: its text starts at ${where.textStart}, the wrapped lines at ${where.wrapped}`);
        }
        // The same width for every kind of marker.
        const widths = await editor.locator('.cm-md-listmark').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
        assert.equal(new Set(widths).size, 1, `every marker is as wide as the others: ${widths}`);
    });

    await step('"/" offers the blocks; typing narrows them and Enter makes one', async () => {
        await setDoc('intro\n\n');
        await page.keyboard.type('/');
        const popup = page.locator('.cm-tooltip-autocomplete');
        await popup.getByText('Heading 1').waitFor();
        await page.keyboard.type('todo');
        await waitFor(async () => (await popup.locator('li').count()) === 1);
        await page.keyboard.press('Enter');
        await page.keyboard.type('Buy paper');
        assert.equal(await docText(), 'intro\n\n- [ ] Buy paper');
        await page.keyboard.type(' a/b');
        await page.waitForTimeout(300);   // to show that nothing opens: a slash inside a word is text
        assert.equal(await popup.count(), 0);
    });

    await step('a selection gets a menu: its Bold wraps the selection', async () => {
        await setDoc('make this loud', 10, 14);
        const menu = page.getByRole('toolbar', { name: 'Format the selection' });
        await menu.waitFor();
        await menu.getByRole('button', { name: 'Bold' }).click();
        assert.equal(await docText(), 'make this **loud**');
        await menu.getByRole('button', { name: 'Ask the Assistant about the selection' }).waitFor();
        await setDoc('make this **loud**', 0);
        await menu.waitFor({ state: 'detached' });
    });

    await step('a table stays a grid, its cells are typed in, and the toolbar adds to it', async () => {
        await setDoc('intro\n\n');
        await toolbar.getByRole('button', { name: 'Insert Table' }).click();
        const grid = editor.locator('.cm-md-table-grid.editable');
        await grid.waitFor();
        const box = () => page.evaluate(() => document.activeElement?.matches('.cm-md-cell-input') ? document.activeElement.getAttribute('aria-label') : null);
        await waitFor(async () => (await box()) === 'Row 1, column 1');
        await page.keyboard.type('jadi');
        await page.keyboard.press('Tab');
        await page.keyboard.type('apa dulu');
        await page.keyboard.press('Tab');
        await page.keyboard.type('a|b');
        assert.match(await docText(), /\| jadi \| apa dulu \| a\\\|b \|/, 'each cell is written into the text as it is typed; a pipe is escaped');
        assert.equal(await toolbar.getByRole('button', { name: 'Text style' }).textContent(), 'Table');
        await page.keyboard.press('Tab');
        await waitFor(async () => (await box()) === 'Row 2, column 1');
        await page.keyboard.type('x');
        assert.equal(await grid.locator('tbody tr').count(), 2, 'Tab in the last cell adds a row');
        await toolbar.getByRole('button', { name: 'Add Column to the Right' }).click();
        await waitFor(async () => (await grid.locator('thead th').count()) === 4);
        await waitFor(async () => (await box()) !== null);
        await page.keyboard.press('Escape');
        await waitFor(async () => await editor.evaluate(el => document.activeElement === el));
        assert.equal(await cursorInTable(), false, 'Escape leaves the grid');
        await grid.locator('td', { hasText: 'apa dulu' }).click();
        assert.equal(await box(), 'Row 1, column 3', 'a click opens a cell (the new column is the second one)');
        assert.equal(await grid.locator('td strong').count(), 0);
    });

    await step('a block has a handle: + adds a block with the / menu, the grip drags it, and the keyboard moves it', async () => {
        await setDoc('# Plan\n\nFirst\n\n- a\n- b\n\nLast', 0);
        await editor.locator('.cm-line', { hasText: 'First' }).hover();
        await page.getByRole('button', { name: 'Add a block below' }).click();
        await page.locator('.cm-tooltip-autocomplete').getByText('Heading 1').waitFor();
        assert.equal(await docText(), '# Plan\n\nFirst\n\n/\n\n- a\n- b\n\nLast', 'an empty block after the paragraph, with the slash in it');
        await page.keyboard.type('todo');
        await waitFor(async () => (await page.locator('.cm-tooltip-autocomplete li').count()) === 1);
        await page.keyboard.press('Enter');
        await page.keyboard.type('Call Rani');
        assert.equal(await docText(), '# Plan\n\nFirst\n\n- [ ] Call Rani\n\n- a\n- b\n\nLast');

        await setDoc('# Plan\n\nFirst\n\n- a\n- b\n\nLast', 0);
        const list = await editor.locator('.cm-line', { hasText: /a$/ }).boundingBox();
        await page.mouse.move(list.x + 60, list.y + 8);
        const grip = page.getByRole('button', { name: 'Drag to move the block' });
        await grip.waitFor();
        const g = await grip.boundingBox();
        const last = await editor.locator('.cm-line', { hasText: 'Last' }).boundingBox();
        await page.mouse.move(g.x + 10, g.y + 10);
        await page.mouse.down();
        await page.mouse.move(g.x + 10, g.y + 60, { steps: 4 });
        await page.mouse.move(last.x + 60, last.y + last.height - 2, { steps: 8 });
        await page.locator('.cm-block-drop').waitFor({ state: 'visible' });
        await page.mouse.up();
        await waitFor(async () => (await docText()) === '# Plan\n\nFirst\n\nLast\n\n- a\n- b');
        await page.locator('.cm-block-drop').waitFor({ state: 'hidden' });

        await setDoc('one\n\ntwo\n\nthree', 2);
        await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
        assert.equal(await docText(), 'two\n\none\n\nthree');
        assert.equal(await cursor(), 7, 'the cursor stays in the block it moved');
        await page.keyboard.press('ControlOrMeta+Shift+ArrowUp');
        assert.equal(await docText(), 'one\n\ntwo\n\nthree');
        await page.keyboard.press('ControlOrMeta+Z');
        assert.equal(await docText(), 'two\n\none\n\nthree', 'a move is one undo step');
    });

    await step('Markdown is the file as it is written: every marker, plain text in a fixed-width font, and Visual comes back', async () => {
        const raw = '# Plan\n\nsome **bold** and [a link](https://x.org)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] task\n\n![pic](pic.png)';
        await setDoc(raw, raw.length);
        await mode.getByRole('button', { name: 'Markdown' }).click();
        await toolbar.waitFor({ state: 'detached' });
        assert.equal(await mode.getByRole('button', { name: 'Markdown' }).getAttribute('aria-pressed'), 'true');
        assert.equal(await mode.getByRole('button', { name: 'Visual' }).getAttribute('aria-pressed'), 'false');
        // The cursor is on the last line, so only a mode that shows everything has these lines as they are written.
        await waitFor(async () => (await lineTexts()).join('\n') === raw);
        assert.equal(await editor.locator('.cm-md-table-grid').count(), 0, 'a table is its text, not a grid');
        assert.equal(await editor.getByRole('checkbox').count(), 0, 'a task is "- [ ]", not a checkbox');
        assert.equal(await page.locator('.cm-block-handle').evaluate(el => getComputedStyle(el).display), 'none', 'no block handle');
        const look = await editor.locator('.cm-md-h1').first().evaluate(el => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight, family: getComputedStyle(el).fontFamily }));
        assert.deepEqual([look.size, look.weight, /mono/i.test(look.family)], ['14px', '400', true], 'a heading is plain text in the fixed-width font');
        await mode.getByRole('button', { name: 'Visual' }).click();
        await toolbar.waitFor();
        assert.equal(await mode.getByRole('button', { name: 'Visual' }).getAttribute('aria-pressed'), 'true');
        await editor.getByRole('checkbox', { name: 'Not done' }).waitFor();
        assert.equal(await editor.locator('.cm-md-table-grid').count(), 1, 'the grid is back');
    });

    await step('a document with another form (a board, a list, a CSV table) has the switch too: Visual is that form, Markdown its text', async () => {
        const text = () => editor.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());
        const visual = mode.getByRole('button', { name: 'Visual' }), markdown = mode.getByRole('button', { name: 'Markdown' });
        const pages = [['board.md', '.board', /^---\nlayout: board/], ['inbox.md', '.inbox-page', /^---\nlayout: list/], ['data.csv', '.csv-page', /^name,qty\napple,3/]];
        for (const [file, page, raw] of pages) {
            await openFile(file);
            await pageOf(page).waitFor();
            assert.equal(await visual.getAttribute('aria-pressed'), 'true', `${file}: Visual is pressed on its page`);
            assert.equal(await markdown.getAttribute('aria-pressed'), 'false');
            await markdown.click();
            await pageOf(page).waitFor({ state: 'detached' });
            await waitFor(async () => raw.test(await text()));
            assert.equal(await markdown.getAttribute('aria-pressed'), 'true', `${file}: Markdown is pressed on its text`);
            assert.equal(await toolbar.count(), 0, `${file}: its text is the raw file, with no formatting toolbar`);
            assert.ok((await lineTexts()).some(l => l.includes('---') || l.includes(',')), `${file}: every marker shows`);
            await visual.click();
            await pageOf(page).waitFor();
            assert.equal(await visual.getAttribute('aria-pressed'), 'true', `${file}: back to its page`);
        }
        await openFile('plan.md');
        await toolbar.waitFor();
        assert.equal(await visual.getAttribute('aria-pressed'), 'true', 'an ordinary document is Visual in the visual editor again');
    });
} catch {
    failed = true;
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron visual editor');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
