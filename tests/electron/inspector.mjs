// The Editor Inspector (docs/design/debugger.md), against the Electron window with Playwright: it is there only in dev
// mode; it shows what the visual editor hides; the recorder keeps the keys and what they did; the checks pass on real
// typing and catch a transaction that breaks a rule of the visual editor. Also how long a transaction takes in a normal
// start, where the recorder is the only part that runs.

import assert from 'node:assert/strict';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('inspector');
writeFileSync(join(notes, 'plan.md'), '# Plan\n\nsome **bold** text\n');
copyFileSync(new URL('../samples/all-formats.md', import.meta.url), join(notes, 'all.md'));

const { steps, step } = stepper();
let failed = false;

// Opens a file of the folder and waits for its tab.
async function openFile(page, name) {
    await page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }).click();
    await page.locator('.headerbar .title').getByText(name).waitFor();
}
const view = 'document.querySelector(".cm-content").cmTile.view';
const setDoc = (page, text, anchor) => page.evaluate(([t, a]) => {
    const v = document.querySelector('.cm-content').cmTile.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: a } });
    v.focus();
}, [text, anchor]);

async function inNormalStart() {
    const app = await launchApp({ scratch, notes });
    try {
        const page = await app.firstWindow();
        await page.setViewportSize({ width: 1400, height: 900 });
        await openFile(page, 'plan.md');

        await step('a normal start has no inspector: Ctrl+Alt+I does nothing', async () => {
            await page.locator('.cm-content').click();
            await page.keyboard.press('Control+Alt+i');
            await page.waitForTimeout(300);   // a pause to show that nothing happens
            assert.equal(await page.getByRole('region', { name: 'Editor Inspector' }).count(), 0);
        });

        await openFile(page, 'all.md');
        await step('performance: a typed character in a long text, with only the recorder running', async () => {
            const result = await page.evaluate(`(() => {
                const v = ${view};
                v.dispatch({ selection: { anchor: v.state.doc.length } });
                const n = 2000, start = performance.now();
                for (let i = 0; i < n; i++) {
                    const at = v.state.selection.main.head;
                    v.dispatch({ changes: { from: at, insert: i % 60 === 59 ? '\\n' : 'x' }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
                }
                return { n, ms: performance.now() - start, length: v.state.doc.length };
            })()`);
            const each = result.ms / result.n;
            console.log(`    ${result.n} transactions on ${result.length} characters: ${each.toFixed(3)} ms each`);
            assert.ok(each < 16, 'typing stays inside a frame');
        });
    } finally {
        await close(app);
    }
}

async function inDevMode() {
    const app = await launchApp({ scratch, notes, env: { MARKWORK_DEV: '1' } });
    try {
        const page = await app.firstWindow();
        await page.setViewportSize({ width: 1400, height: 900 });
        await openFile(page, 'plan.md');
        const inspector = page.getByRole('region', { name: 'Editor Inspector' });
        const source = inspector.getByLabel('Source');
        const tab = name => inspector.getByRole('tab', { name });

        await step('dev mode: Ctrl+Alt+I opens the inspector and closes it again', async () => {
            await page.locator('.cm-content').click();
            await page.keyboard.press('Control+Alt+i');
            await inspector.waitFor();
            await page.keyboard.press('Control+Alt+i');
            await inspector.waitFor({ state: 'detached' });
            await page.keyboard.press('Control+Alt+i');
            await inspector.waitFor();
        });

        await step('the source shows what the visual editor hides on the cursor line, with offsets', async () => {
            await setDoc(page, '# Plan\n\nsome **bold** text', 15);
            await waitFor(async () => (await source.locator('.ins-line.current .ins-hidden').allTextContents()).join(' ') === '** **');
            assert.equal(await source.locator('.ins-line.current .ins-gutter').textContent(), '38', 'line 3 starts at offset 8');
            assert.match(await inspector.locator('.ins-strip').textContent(), /cursor 15.*in prefix no/);
        });

        await step('the recorder keeps each key with the transaction it made', async () => {
            await page.keyboard.type('ab');
            await page.keyboard.press('Backspace');
            const rows = inspector.locator('.ins-list tbody tr');
            await waitFor(async () => (await rows.first().textContent()).includes('delete.backward'));
            const first = await rows.first().locator('td').allTextContents();
            assert.equal(first[2], 'Backspace');
            assert.match(first[3], /−"b" 16–17/);
            assert.match(await rows.nth(1).textContent(), /input\.type.*b.*\+"b" @16/);
        });

        await step('the checks pass on real typing', async () => {
            await page.keyboard.press('End');
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Home');
            await tab('Checks').click();
            const checks = inspector.locator('.ins-check');
            await waitFor(async () => /\d+ transactions checked/.test(await checks.first().textContent()));
            assert.equal(await inspector.locator('.ins-state.fail, .ins-state.warn').count(), 0, (await checks.allTextContents()).join('\n'));
        });

        await step('the checks stay quiet on typing, deleting, undo, and moving the cursor in the long sample, in each mode', async () => {
            await openFile(page, 'all.md');
            const lines = page.locator('.cm-content > .cm-line');
            for (const n of [3, 12, 25, 40]) {
                await lines.nth(n).click();
                await page.keyboard.press('End');
                await page.keyboard.type('xy');
                await page.keyboard.press('Backspace');
                await page.keyboard.press('ControlOrMeta+z');
                await page.keyboard.press('Home');
            }
            // The cursor through the whole sample, by keys and clicks, in the visual editor, the live view, and focus mode:
            // kept-drawing compares each drawing kept over a move with a new one.
            const walk = async () => {
                await lines.first().click();
                await page.keyboard.press('ControlOrMeta+Home');
                for (let i = 0; i < 70; i++) await page.keyboard.press('ArrowDown');
                for (const n of [2, 9, 17, 30]) await lines.nth(n).click();
            };
            await walk();
            await page.keyboard.press('Control+Shift+m');   // the live view
            await walk();
            await page.keyboard.press('F8');   // focus mode
            await walk();
            await page.keyboard.press('F8');
            await page.keyboard.press('Control+Shift+m');
            await tab('Checks').click();
            const checks = inspector.locator('.ins-check');
            assert.equal(await checks.count(), 10, 'every check is listed');
            await waitFor(async () => /\d+ transactions checked/.test(await checks.filter({ hasText: 'undo' }).textContent()));
            // draw-time is left out: a whole drawing of this sample is near its 8 ms, and CI machines are slower.
            const loud = checks.filter({ hasNotText: 'draw-time' }).locator('.ins-state.fail, .ins-state.warn');
            assert.equal(await loud.count(), 0, (await checks.allTextContents()).join('\n'));
            await openFile(page, 'plan.md');
        });

        await step('a diagram opens to its source when the selection enters it and closes when it leaves, with no drawing kept wrongly', async () => {
            await setDoc(page, 'intro\n\n```mermaid\ngraph TD\nA-->B\n```\n\nafter', 0);
            const shown = () => page.evaluate(() => [...document.querySelectorAll('.cm-content > .cm-line')].map(l => l.textContent).join('|'));
            await waitFor(async () => !(await shown()).includes('graph TD'));
            await page.evaluate(`${view}.dispatch({ selection: { anchor: 20 } })`);   // into "graph TD"
            await waitFor(async () => (await shown()).includes('graph TD'));
            await page.evaluate(`${view}.dispatch({ selection: { anchor: 1 } })`);
            await waitFor(async () => !(await shown()).includes('graph TD'));
            await tab('Checks').click();
            const kept = inspector.locator('.ins-check', { hasText: 'kept-drawing' });
            await waitFor(async () => /transactions checked/.test(await kept.textContent()));
            assert.equal(await kept.locator('.ins-state.fail').count(), 0, await kept.textContent());
        });

        await step('a Backspace that removes a hidden * fails backspace-visible, and the transaction says why', async () => {
            await setDoc(page, 'some **bold** text', 13);
            await page.evaluate(`${view}.dispatch({ changes: { from: 12, to: 13 }, userEvent: 'delete.backward' })`);
            const bad = inspector.locator('.ins-check', { hasText: 'backspace-visible' });
            await waitFor(async () => await bad.locator('.ins-state.fail').count() === 1);
            assert.match(await bad.textContent(), /removed 12–13 "\*" with the cursor at 13: a part of the hidden "\*\*" at 11–13/);
            await bad.getByRole('button', { name: /Show #/ }).click();
            assert.match(await inspector.locator('.ins-detail').textContent(), /delete\.backward.*backspace-visible/);
            assert.equal(await inspector.locator('.ins-list tr.picked.fail').count(), 1);
        });

        await step('a cursor put inside a hidden prefix fails prefix-guard', async () => {
            await setDoc(page, '# Title', 7);
            await page.evaluate(`${view}.dispatch({ selection: { anchor: 1 }, filter: false })`);
            await tab('Checks').click();
            const bad = inspector.locator('.ins-check', { hasText: 'prefix-guard' });
            await waitFor(async () => await bad.locator('.ins-state.fail').count() === 1);
            assert.match(await bad.textContent(), /the cursor is at 1, inside the hidden prefix 0–2 "# " of line 1/);
            assert.match(await inspector.locator('.ins-strip').textContent(), /in prefix yes/);
        });

        await step('Paused shows the text as a transaction left it, and steps back and forward', async () => {
            await setDoc(page, 'one', 3);
            await page.keyboard.type('xy');
            const current = () => source.locator('.ins-line.current .ins-text').textContent();
            await waitFor(async () => await current() === 'onexy');
            await inspector.getByRole('button', { name: 'Paused' }).click();
            await inspector.getByRole('button', { name: 'Step back' }).click();
            await waitFor(async () => await current() === 'onex');
            assert.match(await inspector.locator('.ins-head').textContent(), /after #\d+/);
            await inspector.getByRole('button', { name: 'Step forward' }).click();
            await waitFor(async () => await current() === 'onexy');
            await inspector.getByRole('button', { name: 'Live' }).click();
            assert.equal(await inspector.getByRole('button', { name: 'Step back' }).count(), 0);
        });

        await step('a piece of the source is boxed in the editor, and the place under the pointer in the editor is lit in the source', async () => {
            await setDoc(page, 'some **bold** text', 0);
            await source.locator('.ins-line.current span[title="7–11"]').hover();
            const box = await inspector.locator('.ins-flash').boundingBox();
            const word = await page.locator('.cm-content .cm-md-bold').boundingBox();
            assert.ok(box && word && Math.abs(box.x - word.x) < 4 && Math.abs(box.width - word.width) < 6, `the box ${JSON.stringify(box)} is on the word ${JSON.stringify(word)}`);
            await page.locator('.cm-content .cm-md-bold').hover();
            await waitFor(async () => await source.locator('.ins-text .hot').textContent() === 'bold');
        });

        await step('the decorations tab names what drew each range', async () => {
            await setDoc(page, '- [ ] task', 10);
            await tab('Decorations').click();
            await waitFor(async () => (await inspector.locator('.ins-list').textContent()).includes('ListMarkWidget'));
            assert.equal(await page.locator('.inspecting .cm-md-listmark').count(), 1, 'the widget in the editor is outlined');
        });
    } finally {
        await close(app);
    }
}

async function close(app) {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
}

try {
    await inNormalStart();
    await inDevMode();
} catch {
    failed = true;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron editor inspector');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
