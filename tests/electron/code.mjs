import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, scratchFolder, stepper, waitFor } from './support.mjs';

const { scratch, notes } = scratchFolder('code');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = '// A workspace file, shown without executing it.\nexport function greet(name: string): string {\n    return `Hello, ${name}! 🐈`;\n}\n';
writeFileSync(join(notes, 'main.ts'), source);
writeFileSync(join(notes, 'unknown.custom'), '<script>throw new Error("never execute")</script>\n# not a heading\n');
writeFileSync(join(notes, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
const longSource = 'export const value = 42;\n'.repeat(30000);
writeFileSync(join(notes, 'large.ts'), longSource);
writeFileSync(join(notes, 'note.md'), '# A Markdown note\n');
writeFileSync(join(notes, 'unicode.txt'), '🐈x\r\nnext\r\n');
writeFileSync(join(notes, 'mixed.txt'), 'first\r\nsecond\nlast\r');
const app = await launchApp({ scratch, notes, settings: { welcomed: true } });
const { step, steps } = stepper({ echo: true });
const errors = [];
let failed = false;
try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1280, height: 800 });
    const open = async name => {
        await page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }).click();
        await page.getByRole('textbox', { name: `Code: ${name}`, exact: true }).waitFor();
    };
    await step('the workspace tree opens highlighted code with line numbers, not Markdown widgets', async () => {
        await open('main.ts');
        await page.locator('.code-page .tok-keyword').first().waitFor();
        assert.ok(await page.locator('.code-page .cm-lineNumbers').isVisible());
        assert.equal(await page.getByRole('textbox', { name: 'Code: main.ts' }).getAttribute('aria-readonly'), 'true');
        assert.equal(await page.locator('.code-page .cm-md-codebox').count(), 0);
        const status = page.getByRole('status', { name: 'Code status' });
        await status.getByText('Ln 1, Col 1', { exact: true }).waitFor();
        await status.getByText('UTF-8 · LF · 5 lines', { exact: true }).waitFor();
        await waitFor(async () => status.evaluate(element => Math.abs(element.getBoundingClientRect().bottom - innerHeight) <= 1));
        assert.equal(await page.locator('.statusbar').count(), 1, 'one shared footer');
        assert.equal(await page.locator('.code-page footer').count(), 0, 'no separate code footer');
    });
    await step('typing, paste, delete, and Save cannot change a code file', async () => {
        const code = page.getByRole('textbox', { name: 'Code: main.ts' });
        await code.click();
        await page.keyboard.type('SHOULD NOT APPEAR');
        await page.keyboard.press('Backspace');
        await page.keyboard.press(`${mod}+a`);
        await page.keyboard.press(`${mod}+c`);
        assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), source);
        await page.keyboard.press('Delete');
        await code.evaluate(element => {
            const data = new DataTransfer();
            data.setData('text/plain', 'SHOULD NOT PASTE');
            element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        });
        await page.keyboard.press(`${mod}+s`);
        assert.equal(readFileSync(join(notes, 'main.ts'), 'utf8'), source);
        assert.equal((await code.innerText()).trimEnd(), source.trimEnd());
    });
    await step('Find is available and unknown extensions stay plain text without executing markup', async () => {
        await page.getByRole('button', { name: 'Find', exact: true }).click();
        const search = page.locator('.code-page .find-panel input[name="search"]');
        assert.equal(await page.locator('.code-page .find-panel').getByRole('button', { name: 'Replace', exact: true }).isVisible(), false);
        await search.fill('greet');
        await search.press('Enter');
        await page.locator('.code-page .cm-searchMatch').first().waitFor();
        const status = page.getByRole('status', { name: 'Code status' });
        await status.getByText('Ln 2, Col 22', { exact: true }).waitFor();
        await status.getByText('5 selected', { exact: true }).waitFor();
        await search.press('Escape');
        await page.getByRole('textbox', { name: 'Code: main.ts' }).focus();
        await page.keyboard.press(`${mod}+f`);
        await search.waitFor();
        await open('unknown.custom');
        await page.getByText('Plain text', { exact: true }).waitFor();
        assert.ok((await page.locator('.code-page .cm-content').innerText()).includes('<script>'));
        await open('main.ts');
        assert.equal(await page.locator('.code-page').count(), 1);
    });
    await step('the code footer counts Unicode characters, follows navigation, and reports original line endings', async () => {
        await open('unicode.txt');
        const status = page.getByRole('status', { name: 'Code status' });
        await status.getByText('UTF-8 · CRLF · 3 lines', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Find', exact: true }).click();
        const search = page.locator('.code-page input[name="search"]');
        await search.fill('🐈');
        await status.getByText('Ln 1, Col 2', { exact: true }).waitFor();
        await status.getByText('1 selected', { exact: true }).waitFor();
        await search.press('Escape');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await status.getByText('Ln 1, Col 3', { exact: true }).waitFor();
        assert.equal(await status.getByText(/selected/).count(), 0);
        await open('mixed.txt');
        await status.getByText('UTF-8 · Mixed · 4 lines', { exact: true }).waitFor();
        await open('main.ts');
    });
    await step('code and Markdown share Find panel styling in both themes', async () => {
        const appearance = panel => panel.evaluate(element => {
            const style = getComputedStyle(element), parent = getComputedStyle(element.parentElement);
            const field = getComputedStyle(element.querySelector('input[name="search"]'));
            return { background: style.backgroundColor, color: style.color, font: style.font,
                padding: style.padding, panelBackground: parent.backgroundColor, border: parent.borderBottomColor,
                fieldFont: field.font, fieldColor: field.color, fieldBackground: field.backgroundColor };
        });
        for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme });
            await page.evaluate(() => { delete document.documentElement.dataset.theme; });
            await page.getByRole('treeitem', { name: /note\.md/ }).click();
            await page.locator('.text-editor:not([hidden]) .cm-content').focus();
            await page.keyboard.press(`${mod}+f`);
            const markdown = page.locator('.text-editor:not([hidden]) .find-panel');
            await markdown.waitFor();
            if (process.env.MARKWORK_CODE_SCREENSHOTS) {
                mkdirSync(process.env.MARKWORK_CODE_SCREENSHOTS, { recursive: true });
                await page.screenshot({ path: join(process.env.MARKWORK_CODE_SCREENSHOTS, `markdown-find-${theme}.png`), animations: 'disabled' });
            }
            const expected = await appearance(markdown);
            await open('main.ts');
            await page.getByRole('button', { name: 'Find', exact: true }).click();
            const code = page.locator('.code-page .find-panel');
            await code.waitFor();
            const backgrounds = await page.locator('.code-page .cm-editor').evaluate(editor => ({
                text: getComputedStyle(editor).backgroundColor,
                gutter: getComputedStyle(editor.querySelector('.cm-gutters')).backgroundColor,
            }));
            assert.equal(backgrounds.gutter, backgrounds.text, `line numbers share the editor background in ${theme} mode`);
            await waitFor(async () => JSON.stringify(await appearance(code)) === JSON.stringify(expected), 3000,
                async () => JSON.stringify({ markdown: expected, code: await appearance(code) }));
            assert.deepEqual(await appearance(code), expected);
            await code.locator('input[name="search"]').press('Escape');
        }
    });
    await step('screenshots cover light, dark, and narrow windows', async () => {
        if (!process.env.MARKWORK_CODE_SCREENSHOTS) return;
        mkdirSync(process.env.MARKWORK_CODE_SCREENSHOTS, { recursive: true });
        for (const [theme, width] of [['light', 1280], ['dark', 1280], ['dark', 560]]) {
            await page.emulateMedia({ colorScheme: theme });
            await page.evaluate(() => { delete document.documentElement.dataset.theme; });
            await page.setViewportSize({ width, height: 800 });
            await page.screenshot({ path: join(process.env.MARKWORK_CODE_SCREENSHOTS, `code-${theme}-${width}.png`), animations: 'disabled' });
            await page.getByRole('button', { name: 'Find', exact: true }).click();
            const field = page.locator('.code-page .find-panel input[name="search"]');
            await field.fill('greet');
            await field.press('Enter');
            await page.screenshot({ path: join(process.env.MARKWORK_CODE_SCREENSHOTS, `code-find-${theme}-${width}.png`), animations: 'disabled' });
            await field.press('Escape');
        }
        await page.setViewportSize({ width: 1280, height: 800 });
    });
    await step('Markdown and code side by side share one aligned status bar that follows pane focus', async () => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.getByRole('button', { name: 'Find', exact: true }).click();
        const leftSearch = page.locator('.code-page input[name="search"]');
        await leftSearch.fill('greet');
        await leftSearch.press('Enter');
        await leftSearch.press('Escape');
        await page.getByRole('button', { name: 'Split Right', exact: true }).click();
        const panes = page.locator('.pane');
        await waitFor(async () => await panes.count() === 2);
        await panes.nth(1).getByRole('button', { name: 'Find', exact: true }).click();
        const rightSearch = panes.nth(1).locator('.code-page input[name="search"]');
        await rightSearch.fill('Hello');
        await rightSearch.press('Enter');
        await page.getByRole('status', { name: 'Code status' }).getByText('Ln 3, Col 18', { exact: true }).waitFor();
        await panes.nth(0).getByRole('tab', { name: /main\.ts/ }).click();
        await page.getByRole('status', { name: 'Code status' }).getByText('Ln 2, Col 22', { exact: true }).waitFor();
        await rightSearch.focus();
        await page.getByRole('status', { name: 'Code status' }).getByText('Ln 3, Col 18', { exact: true }).waitFor();
        await page.getByRole('treeitem', { name: /note\.md/ }).dragTo(panes.nth(1).locator('.pane-body'), { targetPosition: { x: 200, y: 200 } });
        const markdown = panes.nth(1).locator('.text-editor:not([hidden]) .cm-content');
        await markdown.waitFor();
        const status = page.locator('.statusbar');
        await page.getByRole('status', { name: 'Document status' }).waitFor();
        assert.equal(await status.count(), 1);
        assert.equal(await panes.locator('footer').count(), 0, 'neither pane owns a footer');
        const bottoms = await panes.locator('.pane-body').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().bottom));
        assert.ok(Math.abs(bottoms[0] - bottoms[1]) <= 1, 'pane bottoms align');
        assert.ok(Math.abs(bottoms[0] - (await status.boundingBox()).y) <= 1, 'one footer below both panes');
        for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme });
            await page.evaluate(() => { delete document.documentElement.dataset.theme; });
            await panes.nth(0).getByRole('button', { name: 'Find', exact: true }).click();
            const field = panes.nth(0).locator('.code-page input[name="search"]');
            await field.fill('greet');
            await field.press('Enter');
            const codeStatus = page.getByRole('status', { name: 'Code status' });
            await codeStatus.getByText('5 selected', { exact: true }).waitFor();
            await codeStatus.getByText('Ln 2, Col 22', { exact: true }).waitFor();
            if (process.env.MARKWORK_CODE_SCREENSHOTS) {
                await page.screenshot({ path: join(process.env.MARKWORK_CODE_SCREENSHOTS, `split-code-${theme}.png`), animations: 'disabled' });
                if (theme === 'dark') {
                    await field.press('Escape');
                    await page.setViewportSize({ width: 560, height: 800 });
                    await page.screenshot({ path: join(process.env.MARKWORK_CODE_SCREENSHOTS, 'split-code-narrow.png'), animations: 'disabled' });
                    assert.equal(await status.count(), 1);
                    await page.setViewportSize({ width: 1400, height: 900 });
                }
            }
            await markdown.click();
            const noteStatus = page.getByRole('status', { name: 'Document status' });
            await noteStatus.getByText('3 words', { exact: true }).waitFor();
            assert.ok(!(await noteStatus.innerText()).includes('UTF-8'), 'code metadata does not leak into Markdown');
            const expectedNoteStatus = await noteStatus.innerText();
            if (process.env.MARKWORK_CODE_SCREENSHOTS) await page.screenshot({ path: join(process.env.MARKWORK_CODE_SCREENSHOTS, `split-markdown-${theme}.png`), animations: 'disabled' });
            await panes.nth(0).getByRole('tab', { name: /main\.ts/ }).click();
            await codeStatus.getByText('Ln 2, Col 22', { exact: true }).waitFor();
            await codeStatus.getByText('5 selected', { exact: true }).waitFor();
            await panes.nth(1).getByRole('tab', { name: /note\.md/ }).click();
            await noteStatus.waitFor();
            await waitFor(async () => await noteStatus.innerText() === expectedNoteStatus);
        }
        await panes.nth(0).getByRole('button', { name: 'Pane actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Join All Panes', exact: true }).click();
        await waitFor(async () => await panes.count() === 1);
        await open('main.ts');
        await page.setViewportSize({ width: 1280, height: 800 });
    });
    await step('a long file is virtualized and opens without rendering every line', async () => {
        const start = performance.now();
        await open('large.ts');
        await page.locator('.code-page .tok-keyword').first().waitFor();
        const elapsed = performance.now() - start;
        const lines = await page.locator('.code-page .cm-line').count();
        assert.ok(lines < 300, `only the viewport should render, got ${lines}`);
        console.log(`  performance: 30,001 lines, click to highlighted view ${elapsed.toFixed(1)} ms, ${lines} rendered lines`);
        const searchStart = performance.now();
        await page.getByRole('button', { name: 'Find', exact: true }).click();
        await page.locator('.code-page input[name="search"]').fill('value');
        await page.locator('.code-page .cm-searchMatch').first().waitFor();
        assert.ok((await page.locator('.code-page .find-panel .count').innerText()).includes('1000+'));
        console.log(`  performance: search across 30,000 matches ${(performance.now() - searchStart).toFixed(1)} ms, count capped at 1000+`);
        await page.locator('.code-page input[name="search"]').press('Escape');
        const selectStart = performance.now();
        await page.keyboard.press(`${mod}+a`);
        const status = page.getByRole('status', { name: 'Code status' });
        await status.getByText(`${longSource.length.toLocaleString()} selected`, { exact: true }).waitFor();
        console.log(`  performance: select all and update footer on ${longSource.length.toLocaleString()} characters ${(performance.now() - selectStart).toFixed(1)} ms`);
        const moveStart = performance.now();
        await page.keyboard.press('ArrowRight');
        await status.getByText(`Ln ${(30001).toLocaleString()}, Col 1`, { exact: true }).waitFor();
        console.log(`  performance: keyboard movement and footer update ${(performance.now() - moveStart).toFixed(1)} ms`);
    });
    await step('Markdown keeps its editor and binary files show an explanation instead of text', async () => {
        await page.getByRole('treeitem', { name: /note\.md/ }).click();
        await page.locator('.text-editor:not([hidden]) .cm-content').waitFor();
        await page.getByRole('treeitem', { name: /binary\.bin/ }).click();
        await page.getByText(/This file is binary or is not supported UTF-8 text/).waitFor();
        assert.equal(await page.locator('.code-page').count(), 0);
    });
    assert.deepEqual(errors, []);
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    await app.close();
    console.log(`${steps.length} code viewer steps, ${failed ? 'FAILED' : 'passed'}`);
}
if (failed) process.exitCode = 1;
