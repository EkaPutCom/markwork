// The visual editor, against the Electron window with Playwright: the toolbar and the Visual / Markdown switch, the syntax
// hidden on the cursor line too, the cursor kept out of a line's hidden prefix, Backspace over what is seen, the
// checkboxes, the / menu, and the selection menu. What the commands do to the text is tests/unit/editcommands.ts.

import assert from 'node:assert/strict';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('visual');
copyFileSync(new URL('../samples/images/example.png', import.meta.url), join(notes, 'pic.png'));
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

    await step('Enter after text that hidden pictures end breaks the line before the pictures', async () => {
        const text = 'A title: ![pic](images/x.png "t")\nnext';
        await setDoc(text, text.indexOf('\n'));
        await page.keyboard.press('Enter');
        assert.equal(await docText(), 'A title:\n![pic](images/x.png "t")\nnext', 'the new line comes under the text, the picture with it');
        const two = 'Two: ![a](images/x.png) ![b](images/y.png)\nnext';
        await setDoc(two, two.indexOf(') ![b]') + 2);
        await page.keyboard.press('Enter');
        assert.equal(await docText(), 'Two:\n![a](images/x.png) ![b](images/y.png)\nnext', 'on the space between two pictures, the line still breaks before them all');
        await setDoc('![pic](images/x.png)\nnext', 20);
        await page.keyboard.press('Enter');
        assert.equal(await docText(), '![pic](images/x.png)\n\nnext', 'a line of pictures only gets its new line after them');
    });

    await step('a code block: Enter on its empty last line leaves it, Ctrl+Enter too, and its toolbar deletes it', async () => {
        await setDoc('Before\n```js\nconst a = 1;\n```\nAfter', 0);
        const pre = page.locator('.cm-md-codebox pre');
        await pre.click();
        await pre.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
        await page.keyboard.press('Enter');
        await page.locator('.cm-md-codebox.exit-hint').waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.type('next');
        assert.equal(await docText(), 'Before\n```js\nconst a = 1;\n```\nnext\nAfter', 'the empty code line goes, and a paragraph comes under the block');
        await pre.click();
        await page.keyboard.press('ControlOrMeta+Enter');
        await page.keyboard.type('x');
        assert.equal(await docText(), 'Before\n```js\nconst a = 1;\n```\nx\nnext\nAfter', 'Ctrl+Enter opens a line under the block');
        await page.locator('.cm-md-codebox').hover();
        await page.locator('.cm-md-codebox .cm-md-block-tool[title="Delete"]').click();
        assert.equal(await docText(), 'Before\nx\nnext\nAfter', 'Delete removes the block with its fences');
    });

    // ---------- Objects (blockselect.ts), driven the way a person does it: clicks at what is seen, then keys ----------
    // Where a line's visible text starts and ends on the screen.
    const textEdges = startsWith => page.evaluate(start => {
        const line = [...document.querySelectorAll('.cm-content > .cm-line')].find(l => l.textContent.startsWith(start));
        const range = document.createRange();
        range.selectNodeContents(line);
        const r = range.getBoundingClientRect();
        return { left: r.left, right: r.right, y: r.top + r.height / 2 };
    }, startsWith);
    const clickAfterText = async start => { const e = await textEdges(start); await page.mouse.click(e.right + 30, e.y); };
    const clickBeforeText = async start => { const e = await textEdges(start); await page.mouse.click(e.left + 1, e.y); };
    const picturesLoaded = n => page.waitForFunction(k => [...document.querySelectorAll('.cm-md-picture img')].filter(i => i.naturalWidth > 0).length === k, n);
    const picked = () => editor.locator('.picked').count();
    const undo = () => page.keyboard.press('ControlOrMeta+z');
    const cursorLineNumber = () => page.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });

    await step('pictures: a click after a line\'s text puts the cursor before its hidden pictures, where Enter and typing go', async () => {
        const two = 'Two: ![one](pic.png) ![two](pic.png)\nnext';
        await setDoc(two, two.length);
        await picturesLoaded(2);
        await clickAfterText('Two:');
        await page.keyboard.press('Enter');
        assert.equal(await docText(), 'Two:\n![one](pic.png) ![two](pic.png)\nnext', 'the line breaks before the pictures, not between them');
        await undo();
        await clickAfterText('Two:');
        await page.keyboard.type('x');
        assert.equal(await docText(), 'Two: x![one](pic.png) ![two](pic.png)\nnext', 'typing goes at the end of the text, not into a picture');
        await undo();
        await clickAfterText('Two:');
        await page.keyboard.press('ArrowRight');
        assert.equal(await cursorLineNumber(), 2, 'moving right from there goes to the next line, over the pictures');
    });

    await step('a picture: a click picks it with a ring and a hint, and Enter, typing, Copy, Backspace, Esc act on it whole', async () => {
        await setDoc('Two: ![one](pic.png) ![two](pic.png)\nnext', 0);
        await picturesLoaded(2);
        const pictures = editor.locator('.cm-md-picture img');
        await pictures.first().click();
        await editor.locator('.cm-md-picture.picked').waitFor();
        await page.locator('.cm-block-hint').waitFor();
        await page.keyboard.press('Enter');
        assert.equal(await docText(), 'Two: ![one](pic.png)\n![two](pic.png)\nnext', 'Enter after the first picture puts the second on a line of its own');
        await undo();
        await pictures.last().click();
        await page.keyboard.type('hi');
        assert.equal(await docText(), 'Two: ![one](pic.png) ![two](pic.png)\nhi\nnext', 'typing starts a new line after the picture');
        await waitFor(async () => await picked() === 0);   // and lets it go
        await undo();
        await pictures.first().click();
        await page.keyboard.press('ControlOrMeta+c');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '![one](pic.png)', 'Copy copies its Markdown');
        await page.keyboard.press('Backspace');
        assert.equal(await docText(), 'Two: ![two](pic.png)\nnext', 'Backspace deletes it with its space');
        await pictures.first().click();
        await page.keyboard.press('Escape');
        await waitFor(async () => await picked() === 0);   // Esc lets it go
        assert.equal(await docText(), 'Two: ![two](pic.png)\nnext');
    });

    await step('Backspace at the start of the line after a picture picks the picture, and a second one deletes it', async () => {
        await setDoc('![one](pic.png)\nnext', 0);
        await picturesLoaded(1);
        await clickBeforeText('next');
        await page.keyboard.press('Backspace');
        await editor.locator('.cm-md-picture.picked').waitFor();
        assert.equal(await docText(), '![one](pic.png)\nnext', 'the first Backspace only picks it');
        await page.keyboard.press('Backspace');
        assert.equal(await docText(), 'next', 'the second deletes it with its line');
    });

    await step('a code block: Esc in it picks it, Enter opens a line under it, and Backspace on the line after picks it before deleting', async () => {
        await setDoc('Before\n```js\nconst a = 1;\n```\nAfter', 0);
        await editor.locator('.cm-md-codebox pre').click();
        await page.keyboard.press('Escape');
        await editor.locator('.cm-md-codebox.picked').waitFor();
        await page.keyboard.press('Enter');
        await page.keyboard.type('x');
        assert.equal(await docText(), 'Before\n```js\nconst a = 1;\n```\nx\nAfter', 'Enter opens a line under the block');
        await clickBeforeText('x');
        await page.keyboard.press('Backspace');
        await editor.locator('.cm-md-codebox.picked').waitFor();
        assert.equal(await docText(), 'Before\n```js\nconst a = 1;\n```\nx\nAfter', 'at the start of the line after the block, Backspace picks the block instead of joining the line to its fence');
        await page.keyboard.press('Backspace');
        assert.equal(await docText(), 'Before\nx\nAfter', 'a second Backspace deletes it');
    });

    await step('a diagram: a click picks it, Enter opens a line under it, Delete deletes it', async () => {
        await setDoc('Before\n```dbml\nTable t { id int [pk] }\n```\nAfter', 0);
        const diagram = editor.locator('.cm-md-diagram');
        await diagram.locator('.er-diagram').waitFor();
        await diagram.click();
        await editor.locator('.cm-md-diagram.picked').waitFor();
        assert.equal(await diagram.count(), 1, 'a click leaves the diagram drawn');
        await page.keyboard.press('Enter');
        await page.keyboard.type('x');
        assert.equal(await docText(), 'Before\n```dbml\nTable t { id int [pk] }\n```\nx\nAfter');
        await diagram.click();
        await page.keyboard.press('Delete');
        assert.equal(await docText(), 'Before\nx\nAfter');
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

    await step('Highlight is in the toolbar and the selection menu, pressed in ==highlighted== text, and on Ctrl+Alt+H', async () => {
        await setDoc('mark this', 5, 9);
        await page.getByRole('toolbar', { name: 'Format the selection' }).getByRole('button', { name: 'Highlight' }).click();
        assert.equal(await docText(), 'mark ==this==');
        await setDoc('mark ==this==', 9);
        await waitFor(async () => await toolbar.getByRole('button', { name: 'Highlight' }).getAttribute('aria-pressed') === 'true');
        await setDoc('one two', 0, 3);
        await toolbar.getByRole('button', { name: 'Highlight' }).click();
        assert.equal(await docText(), '==one== two');
        await setDoc('one two', 4, 7);
        await page.keyboard.press('Control+Alt+h');
        assert.equal(await docText(), 'one ==two==');
    });

    await step('Insert Link asks for the address in a box: a selection becomes a link, and Remove link undoes it', async () => {
        await setDoc('see the docs', 8, 12);
        await toolbar.getByRole('button', { name: 'Insert Link' }).click();
        const box = page.locator('.cm-link-editor');
        await box.waitFor();
        assert.equal(await box.locator('input').count(), 1, 'a selection is the text: only the address is asked');
        await box.getByPlaceholder('https://… or a file path').fill('https://example.com');
        await page.keyboard.press('Enter');
        assert.equal(await docText(), 'see the [docs](https://example.com)');
        await box.waitFor({ state: 'detached' });
        await setDoc('see the [docs](https://example.com)', 12);
        await page.keyboard.press('ControlOrMeta+k');
        await box.waitFor();
        assert.equal(await box.getByPlaceholder('https://… or a file path').inputValue(), 'https://example.com');
        await box.getByRole('button', { name: 'Remove link' }).click();
        assert.equal(await docText(), 'see the docs');
        await setDoc('');
        await page.keyboard.press('ControlOrMeta+k');
        await box.waitFor();
        assert.equal(await box.locator('input').count(), 2, 'with nothing selected the text is asked too');
        await page.keyboard.press('Escape');
        await box.waitFor({ state: 'detached' });
    });

    await step('a table stays a grid, its cells are typed in, and the toolbar adds to it', async () => {
        await setDoc('intro\n\n');
        await toolbar.getByRole('button', { name: 'Insert Table' }).click();
        const grid = editor.locator('.cm-md-table-grid.editable');
        await grid.waitFor();
        const box = () => page.evaluate(() => document.activeElement?.matches('.cm-md-cell') ? document.activeElement.getAttribute('aria-label') : null);
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
        assert.equal(await grid.locator('td .cm-md-bold').count(), 0);
    });


    await step('a table cell is edited and drawn as the text around it: formats without markers, the caret where the click was, Bold on and off', async () => {
        const grid = editor.locator('.cm-md-table-grid.editable');
        await setDoc('intro\n\n| A | B |\n| --- | --- |\n| `npm i` | make **this** loud |\n', 0);
        await grid.waitFor();
        const cell = grid.locator('td').nth(1);
        assert.equal(await cell.textContent(), 'make this loud', 'no markers');
        assert.equal(await grid.locator('td .cm-md-code').textContent(), 'npm i', 'code is drawn as code');
        // A cell is drawn as a line of text is: the same classes, so the same look.
        const look = sel => page.evaluate(s => { const st = getComputedStyle(document.querySelector(s)); return [st.fontWeight, st.fontFamily, st.backgroundColor]; }, sel);
        await setDoc('make **this** loud `npm i`\n\n| A | B |\n| --- | --- |\n| `npm i` | make **this** loud |\n', 0);
        assert.deepEqual(await look('.cm-md-table-grid td .cm-md-bold'), await look('.cm-line .cm-md-bold'), 'bold in a cell looks as bold text does');
        assert.deepEqual(await look('.cm-md-table-grid td .cm-md-code'), await look('.cm-line .cm-md-code'), 'code in a cell looks as code in text does');
        await setDoc('intro\n\n| A | B |\n| --- | --- |\n| `npm i` | make **this** loud |\n', 0);
        const before = await grid.boundingBox();
        // A click on a letter puts the caret before it.
        const at = await cell.evaluate(td => {
            const text = td.querySelector('.cm-md-bold').firstChild, range = document.createRange();
            range.setStart(text, 2); range.setEnd(text, 3);
            const r = range.getBoundingClientRect(); return { x: r.left + 1, y: r.top + r.height / 2 };
        });
        await page.mouse.click(at.x, at.y);
        // What the text, its selection, and the cell's own selection were, for a wait below that gives up.
        const state = () => page.evaluate(() => {
            const v = document.querySelector('.cm-content').cmTile.view, m = v.state.selection.main, s = getSelection();
            const active = document.activeElement, inCell = active?.matches('.cm-md-cell') && s.rangeCount && active.contains(s.anchorNode);
            return [`text: ${JSON.stringify(v.state.doc.toString())}`, `selection: ${m.anchor}–${m.head} ${JSON.stringify(v.state.sliceDoc(m.from, m.to))}`,
                `focus: ${active?.className || active?.tagName}`, `cell selection: ${inCell ? JSON.stringify(s.toString()) + ` (${s.anchorOffset}–${s.focusOffset})` : 'none'}`].join('\n');
        });
        const caret = () => page.evaluate(() => { const s = getSelection(), r = document.createRange(); r.selectNodeContents(document.activeElement); r.setEnd(s.focusNode, s.focusOffset); return r.toString().length; });
        await waitFor(async () => (await caret()) === 7);
        assert.deepEqual(await grid.boundingBox(), before, 'opening a cell moves nothing');
        await page.keyboard.type('X');
        assert.equal(await cell.textContent(), 'make thXis loud');
        assert.match(await docText(), /make \*\*thXis\*\* loud/, 'a letter typed in a bold word is bold, and the markers stay');
        await page.keyboard.press('ControlOrMeta+z');
        await waitFor(async () => /make \*\*this\*\* loud/.test(await docText()), 10000, state);
        // A selection in the cell is the text's: the menu shows, and Bold wraps it.
        await cell.evaluate(td => { const t = td.lastChild; getSelection().setBaseAndExtent(t, 1, t, 4); });
        await page.keyboard.press('Shift+ArrowRight');
        await page.getByRole('toolbar', { name: 'Format the selection' }).waitFor();
        await toolbar.getByRole('button', { name: /^Bold/ }).click();
        await waitFor(async () => /make \*\*this\*\* \*\*loud\*\*/.test(await docText()));
        assert.equal(await page.evaluate(() => document.activeElement.matches('.cm-md-cell')), true, 'the cell keeps the focus');
        assert.equal(await cell.textContent(), 'make this loud');
        assert.equal(await toolbar.getByRole('button', { name: /^Bold/ }).getAttribute('aria-pressed'), 'true', 'Bold is pressed for a bold selection in a cell');
        // Bold again takes it off: the selection is what the cell shows, without the hidden **.
        await page.keyboard.press('ControlOrMeta+b');
        await waitFor(async () => /make \*\*this\*\* loud \|/.test(await docText()), 10000, state);
        // The cell takes its selection back from the command before the next one (a slow runner can be a frame behind).
        await waitFor(async () => await toolbar.getByRole('button', { name: /^Bold/ }).getAttribute('aria-pressed') === 'false', 10000, state);
        await page.keyboard.press('ControlOrMeta+b');
        await waitFor(async () => /make \*\*this\*\* \*\*loud\*\*/.test(await docText()), 10000, state);
        // A bold word chosen with the mouse right after a command, then Bold: no more bold, not ****this****. The text takes
        // the cell's new selection (not "loud" back from the command); Bold being pressed says nothing, since loud is bold too.
        await cell.locator('.cm-md-bold', { hasText: 'this' }).dblclick();
        const selected = () => page.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view, m = v.state.selection.main; return v.state.sliceDoc(m.from, m.to); });
        // Windows takes the space after a double-clicked word along; Shift+Left gives the word back.
        await waitFor(async () => /^this\b/.test(await selected()), 10000, state);
        if ((await selected()) !== 'this') await page.keyboard.press('Shift+ArrowLeft');
        await waitFor(async () => (await selected()) === 'this');
        assert.equal(await toolbar.getByRole('button', { name: /^Bold/ }).getAttribute('aria-pressed'), 'true');
        await toolbar.getByRole('button', { name: /^Bold/ }).click();
        await waitFor(async () => /\| make this \*\*loud\*\* \|/.test(await docText()));
        assert.equal(await cell.locator('.cm-md-bold').textContent(), 'loud');
        // A long text wraps in its cell; the table does not grow past the page.
        await page.keyboard.press('End');
        await page.keyboard.type(' ' + 'long text '.repeat(30));
        assert.equal(await grid.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'the grid does not scroll');
        await page.keyboard.press('Escape');
    });
    await step('a selection made in a cell right after a command is kept, though the cell takes the text\'s selection a frame late', async () => {
        const grid = editor.locator('.cm-md-table-grid.editable');
        await setDoc('intro\n\n| A | B |\n| --- | --- |\n| x | make **this** loud |\n', 0);
        const cell = grid.locator('td').nth(1);
        await cell.click();
        await cell.evaluate(td => { const t = td.lastChild; getSelection().setBaseAndExtent(t, 1, t, 4); });
        await page.keyboard.press('Shift+ArrowRight');
        const selected = () => page.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view, m = v.state.selection.main; return v.state.sliceDoc(m.from, m.to); });
        await waitFor(async () => (await selected()) === 'loud');
        // Frames come 150 ms late, so the double-click below lands before the frame that follows Ctrl+B.
        await page.evaluate(() => { const raf = window.requestAnimationFrame; window.slowFrames = raf; window.requestAnimationFrame = cb => raf(() => setTimeout(() => cb(performance.now()), 150)); });
        try {
            await page.keyboard.press('ControlOrMeta+b');
            await waitFor(async () => /make \*\*this\*\* \*\*loud\*\*/.test(await docText()));
            await cell.locator('.cm-md-bold', { hasText: 'this' }).dblclick();
            await waitFor(async () => /^(\*\*)?this(\*\*)? ?$/.test(await selected()));
            if ((await selected()).endsWith(' ')) await page.keyboard.press('Shift+ArrowLeft');   // Windows selects the space too
            await waitFor(async () => /^(\*\*)?this(\*\*)?$/.test(await selected()));
            await page.waitForTimeout(400);   // to show that the late frame does not take the selection back to "loud"
            assert.match(await selected(), /^(\*\*)?this(\*\*)?$/);
        } finally {
            await page.evaluate(() => { window.requestAnimationFrame = window.slowFrames; });
        }
        await toolbar.getByRole('button', { name: /^Bold/ }).click();
        await waitFor(async () => /\| make this \*\*loud\*\* \|/.test(await docText()));
        await page.keyboard.press('Escape');
    });

    await step('formatting a cell keeps the page where it is; a row added below the view comes into view', async () => {
        const para = 'Some text above the table, long enough to wrap onto a second line in the editor at this width.\n\n';
        const rows = Array.from({ length: 14 }, (_, i) => `| cmd ${i} | The dependencies of step ${i}, with a description that wraps in its cell |`).join('\n');
        await setDoc('# Doc\n\n' + para.repeat(12) + '| Command | Function |\n| --- | --- |\n' + rows + '\n\n' + para.repeat(12), 0);
        const scroller = page.locator('.cm-scroller'), grid = editor.locator('.cm-md-table-grid.editable');
        await waitFor(async () => { if (await grid.count()) return true; await scroller.evaluate(s => { s.scrollTop += 300; }); return false; });
        // The table's top a little way down the editor, its last rows out of view.
        await scroller.evaluate((s, g) => { s.scrollTop += g.getBoundingClientRect().top - s.getBoundingClientRect().top - 150; }, await grid.elementHandle());
        const top = () => scroller.evaluate(s => Math.round(s.scrollTop));
        const cell = grid.locator('td').nth(1);
        await cell.click();
        const before = await top();
        await cell.evaluate(td => { const t = td.firstChild; getSelection().setBaseAndExtent(t, 4, t, 16); });
        await page.keyboard.press('Shift+ArrowRight');
        const menu = page.getByRole('toolbar', { name: 'Format the selection' });
        await menu.getByRole('button', { name: 'Bold' }).click();
        await waitFor(async () => (await docText()).includes('| The **dependencies** of step 0'));
        await page.keyboard.press('ControlOrMeta+i');
        await waitFor(async () => (await docText()).includes('| The ***dependencies*** of step 0'));
        await page.waitForTimeout(300);   // to show that nothing scrolls after the command either
        assert.equal(await top(), before, 'Bold and Italic in a cell do not move the page');
        await toolbar.getByRole('button', { name: 'Add Row Below' }).click();
        await waitFor(async () => (await grid.locator('tbody tr').count()) === 15);
        await waitFor(async () => (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Row 1, column 2');
        assert.equal(await top(), before, 'a row added from the toolbar moves nothing; the cell keeps the focus');
        // Tab from the last cell adds a row under the view: the page brings the new cell into view.
        const inView = async cell => cell.evaluate((td, s) => { const r = td.getBoundingClientRect(), v = s.getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom; }, await scroller.elementHandle());
        const tabFromLast = async (place, rows) => {
            const lastRow = grid.locator('tbody tr').last();
            await lastRow.locator('td').last().click();
            await scroller.evaluate(place, await lastRow.elementHandle());
            const was = await top();
            await page.keyboard.press('Tab');
            const added = grid.locator('tbody tr').nth(rows).locator('td').first();
            await waitFor(async () => await added.evaluate(td => document.activeElement === td));
            await waitFor(() => inView(added));
            await page.waitForTimeout(300);   // to show that nothing scrolls after the new cell has the focus
            return await top() - was;
        };
        // Tab in the last row adds one; with the table in the middle of the view the page does not move at all (the grid
        // is drawn again, and CodeMirror's own correction for that moved it by hundreds of pixels).
        assert.equal(await tabFromLast((s, tr) => { s.scrollTop += tr.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight / 2; }, 15), 0);
        // With the last row at the bottom of the view, the new one starts out of it: the page moves by about a row.
        const moved = await tabFromLast((s, tr) => { s.scrollTop += tr.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom + 2; }, 16);
        assert.ok(moved > 0 && moved < 120, `the page moves by about a row to show it, not to the grid's top (moved ${moved})`);
        await page.keyboard.press('Escape');
    });

    await step('a code block is edited in its box: it scrolls sideways as one, and the arrows leave it', async () => {
        await setDoc('Above\n\n```js\nconst a = 1;\nlet b = ' + '"the application layer" + '.repeat(8) + '"END";\n```\n\nBelow', 0);
        const box = editor.locator('.cm-md-codebox');
        await box.waitFor();
        await box.locator('pre').click({ position: { x: 5, y: 5 } });
        await waitFor(async () => await page.evaluate(() => document.activeElement?.matches('.cm-md-codeedit')));
        assert.equal(await editor.locator('.cm-md-codeblock-line').count(), 0, 'the box stays; its lines are not shown');
        await page.keyboard.press('Home');
        await page.keyboard.type('X');
        assert.match(await docText(), /```js\nXconst a = 1;\n/, 'what is typed is in the text');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('End');
        await waitFor(async () => (await box.evaluate(b => b.scrollLeft)) > 0);
        await page.keyboard.type(' // end');
        assert.match(await docText(), /"END"; \/\/ end\n```/);
        await page.keyboard.press('Enter');
        await page.keyboard.type('next();');
        assert.match(await docText(), /\/\/ end\nnext\(\);\n```\n\nBelow/, 'Enter makes a new line of code');
        await page.keyboard.press('ControlOrMeta+z');
        await waitFor(async () => !(await docText()).includes('next();'));
        await page.keyboard.press('Escape');
        await waitFor(async () => await editor.evaluate(el => document.activeElement === el));
        assert.equal(await cursorInTable(), false);
        // A new code block from the toolbar is a box with the caret in it.
        await setDoc('intro\n\n', 7);
        await toolbar.getByRole('button', { name: 'Text style' }).click();
        await page.getByRole('menuitemradio', { name: 'Code block' }).click();
        await waitFor(async () => await page.evaluate(() => document.activeElement?.matches('.cm-md-codeedit')));
        await page.keyboard.type('print(1)');
        assert.match(await docText(), /```\nprint\(1\)\n```/);
        await page.keyboard.press('Escape');
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
        await mode.getByRole('button', { name: 'Code' }).click();
        await toolbar.waitFor({ state: 'detached' });
        assert.equal(await mode.getByRole('button', { name: 'Code' }).getAttribute('aria-pressed'), 'true');
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
        const visual = mode.getByRole('button', { name: 'Visual' }), markdown = mode.getByRole('button', { name: 'Code' });
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

    // Last: it leaves a new document with no file open.
    await step('a picture in a text with no file (its address cannot be told) is drawn as missing, and Backspace and Delete take it whole', async () => {
        await page.keyboard.press('ControlOrMeta+n');
        await waitFor(async () => (await docText()) === '' && await page.locator('.headerbar .title').getByText('Untitled').count() > 0);
        await setDoc('text\n![a chart](images/none.png)\nafter', 0);
        await editor.locator('.cm-md-picture-missing', { hasText: 'a chart' }).waitFor();
        await clickBeforeText('after');
        await page.keyboard.press('Backspace');
        await editor.locator('.cm-md-picture.picked').waitFor();
        assert.equal(await docText(), 'text\n![a chart](images/none.png)\nafter', 'Backspace picks it, no hidden letter goes');
        await page.keyboard.press('Escape');
        // Delete right before it, on its own line: a list item's line, where its markup lies inside the item's.
        await setDoc('- item\n  ![a chart](images/none.png)\nafter', 9);
        await editor.locator('.cm-md-picture-missing', { hasText: 'a chart' }).waitFor();
        await page.keyboard.press('Delete');
        await editor.locator('.cm-md-picture.picked').waitFor();
        assert.equal(await docText(), '- item\n  ![a chart](images/none.png)\nafter', 'Delete picks it');
        await page.keyboard.press('Delete');
        assert.equal(await docText(), '- item\nafter', 'a second Delete removes it with its line');
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
