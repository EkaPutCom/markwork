// The editor scenarios of the GTK window (tests/gui/: format, syntax, lists, wikilink, image, imagezoom, codeblock,
// codecolor, conflicts), run against the Electron window with Playwright: the real main process, core, and renderer. The
// ones whose behaviour lives in the core are also in tests/unit/protocol.ts. Run with `npm run test:electron`.

import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'markwork-editor-'));
const notes = join(scratch, 'notes');
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
writeFileSync(join(notes, 'Journal', 'Daily Notes.md'), '# Daily\n');
writeFileSync(join(notes, 'projects', 'Meeting Notes.md'), '# Meeting\n');

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
    args: [repo, notes], cwd: repo,
    env: { ...process.env, XDG_CONFIG_HOME: join(scratch, 'config') },
});
let failed = false;
try {
    const page = await app.firstWindow();
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
        await page.keyboard.press('Control+b');
        assert.equal(await docText(), 'some **word**');
        await page.keyboard.press('Control+b');
        assert.equal(await docText(), 'some word', 'Ctrl+B again removes **');
        await setDoc('x', 0, 1);
        await page.keyboard.press('Control+i');
        assert.equal(await docText(), '*x*');
        await page.keyboard.press('Control+z');
        assert.equal(await docText(), 'x', 'undo restores the change');
        await setDoc('title', 0);
        await page.keyboard.press('Control+2');
        assert.equal(await docText(), '## title');
        await page.keyboard.press('Control+0');
        assert.equal(await docText(), 'title');
        await setDoc('a\nb', 0, 3);
        await page.keyboard.press('Control+Shift+q');
        assert.equal(await docText(), '> a\n> b', 'the quote is applied to several lines');
        await setDoc('GTK', 0, 3);
        await page.keyboard.press('Control+k');
        assert.equal(await docText(), '[GTK]()');
    });

    // ---------- syntax.ts ----------
    await step('syntax: markers hide away from the cursor and come back on its line', async () => {
        await setDoc('# Title\n\ntext **bold** here', 26);
        assert.deepEqual((await lineTexts()).filter(Boolean), ['Title', 'text **bold** here'], 'the # is hidden, the ** on the active line are not');
        await page.keyboard.press('Control+Home');
        assert.deepEqual((await lineTexts()).filter(Boolean), ['# Title', 'text bold here']);
        await setDoc('🎉 **a**\n', 9);
        assert.equal((await lineTexts())[0], '🎉 a', 'the offset is right after an emoji');
        await setDoc('# a\n\n**b**', 10);
        await page.keyboard.press('Control+/');
        assert.equal((await lineTexts())[0], '# a', 'source mode shows all markers');
        await page.keyboard.press('Control+/');
        assert.equal((await lineTexts())[0], 'a', 'and hides them again');
    });

    // ---------- lists.ts (and the table keys, in electron-smoke.mjs) ----------
    // ---------- wikilink.ts ----------
    await step('wikilink: [[note]] is a link with its brackets hidden on other lines', async () => {
        await setDoc('see [[Idea]] and [[Journal/Plan|plan]]\n\nother line');
        assert.equal((await lineTexts())[0], 'see Idea and plan');
        assert.deepEqual(await editor.locator('.cm-md-link').allTextContents(), ['Idea', 'plan']);
    });

    await step('wikilink: Ctrl+click opens the note in a new tab and jumps to the section', async () => {
        await setDoc('see [[Idea#Section Two]]\n\nx');
        await editor.locator('.cm-md-link').click({ modifiers: ['Control'] });
        await title.getByText('Idea.md').waitFor();
        await page.waitForFunction(() => document.querySelector('.statusbar')?.textContent?.includes('5'), null, { timeout: 5000 }).catch(() => {});
        assert.equal(await cursorLine(), 5, 'the cursor is on the heading Section Two');
        await open(/Source\.md/);
    });

    await step('wikilink: a note that does not exist opens empty and is not written to disk', async () => {
        await setDoc('continue to [[New Note]]\n\nx');
        await editor.locator('.cm-md-link').click({ modifiers: ['Control'] });
        await title.getByText('New Note.md').waitFor();
        assert.equal(await docText(), '');
        assert.ok(!existsSync(join(notes, 'New Note.md')));
        await open(/Source\.md/);
    });

    await step('wikilink: Ctrl+click on a relative link to an .md file opens it in Markwork', async () => {
        await setDoc('see [plan](Plan.md)\n\nx');
        await editor.locator('.cm-md-link').click({ modifiers: ['Control'] });
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
        await page.waitForTimeout(300);
        assert.equal(await popup.count(), 0, 'no suggestion without a match');
        await setDoc('[[]]', 2);
        await page.keyboard.type('Pla');
        await options().first().waitFor();
        await page.keyboard.press('Tab');
        assert.equal(await docText(), '[[Plan]]', 'Tab accepts, and ]] is not doubled');
        await setDoc('[[pl\n\nend', 9);
        await page.keyboard.press('Control+Home');
        await page.waitForTimeout(300);
        assert.equal(await popup.count(), 0, 'moving the cursor to an old [[ shows nothing');
    });

    // ---------- outline.ts (the side panel) ----------
    await step('outline: the rail opens the panel with the headings, and a click jumps to one', async () => {
        await open(/Idea\.md/);
        await page.getByRole('button', { name: 'Outline' }).click();
        const rows = page.locator('.outline .row');
        await rows.first().waitFor();
        assert.deepEqual(await rows.allTextContents(), ['Idea', 'Section Two']);
        await rows.nth(1).click();
        await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.view.state.selection.main.head > 10);
        assert.equal(await cursorLine(), 5);
        await page.getByRole('button', { name: 'Files' }).click();
        await page.getByRole('tree').waitFor();
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
        await page.keyboard.press('Control+/');
        await pictures.waitFor({ state: 'detached' });
        await page.keyboard.press('Control+/');
        await pictures.waitFor();
        await setDoc('text only');
        await pictures.waitFor({ state: 'detached' });
        await setDoc('| ![a](images/small.png) |\n| --- |\n\n```\n![b](images/small.png)\n```\n\nend', 70);
        await page.waitForTimeout(300);
        assert.equal(await pictures.count(), 0, 'images in table rows and code blocks are ignored');
    });

    // ---------- imagezoom.ts ----------
    const caption = () => page.locator('.image-viewer .caption').textContent();
    const percent = async () => Number((await caption()).match(/(\d+)%/)[1]);
    await step('imagezoom: a double click enlarges; small opens at 100%, large is fitted; Esc closes', async () => {
        await setDoc('![A small one](images/small.png)![A large one](images/large.png)', 0);
        await page.waitForFunction(() => document.querySelectorAll('.cm-md-pictures img').length === 2);
        await page.waitForFunction(() => [...document.querySelectorAll('.cm-md-pictures img')].every(i => i.naturalWidth > 0));
        await editor.locator('.cm-md-pictures img').first().dblclick();
        await page.locator('.image-viewer img').waitFor();
        assert.match(await caption(), /A small one/, 'the title is the alt text');
        await page.waitForFunction(() => document.querySelector('.image-viewer .caption').textContent.includes('100%'));
        await page.keyboard.press('Escape');
        await page.locator('.image-viewer').waitFor({ state: 'detached' });
        await editor.locator('.cm-md-pictures img').nth(1).dblclick();
        await page.locator('.image-viewer img').waitFor();
        assert.match(await caption(), /A large one/, 'a double click picks the right image on a line with several');
        await page.waitForFunction(() => document.querySelector('.image-viewer img').naturalWidth > 0);
        await page.waitForFunction(() => !document.querySelector('.image-viewer .caption').textContent.includes('100%'));
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
        await page.waitForFunction(fit => !document.querySelector('.image-viewer .caption').textContent.includes(`${fit}%`), fitted);
        assert.ok(await percent() > fitted, 'the wheel zooms in');
        const before = await img.evaluate(el => el.getBoundingClientRect().x);
        await page.mouse.move(600, 400);
        await page.mouse.down();
        await page.mouse.move(660, 430, { steps: 4 });
        await page.mouse.up();
        const after = await img.evaluate(el => el.getBoundingClientRect().x);
        assert.ok(after - before > 40, `dragging shifts the image (${before} → ${after}, ${await caption()})`);
        await page.keyboard.press('Escape');
    });

    await step('imagezoom: the Zoom Image command uses the cursor line, and says when there is no image', async () => {
        await setDoc('![A small one](images/small.png)\ntext', 0);
        await page.waitForFunction(() => document.querySelectorAll('.cm-md-pictures img').length === 1);
        await page.keyboard.press('Control+Shift+P');
        await page.locator('.palette input').fill('zoom image');
        await page.keyboard.press('Enter');
        await page.locator('.image-viewer img').waitFor();
        await page.keyboard.press('Escape');
        await setDoc('no image here', 0);
        await page.keyboard.press('Control+Shift+P');
        await page.locator('.palette input').fill('zoom image');
        await page.keyboard.press('Enter');
        await page.getByText('There is no image on this line').waitFor();
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
        await page.waitForTimeout(300);
        assert.equal(await box.count(), 0, 'a diagram is not a code box');
        await setDoc('a\n```js\nunclosed\n', 0);
        await page.waitForTimeout(300);
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
        await page.keyboard.press('Control+Shift+D');
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        assert.notEqual(await keywordColor(), light, 'dark mode uses other colors');
        await page.keyboard.press('Control+Shift+D');
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
        await setDoc('Title\n=======\n\ntext', 0);
        await page.waitForTimeout(200);
        assert.equal(await editor.locator('.cm-md-conflict').count(), 0, 'a heading underline is not a conflict');
    });
} catch {
    failed = true;
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron editor');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
