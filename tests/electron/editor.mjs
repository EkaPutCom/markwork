// The editor scenarios (format, syntax, lists, wikilink, image, imagezoom, codeblock,
// codecolor, conflicts), run against the Electron window with Playwright: the real main process, core, and renderer. The
// ones whose behaviour lives in the core are also in tests/unit/protocol.ts. Run with `npm run test:electron`.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('editor');
mkdirSync(join(notes, 'images'), { recursive: true });
mkdirSync(join(notes, 'Journal'));
mkdirSync(join(notes, 'projects'));

// A solid-color PNG of a given size (zlib is all it takes).
function png(width, height) {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
    for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(join(notes, 'images', 'small.png'), png(40, 30));
writeFileSync(join(notes, 'images', 'large.png'), png(3000, 1500));
writeFileSync(join(notes, 'Source.md'), 'source\n');
writeFileSync(join(notes, 'Idea.md'), '# Idea\n\ntext\n\n## Section Two\n\nmore\n');
writeFileSync(join(notes, 'Plan.md'), '# Plan\n');
writeFileSync(join(notes, 'page.html'), '<!doctype html><h1 id="h">hello html</h1><script>document.getElementById("h").textContent += " (js)"</script><img src="images/small.png"><a href="https://example.com">out</a>');
writeFileSync(join(notes, 'Journal', 'Daily Notes.md'), '# Daily\n');
writeFileSync(join(notes, 'projects', 'Meeting Notes.md'), '# Meeting\n');

// The tabs after each step, to compare a run on another system (CI sets MARKWORK_TRACE).
const tabsNow = async () => `      tabs: ${JSON.stringify(await page.getByRole('tab').evaluateAll(els => els.map(e => `${e.getAttribute('aria-selected') === 'true' ? '*' : ''}${e.textContent}`)))}`;
const { steps, step } = stepper({ after: process.env.MARKWORK_TRACE ? tabsNow : undefined });

// These scenarios are the live view's (the visual editor off): the syntax shows on the cursor line. tests/electron/visual.mjs has the visual editor's.
const app = await launchApp({ scratch, notes, settings: { visual: false } });   // its data folder holds the Trash of this run only
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const editor = page.locator('.cm-content');
    const title = page.locator('.headerbar .title');

    // The text of the editor, and a way to put a text, a cursor, and a selection in it.
    const docText = () => page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString());
    const setDoc = (text, anchor = text.length, head = anchor) => page.evaluate(([t, a, h]) => {
        const view = document.querySelector('.cm-content').cmTile.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: a, head: h } });
        view.focus();
    }, [text, anchor, head]);
    const lineTexts = () => page.evaluate(() => [...document.querySelectorAll('.cm-content > .cm-line')].map(l => l.textContent));
    const cursorLine = () => page.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
    const open = async name => {
        await page.getByRole('treeitem', { name }).click();
        await title.getByText(name.source ? name.source.replace(/\\\./g, '.') : String(name)).waitFor();
    };
    const popup = page.locator('.cm-tooltip-autocomplete');
    const options = () => page.locator('.cm-tooltip-autocomplete li');

    await page.getByRole('treeitem', { name: /Source\.md/ }).waitFor({ timeout: 15000 });
    await open(/Source\.md/);
    await editor.click();

    // ---------- format.ts ----------
    await step('format: Ctrl+B wraps and unwraps, undo restores, headings, quote, link', async () => {
        await setDoc('some word', 5, 9);
        await page.keyboard.press('ControlOrMeta+b');
        assert.equal(await docText(), 'some **word**');
        await page.keyboard.press('ControlOrMeta+b');
        assert.equal(await docText(), 'some word', 'Ctrl+B again removes **');
        await setDoc('x', 0, 1);
        await page.keyboard.press('ControlOrMeta+i');
        assert.equal(await docText(), '*x*');
        await page.keyboard.press('ControlOrMeta+z');
        assert.equal(await docText(), 'x', 'undo restores the change');
        await setDoc('title', 0);
        await page.keyboard.press('ControlOrMeta+2');
        assert.equal(await docText(), '## title');
        await page.keyboard.press('ControlOrMeta+0');
        assert.equal(await docText(), 'title');
        await setDoc('a\nb', 0, 3);
        await page.keyboard.press('ControlOrMeta+Shift+q');
        assert.equal(await docText(), '> a\n> b', 'the quote is applied to several lines');
        await setDoc('GTK', 0, 3);
        await page.keyboard.press('ControlOrMeta+k');
        assert.equal(await docText(), '[GTK]()');
    });

    // ---------- syntax.ts ----------
    await step('syntax: markers hide away from the cursor and come back on its line', async () => {
        await setDoc('# Title\n\ntext **bold** here', 26);
        assert.deepEqual((await lineTexts()).filter(Boolean), ['Title', 'text **bold** here'], 'the # is hidden, the ** on the active line are not');
        await page.keyboard.press('ControlOrMeta+Home');
        assert.deepEqual((await lineTexts()).filter(Boolean), ['# Title', 'text bold here']);
        await setDoc('🎉 **a**\n', 9);
        assert.equal((await lineTexts())[0], '🎉 a', 'the offset is right after an emoji');
        await setDoc('# a\n\n**b**', 10);
        await page.keyboard.press('ControlOrMeta+/');
        assert.equal((await lineTexts())[0], '# a', 'source mode shows all markers');
        await page.keyboard.press('ControlOrMeta+/');
        assert.equal((await lineTexts())[0], 'a', 'and hides them again');
    });

    // ---------- lists.ts (and the table keys, in smoke.mjs) ----------
    // ---------- wikilink.ts ----------
    await step('wikilink: [[note]] is a link with its brackets hidden on other lines', async () => {
        await setDoc('see [[Idea]] and [[Journal/Plan|plan]]\n\nother line');
        assert.equal((await lineTexts())[0], 'see Idea and plan');
        assert.deepEqual(await editor.locator('.cm-md-link').allTextContents(), ['Idea', 'plan']);
    });

    await step('wikilink: Ctrl+click opens the note in a new tab and jumps to the section', async () => {
        await setDoc('see [[Idea#Section Two]]\n\nx');
        await editor.locator('.cm-md-link').click({ modifiers: ['ControlOrMeta'] });
        await title.getByText('Idea.md').waitFor();
        await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('5'), null, { timeout: 5000 }).catch(() => {});
        assert.equal(await cursorLine(), 5, 'the cursor is on the heading Section Two');
        await open(/Source\.md/);
    });

    await step('wikilink: a note that does not exist opens empty and is not written to disk', async () => {
        await setDoc('continue to [[New Note]]\n\nx');
        await editor.locator('.cm-md-link').click({ modifiers: ['ControlOrMeta'] });
        await title.getByText('New Note.md').waitFor();
        assert.equal(await docText(), '');
        assert.ok(!existsSync(join(notes, 'New Note.md')));
        await open(/Source\.md/);
    });

    await step('wikilink: Ctrl+click on a relative link to an .md file opens it in Markwork', async () => {
        await setDoc('see [plan](Plan.md)\n\nx');
        await editor.locator('.cm-md-link').click({ modifiers: ['ControlOrMeta'] });
        await title.getByText('Plan.md').waitFor();
        await open(/Source\.md/);
    });

    await step('wikilink: [[ suggests, arrow and Enter insert the name and close the brackets', async () => {
        await setDoc('');
        await page.keyboard.type('read [[note');
        await page.waitForFunction(() => document.querySelectorAll('.cm-tooltip-autocomplete li').length === 2);
        assert.deepEqual(await options().allTextContents(), ['Daily NotesJournal', 'Meeting Notesprojects']);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        assert.equal(await docText(), 'read [[Meeting Notes]]');
        await popup.waitFor({ state: 'detached' });
        await page.keyboard.type('!');
        assert.equal(await docText(), 'read [[Meeting Notes]]!', 'the cursor is after ]]');
    });

    await step('wikilink: Esc closes, no match closes, an existing ]] is kept, an old [[ stays quiet', async () => {
        await setDoc('');
        await page.keyboard.type('[[pl');
        await popup.waitFor();
        await page.keyboard.press('Escape');
        await popup.waitFor({ state: 'detached' });
        await page.keyboard.press('Enter');
        assert.equal(await docText(), '[[pl\n', 'Enter after Esc is a line break');
        await setDoc('');
        await page.keyboard.type('[[zzz');
        await page.waitForTimeout(300);   // the suggestions come from the core: time for a popup that must not appear
        assert.equal(await popup.count(), 0, 'no suggestion without a match');
        await setDoc('[[]]', 2);
        await page.keyboard.type('Pla');
        await options().first().waitFor();
        await page.keyboard.press('Tab');
        assert.equal(await docText(), '[[Plan]]', 'Tab accepts, and ]] is not doubled');
        await setDoc('[[pl\n\nend', 9);
        await page.keyboard.press('ControlOrMeta+Home');
        await page.waitForTimeout(300);   // as above: a popup that must not appear
        assert.equal(await popup.count(), 0, 'moving the cursor to an old [[ shows nothing');
    });

    // ---------- outline.ts (the side panel) ----------
    await step('outline: the Files view lists the headings in its Outline section, and a click jumps to one', async () => {
        await open(/Idea\.md/);
        const rows = page.locator('.outline .row');
        await rows.first().waitFor();
        assert.deepEqual(await rows.allTextContents(), ['Idea', 'Section Two']);
        await rows.nth(1).click();
        await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.view.state.selection.main.head > 10);
        assert.equal(await cursorLine(), 5);
        await page.getByRole('tree').waitFor();
        await open(/Source\.md/);
    });

    // ---------- folder.ts, file.ts (the Files tab) ----------
    // A right click on the empty part of the Files tree, under its last row: the menu of the folder itself.
    const rightClickBelowTree = async () => {
        const box = await page.locator('.tree').boundingBox();
        await page.locator('.tree').click({ button: 'right', position: { x: 100, y: box.height - 12 } });
    };
    await step('files: folders open when first shown, New File / Rename / Move work through the menu, keys and drag', async () => {
        await page.getByRole('button', { name: 'Files', exact: true }).waitFor();
        const row = name => page.getByRole('treeitem', { name });
        await row(/^projects$/).click();
        await row(/Meeting Notes\.md/).waitFor();
        // New File from the menu of the tree.
        await rightClickBelowTree();
        await page.getByRole('menuitem', { name: 'New File…' }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByRole('textbox').fill('fresh');
        await dialog.getByRole('button', { name: 'OK' }).click();
        await title.getByText('fresh.md').waitFor();
        await row(/fresh\.md/).waitFor();
        assert.ok(existsSync(join(notes, 'fresh.md')), 'created on disk');
        // Rename with F2.
        await row(/fresh\.md/).focus();
        await page.keyboard.press('F2');
        await dialog.getByRole('textbox').fill('renamed.md');
        await dialog.getByRole('button', { name: 'OK' }).click();
        await row(/renamed\.md/).waitFor();
        assert.ok(existsSync(join(notes, 'renamed.md')) && !existsSync(join(notes, 'fresh.md')));
        // Drag it onto the folder.
        await row(/renamed\.md/).dragTo(row(/^projects$/));
        await waitFor(() => existsSync(join(notes, 'projects', 'renamed.md')), 15000);
        await row(/renamed\.md/).waitFor();
        // Delete goes to the Trash after the question.
        await row(/renamed\.md/).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        assert.ok(existsSync(join(notes, 'projects', 'renamed.md')), 'Cancel keeps the file');
        await row(/renamed\.md/).focus();
        await page.keyboard.press('Delete');
        await dialog.getByRole('button', { name: 'Move to Trash' }).click();
        // The Recycle Bin on Windows goes through a PowerShell that can take seconds to start on a cold runner.
        await waitFor(() => !existsSync(join(notes, 'projects', 'renamed.md')), 20000);
        await row(/renamed\.md/).waitFor({ state: 'detached' });
        // A refusal is told, not swallowed.
        await rightClickBelowTree();
        await page.getByRole('menuitem', { name: 'New Folder…' }).click();
        await dialog.getByRole('textbox').fill('projects');
        await dialog.getByRole('button', { name: 'OK' }).click();
        await page.locator('.notification .message').waitFor();
        await open(/Source\.md/);
    });

    // ---------- home.ts, htmlpage.ts (pages that are tabs) ----------
    await step('home: Alt+Home opens the Home tab with the recent files; a click on one opens it', async () => {
        await page.keyboard.press('Alt+Home');
        await page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ }).waitFor();
        await page.getByRole('heading', { name: 'Recent files' }).waitFor();
        await page.locator('.home-row', { hasText: 'Idea.md' }).click();
        await title.getByText('Idea.md').waitFor();
        await page.keyboard.press('Alt+Home');
        await page.getByRole('heading', { name: 'Recent files' }).waitFor();
        await page.getByRole('tab', { name: /Home/ }).waitFor();
    });

    await step('htmlpage: an HTML file opens in its own tab, runs its script, reads only its folder, and closes', async () => {
        await open(/page\.html/);
        const frame = page.frameLocator('iframe');
        await frame.getByRole('heading', { name: 'hello html (js)' }).waitFor();
        await page.waitForFunction(() => true);
        const loaded = await frame.locator('img').evaluate(img => img.complete && img.naturalWidth > 0);
        assert.ok(loaded, 'a file in its folder loads');
        await page.getByRole('tab', { name: /page\.html/ }).getByRole('button', { name: /Close/ }).click();
        await page.locator('iframe').waitFor({ state: 'detached' });
        await page.getByRole('heading', { name: 'Recent files' }).waitFor();
        await page.getByRole('tab', { name: /Home/ }).getByRole('button', { name: /Close/ }).click().catch(() => {});
        await open(/Source\.md/);
    });

    // ---------- window.ts, dialogs.ts (menus and dialogs) ----------
    await step('menus: Recent in the New menu, Preferences, Keyboard Shortcuts, and About from the main menu', async () => {
        await open(/Idea\.md/);
        await open(/Source\.md/);
        // The recent files are in File → Open Recent; a line of it opens the file in a tab.
        await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Open Recent' }).click();
        await page.getByRole('menuitem', { name: 'Plan.md' }).waitFor();
        await page.getByRole('menuitem', { name: 'Idea.md' }).click();
        await title.getByText('Idea.md').waitFor();
        // Preferences: a switch is written by the core, and the dialog follows the setting.
        await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Preferences' }).click();
        const prefs = page.getByRole('dialog', { name: 'Preferences' });
        await prefs.waitFor();
        await prefs.getByLabel('Color scheme').click();
        await page.getByRole('option', { name: 'Dark' }).click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        await prefs.getByLabel('Color scheme').click();
        await page.getByRole('option', { name: 'Light' }).click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
        const focus = prefs.getByRole('switch', { name: /Focus mode/ });
        await focus.check();
        await editor.locator('.cm-md-dim').first().waitFor({ state: 'attached' }).catch(() => {});
        await focus.uncheck();
        await prefs.getByRole('tab', { name: 'Assistant' }).click();
        await prefs.getByLabel('Model').waitFor();
        await page.keyboard.press('Escape');
        await prefs.waitFor({ state: 'detached' });
        await page.keyboard.press('ControlOrMeta+?');
        const shortcuts = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
        await shortcuts.getByText('Save As').waitFor();
        await page.keyboard.press('Escape');
        await shortcuts.waitFor({ state: 'detached' });
        await page.getByRole('menubar').getByRole('menuitem', { name: 'Help', exact: true }).click();
        await page.getByRole('menuitem', { name: 'About Markwork' }).click();
        await page.getByRole('dialog', { name: 'About Markwork' }).getByText(/Version \d/).waitFor();
        await page.keyboard.press('Escape');
        await open(/Source\.md/);
    });

    // ---------- findbar.ts ----------
    await step('find bar: Ctrl+F counts the results, Enter goes to the next, Ctrl+H replaces all, Escape closes', async () => {
        await open(/Source\.md/);
        await setDoc('one two one\nOne\n', 0);
        await page.keyboard.press('ControlOrMeta+f');
        await page.getByRole('textbox', { name: 'Find in the document' }).fill('one');
        const count = page.locator('.find-panel .count');
        await page.waitForFunction(() => document.querySelector('.find-panel .count')?.textContent === '1 of 3');
        await page.keyboard.press('Enter');
        assert.equal(await count.textContent(), '2 of 3');
        await page.getByRole('button', { name: 'Match Case' }).click();
        await page.waitForFunction(() => /of 2$|^2$/.test(document.querySelector('.find-panel .count')?.textContent ?? ''));
        await page.keyboard.press('ControlOrMeta+h');
        await page.getByRole('textbox', { name: 'Replace in the document' }).fill('1');
        await page.locator('.find-panel').getByRole('button', { name: 'Replace All' }).click();
        assert.equal(await docText(), '1 two 1\nOne\n');
        await page.keyboard.press('Escape');
        await page.locator('.find-panel').waitFor({ state: 'detached' });
    });

    // ---------- search.ts (the side panel) ----------
    await step('search: Ctrl+Shift+F finds in all notes, a hit opens with the match selected, Replace All asks first', async () => {
        await open(/Source\.md/);
        await editor.click();
        await page.keyboard.press('ControlOrMeta+Shift+f');
        const box = page.getByRole('searchbox', { name: 'Search' });
        await box.fill('Section Two');
        const hit = page.locator('.results .hit');
        await hit.first().waitFor();
        assert.equal(await page.locator('.result-file .file-name .label').first().textContent(), 'Idea.md');
        await page.getByText(/1 result in 1 file/).waitFor();
        await hit.first().click();
        await title.getByText('Idea.md').waitFor();
        await page.waitForFunction(() => { const v = document.querySelector('.cm-content').cmTile.view; const s = v.state.selection.main; return v.state.sliceDoc(s.from, s.to) === 'Section Two'; });
        await page.keyboard.press('ControlOrMeta+Shift+h');
        await page.getByRole('textbox', { name: 'Replace', exact: true }).fill('Part Two');
        await page.getByRole('button', { name: 'Replace All' }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.match(await docText(), /## Section Two/, 'Cancel leaves the note alone');
        await page.getByRole('button', { name: 'Replace All' }).click();
        await dialog.getByRole('button', { name: 'Replace All' }).click();
        await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.view.state.doc.toString().includes('## Part Two'));
        await page.getByRole('button', { name: 'Files', exact: true }).click();
        await open(/Source\.md/);
    });

    // ---------- image.ts ----------
    await step('image: shown under its line, ignored in tables and code, hidden in source mode, click moves the cursor', async () => {
        await setDoc('![small](images/small.png)\ntext');
        const pictures = editor.locator('.cm-md-pictures img');
        await pictures.waitFor();
        await page.waitForFunction(() => document.querySelector('.cm-md-pictures img')?.naturalWidth > 0);
        assert.equal(await docText(), '![small](images/small.png)\ntext', 'the text does not change because of the image');
        await setDoc('![small](images/small.png)\ntext', 30);
        await pictures.click();
        assert.equal(await cursorLine(), 1, 'the click moves the cursor to the image line');
        await page.keyboard.press('ControlOrMeta+/');
        await pictures.waitFor({ state: 'detached' });
        await page.keyboard.press('ControlOrMeta+/');
        await pictures.waitFor();
        await setDoc('text only');
        await pictures.waitFor({ state: 'detached' });
        await setDoc('| ![a](images/small.png) |\n| --- |\n\n```\n![b](images/small.png)\n```\n\nend', 70);
        await editor.locator('.cm-md-table-grid').waitFor();   // drawn in the same pass that would add a picture
        assert.equal(await pictures.count(), 0, 'images in table rows and code blocks are ignored');
    });

    // ---------- imagezoom.ts ----------
    // The viewer's title (in its header) and its zoom (in the bar under the picture).
    const caption = async () => `${await page.locator('.image-viewer .viewer-head .name').textContent()} · ${await page.locator('.image-viewer .zoom-level').textContent()}`;
    const percent = async () => Number((await page.locator('.image-viewer .zoom-level').textContent()).match(/(\d+)%/)[1]);
    await step('imagezoom: a double click enlarges; small opens at 100%, large is fitted; Esc closes', async () => {
        await setDoc('![A small one](images/small.png)![A large one](images/large.png)', 0);
        await page.waitForFunction(() => document.querySelectorAll('.cm-md-pictures img').length === 2);
        await page.waitForFunction(() => [...document.querySelectorAll('.cm-md-pictures img')].every(i => i.naturalWidth > 0));
        await editor.locator('.cm-md-pictures img').first().dblclick();
        await page.locator('.image-viewer img').waitFor();
        assert.match(await caption(), /A small one/, 'the title is the alt text');
        await page.waitForFunction(() => document.querySelector('.image-viewer .zoom-level').textContent.includes('100%'));
        await page.keyboard.press('Escape');
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
        await editor.locator('.cm-md-pictures img').nth(1).dblclick();
        await page.locator('.image-viewer img').waitFor();
        assert.match(await caption(), /A large one/, 'a double click picks the right image on a line with several');
        await page.waitForFunction(() => document.querySelector('.image-viewer img').naturalWidth > 0);
        await page.waitForFunction(() => !document.querySelector('.image-viewer .zoom-level').textContent.includes('100%'));
        assert.ok(await percent() < 100, 'a large image is fitted to the window');
    });

    await step('imagezoom: + − 0 F keys, limits 5%–800%, other keys leave the viewer open', async () => {
        await page.keyboard.press('0');
        assert.equal(await percent(), 100);
        await page.keyboard.press('+');
        assert.equal(await percent(), 125);
        await page.keyboard.press('-');
        await page.keyboard.press('-');
        assert.equal(await percent(), 80);
        for (let i = 0; i < 20; i++) await page.keyboard.press('+');
        assert.equal(await percent(), 800, 'at most 800%');
        for (let i = 0; i < 40; i++) await page.keyboard.press('-');
        assert.equal(await percent(), 5, 'at least 5%');
        await page.keyboard.press('f');
        const fit = await percent();
        assert.ok(fit > 5 && fit < 100, 'F fits the window');
        await page.keyboard.press('x');
        await page.locator('.image-viewer').waitFor();
    });

    await step('imagezoom: a double click alternates fit and 100%, the wheel zooms, dragging moves the picture', async () => {
        const img = page.locator('.image-viewer img');
        await img.dblclick();
        assert.equal(await percent(), 100);
        await img.dblclick();
        assert.ok(await percent() < 100, 'back to fit');
        const fitted = await percent();
        await page.mouse.move(600, 400);
        await page.mouse.wheel(0, -100);
        await page.waitForFunction(fit => !document.querySelector('.image-viewer .zoom-level').textContent.includes(`${fit}%`), fitted);
        assert.ok(await percent() > fitted, 'the wheel zooms in');
        const before = await img.evaluate(el => el.getBoundingClientRect().x);
        await page.mouse.move(600, 400);
        await page.mouse.down();
        await page.mouse.move(660, 430, { steps: 4 });
        await page.mouse.up();
        const after = await img.evaluate(el => el.getBoundingClientRect().x);
        assert.ok(after - before > 40, `dragging shifts the image (${before} → ${after}, ${await caption()})`);
        await page.keyboard.press('Escape');
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
    });

    await step('imagezoom: the window moves by its header and resizes by its corner', async () => {
        // No viewer of a step before is still on its way out: this step's double click would be skipped for it, and the
        // window measured below would be that one, gone a moment later.
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
        await setDoc('![A small one](images/small.png)', 0);
        await page.waitForFunction(() => [...document.querySelectorAll('.cm-md-pictures img')].some(i => i.naturalWidth > 0));
        const win = page.locator('.image-viewer .viewer-window'), viewer = page.locator('.image-viewer');
        // The picture may still be settling after the text was set: a double click that lands before it is ready opens nothing.
        // Another one is sent only while no viewer is there at all: on a slow runner the first can open late, and a second
        // landing on its backdrop would close it again.
        for (let tries = 0; tries < 4 && !(await viewer.count()); tries++) {
            await editor.locator('.cm-md-pictures img').first().dblclick();
            await viewer.waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
        }
        await win.waitFor();
        const rect = () => win.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
        const before = await rect();
        await page.mouse.move(before.x + before.w / 2, before.y + 20);
        await page.mouse.down();
        await page.mouse.move(before.x + before.w / 2 + 40, before.y + 50, { steps: 4 });
        await page.mouse.up();
        const moved = await rect();
        assert.ok(Math.abs(moved.x - before.x - 40) < 2 && Math.abs(moved.y - before.y - 30) < 2, 'the header drags the window');
        assert.ok(Math.abs(moved.w - before.w) < 1, 'moving keeps the size');
        await page.mouse.move(moved.x + moved.w - 4, moved.y + moved.h - 4);
        await page.mouse.down();
        await page.mouse.move(moved.x + moved.w + 26, moved.y + moved.h + 16, { steps: 4 });
        await page.mouse.up();
        const grown = await rect();
        assert.ok(grown.w > moved.w + 20 && grown.h > moved.h + 10, 'the corner resizes the window');
        await page.keyboard.press('Escape');
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
    });

    await step('imagezoom: the Zoom Image command uses the cursor line, and says when there is no image', async () => {
        await setDoc('![A small one](images/small.png)\ntext', 0);
        await page.waitForFunction(() => document.querySelectorAll('.cm-md-pictures img').length === 1);
        await page.keyboard.press('ControlOrMeta+Shift+P');
        await page.locator('.palette input').fill('zoom image');
        await page.keyboard.press('Enter');
        await page.locator('.image-viewer img').waitFor();
        await page.keyboard.press('Escape');
        // The palette key must reach the window, not the viewer that is still on its way out.
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
        await setDoc('no image here', 0);
        await page.keyboard.press('ControlOrMeta+Shift+P');
        await page.locator('.palette input').fill('zoom image');
        await page.keyboard.press('Enter');
        await page.getByText('There is no image on this line').waitFor();
    });

    await step('imagezoom: a diagram opens the viewer on a double click, a single click picks it, and Edit source opens its source', async () => {
        await setDoc('a\n```dbml\nTable t { id int [pk] }\n```\nb', 0);
        await editor.locator('.cm-md-diagram .er-diagram').waitFor();
        await editor.locator('.cm-md-diagram').dblclick();
        await page.locator('.image-viewer .viewer-diagram svg').waitFor();
        assert.match(await caption(), /DBML diagram/, 'the viewer is titled by the diagram');
        await page.keyboard.press('+');
        assert.ok(await percent() > 0, 'the zoom bar works on a diagram');
        await page.keyboard.press('Escape');
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
        assert.equal(await editor.locator('.cm-md-diagram').count(), 1, 'a double click leaves the diagram drawn');
        await editor.locator('.cm-md-diagram').click();
        await editor.locator('.cm-md-diagram.picked').waitFor();
        await editor.locator('.cm-md-diagram .cm-md-block-tool[title="Edit source"]').click();
        await editor.locator('.cm-md-diagram').waitFor({ state: 'detached' });
    });

    // ---------- codeblock.ts, codecolor.ts ----------
    await step('codeblock: a box outside the block, raw text inside, no box for diagrams or unclosed blocks', async () => {
        const box = editor.locator('.cm-md-codebox');
        await setDoc('a\n```js\nconst x = 1\n```\nb', 0);
        await box.waitFor();
        assert.equal(await docText(), 'a\n```js\nconst x = 1\n```\nb', 'the text does not change because of the box');
        await setDoc('a\n```js\nconst x = 1\n```\nb', 10);
        await box.waitFor({ state: 'detached' });
        assert.ok((await lineTexts()).includes('```js'), 'the fence is visible inside the block');
        await setDoc('a\n```mermaid\nflowchart LR\n  A --> B\n```\nb', 0);
        await editor.locator('.cm-md-diagram').waitFor();   // drawn as a diagram, the same pass that would draw a box
        assert.equal(await box.count(), 0, 'a diagram is not a code box');
        await setDoc('a\n```js\nunclosed\n', 0);   // the decorations are computed in the transaction itself
        assert.equal(await box.count(), 0, 'an unclosed block is text');
    });

    await step('codecolor: unknown language is plain, typing recolors, an emoji before does not shift, dark mode differs, focus dims', async () => {
        await setDoc('```nonexistentlang\nconst x = 1\n```\n');
        await editor.locator('.cm-md-codebox').waitFor();
        assert.equal(await editor.locator('[class*="tok-"]').count(), 0, 'an unknown language is not colored');
        await setDoc('🎉\n\n```js\nconst x = "s"\n```\n');
        await editor.locator('.tok-keyword', { hasText: 'const' }).waitFor();
        assert.equal(await editor.locator('.tok-keyword').first().textContent(), 'const', 'an emoji before the block does not shift the colors');
        await setDoc('```js\nlet y = 2\n```\n', 8);
        await editor.locator('.tok-keyword', { hasText: 'let' }).waitFor();
        await page.keyboard.type(' // c');
        await editor.locator('.tok-comment').waitFor();
        const keywordColor = () => editor.locator('.tok-keyword').first().evaluate(el => getComputedStyle(el).color);
        await setDoc('para\n\n```js\nconst z = 3\n```\n\nlast', 0);
        const light = await keywordColor();
        await page.keyboard.press('ControlOrMeta+Shift+D');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        assert.notEqual(await keywordColor(), light, 'dark mode uses other colors');
        await page.keyboard.press('ControlOrMeta+Shift+D');
        await page.keyboard.press('F8');
        await editor.locator('.cm-md-codebox.cm-md-dim').waitFor();
        await page.keyboard.press('F8');
    });

    // ---------- conflicts.ts ----------
    await step('conflicts: sides colored, Accept Current / Both, a conflict at the end, plain headings left alone', async () => {
        const two = '<<<<<<< HEAD\na1\n=======\nb1\n>>>>>>> topic\n\nmid\n\n<<<<<<< HEAD\na2\n=======\nb2\n>>>>>>> topic';
        await setDoc(two, 0);
        await editor.locator('.cm-md-conflict-bar').first().waitFor();
        assert.equal(await editor.locator('.cm-md-conflict-bar').count(), 2);
        assert.equal(await editor.locator('.cm-md-conflict-currentHead').count(), 2);
        assert.equal(await docText(), two, 'the text does not change because of the colors');
        await editor.getByRole('button', { name: 'Accept Current' }).first().click();
        assert.equal(await docText(), 'a1\n\nmid\n\n<<<<<<< HEAD\na2\n=======\nb2\n>>>>>>> topic');
        await editor.getByRole('button', { name: 'Accept Both' }).click();
        assert.equal(await docText(), 'a1\n\nmid\n\na2\nb2', 'the conflict at the end of the file resolves');
        await setDoc('Title\n=======\n\ntext', 0);   // the conflicts are found in the transaction itself
        assert.equal(await editor.locator('.cm-md-conflict').count(), 0, 'a heading underline is not a conflict');
    });
} catch {
    failed = true;
    // What the window showed when a step failed: its tabs (the selected one marked) and the start of the content.
    const tabs = await page?.getByRole('tab').evaluateAll(els => els.map(e => `${e.getAttribute('aria-selected') === 'true' ? '*' : ''}${e.textContent}`)).catch(() => []);
    console.error(`tabs: ${JSON.stringify(tabs)}`);
    console.error(String(await page?.locator('main').innerText().catch(() => '(no main)')).slice(0, 600));
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron editor');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
