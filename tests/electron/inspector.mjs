// The Editor Inspector (docs/design/debugger.md), against the Electron window with Playwright: it is there only in dev
// mode; it shows what the visual editor hides; the recorder keeps the keys and what they did; the checks pass on real
// typing and catch a transaction that breaks a rule of the visual editor. Also how long a transaction takes in a normal
// start, where the recorder is the only part that runs.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shrink } from '../../scripts/editor-fuzz.mjs';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('inspector');
writeFileSync(join(notes, 'plan.md'), '# Plan\n\nsome **bold** text\n');
writeFileSync(join(notes, 'report.md'), '# Rencana rilis\n\nKita **rilis Jumat** setelah QA, 25 Oktober.\n');
copyFileSync(new URL('../samples/all-formats.md', import.meta.url), join(notes, 'all.md'));

const { steps, step } = stepper();
let failed = false;

// scripts/editor.mjs, as an agent runs it: its exit code and its answers, one JSON line each.
const editorScript = fileURLToPath(new URL('../../scripts/editor.mjs', import.meta.url));
const cli = (...args) => new Promise(resolve => {
    execFile(process.execPath, [editorScript, ...args], { timeout: 120_000, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
        const answers = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
        resolve({ code: error ? error.code ?? 1 : 0, answers, answer: answers.at(-1), stderr });
    });
});

// The main process's own pid, which names its socket: on Windows the process Playwright started is another one.
const mainPid = app => app.evaluate(() => process.pid);

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

        await step('a normal start has no socket for scripts/editor.mjs', async () => {
            const { code, stderr } = await cli('--pid', String(await mainPid(app)), 'hello');
            assert.equal(code, 2, stderr);
            assert.match(stderr, /cannot reach/);
        });

        await openFile(page, 'report.md');
        const editorText = () => page.evaluate(`${view}.state.doc.toString()`);
        const reports = async () => join(await app.evaluate(({ app }) => app.getPath('userData')), 'reports');
        const dialog = page.getByRole('dialog', { name: 'Something looks wrong?' });
        await step('a report of a problem with the editor: what the editor did, blurred, with a picture, and the text left as it was', async () => {
            await page.getByText('setelah QA').click();
            await page.keyboard.press('End');
            await page.keyboard.type(' Tim');
            const before = await editorText();
            await page.getByRole('menuitem', { name: 'Help' }).click();
            await page.getByRole('menuitem', { name: 'Report a Problem with the Editor…' }).click();
            await dialog.waitFor();
            assert.equal(await dialog.getByLabel('The line of the cursor, as it will be saved').textContent(), 'Xxxx **xxxxx Xxxxx** xxxxxxx XX, 00 Xxxxxxx. Xxx');
            await dialog.getByLabel('What happened').fill('The last word went missing.');
            await dialog.getByRole('button', { name: 'Save Report' }).click();
            await dialog.getByText('The report is saved as').waitFor();
            assert.equal(await editorText(), before, 'the blurred text shown for the picture is gone again');
            const folder = await reports(), files = readdirSync(folder);
            const name = files.find(f => f.endsWith('.mwrepro.json'));
            assert.ok(name && (await dialog.textContent()).includes(name), JSON.stringify(files));
            const report = JSON.parse(readFileSync(join(folder, name), 'utf8'));
            assert.equal(report.blurred, true);
            assert.equal(report.note, 'The last word went missing.', 'the note is the person\'s own words, not blurred');
            assert.equal(report.expect, undefined, 'nothing was checked, so nothing is expected');
            assert.equal(report.actual.doc, '# Xxxxxxx xxxxx\n\nXxxx **xxxxx Xxxxx** xxxxxxx XX, 00 Xxxxxxx. Xxx\n');
            assert.equal(report.actual.doc.length, before.length);
            assert.ok(report.steps.some(st => st.type === ' Xxx'), `what was typed, blurred: ${JSON.stringify(report.steps)}`);
            assert.ok(report.app.electron && report.app.os, JSON.stringify(report.app));
            const png = readFileSync(join(folder, report.picture));
            assert.equal(png.subarray(1, 4).toString(), 'PNG', `${report.picture} is a picture`);
            await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
            await dialog.waitFor({ state: 'detached' });
        });

        await step('an Undo right after typing offers a report, once a tab', async () => {
            const offer = page.getByRole('button', { name: 'Something looks wrong?' });
            await page.locator('.cm-content').click();
            await page.keyboard.press('Control+End');
            await page.keyboard.type('xyz');
            await page.keyboard.press('Control+z');
            await offer.waitFor();
            await offer.click();
            await dialog.waitFor();
            await dialog.getByRole('button', { name: 'Cancel' }).click();
            await dialog.waitFor({ state: 'detached' });
            await page.locator('.cm-content').click();
            await page.keyboard.type('abc');
            await page.keyboard.press('Control+z');
            await page.waitForTimeout(400);   // a pause to show that the offer does not come again in this tab
            assert.equal(await offer.count(), 0);
        });

        await openFile(page, 'all.md');
        await step('the report dialog keeps the keys from the editor, and its picture leaves the editor where it was scrolled', async () => {
            await page.locator('.cm-content').click();
            await page.keyboard.type('Q');
            const before = await editorText();
            await page.evaluate(`${view}.scrollDOM.scrollTop = 900`);
            const scrolled = await page.evaluate(`${view}.scrollDOM.scrollTop`);
            assert.ok(scrolled > 0, 'the long sample scrolls');
            await page.getByRole('menuitem', { name: 'Help' }).click();
            await page.getByRole('menuitem', { name: 'Report a Problem with the Editor…' }).click();
            await dialog.waitFor();
            await dialog.getByLabel('What happened').fill('Q');
            await page.keyboard.press('Control+z');
            await dialog.getByRole('button', { name: 'Save Report' }).click();
            await dialog.getByText('The report is saved as').waitFor();
            assert.equal(await editorText(), before, 'Ctrl+Z in the note did not undo the text');
            assert.ok(Math.abs(await page.evaluate(`${view}.scrollDOM.scrollTop`) - scrolled) < 2, 'the editor is scrolled as it was');
            await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
            await dialog.waitFor({ state: 'detached' });
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
            // The last transaction need not be the "y": one with only a selection or an effect (from the core, say) can
            // come after it. Steps back over those to the "x".
            const back = inspector.getByRole('button', { name: 'Step back' }), forward = inspector.getByRole('button', { name: 'Step forward' });
            const recorded = () => inspector.locator('.ins-list tbody tr').evaluateAll(rows => rows.slice(0, 6).map(r => r.textContent).join('\n'));
            for (let i = 0; i < 5 && await current() !== 'onex'; i++) {
                const before = await inspector.locator('.ins-head').textContent();
                await back.click();
                await waitFor(async () => await inspector.locator('.ins-head').textContent() !== before, 10000, recorded);
            }
            await waitFor(async () => await current() === 'onex', 10000, recorded);
            assert.match(await inspector.locator('.ins-head').textContent(), /after #\d+/);
            for (let i = 0; i < 5 && await current() !== 'onexy'; i++) await forward.click();
            await waitFor(async () => await current() === 'onexy', 10000, recorded);
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

// The bridge (docs/design/debugger.md, section 8): scripts/editor.mjs against a window in dev mode, over its socket.
async function throughTheBridge() {
    // A file of its own: the steps above typed into plan.md, and autosave kept it.
    writeFileSync(join(notes, 'bridge.md'), '# Plan\n\nsome **bold** text\n');
    writeFileSync(join(notes, 'emoji.md'), '# 🎉 Hi\n\nsome **bold** 🎉 text\n');
    const repro = join(scratch, 'bridge.mwrepro.json'), blurred = join(scratch, 'blurred.mwrepro.json');
    const app = await launchApp({ scratch, notes, env: { MARKWORK_DEV: '1' } });
    try {
        const page = await app.firstWindow();
        await page.setViewportSize({ width: 1400, height: 900 });
        const pid = ['--pid', String(await mainPid(app))];

        await step('editor.mjs: hello reaches the window, and open shows a file of the folder', async () => {
            let hello = null;
            await waitFor(async () => (hello = await cli(...pid, 'hello')).answer?.ready === true, 30000,
                () => `last answer: ${JSON.stringify(hello?.answer)}, exit ${hello?.code}, ${hello?.stderr}`);
            const { code, answer, stderr } = await cli(...pid, 'open', 'bridge.md');
            assert.equal(code, 0, stderr);
            assert.equal(answer.name, 'bridge.md');
        });

        await step('editor.mjs: snapshot gives what the visual editor hides, and the letter the eye sees before the cursor', async () => {
            const selected = await cli(...pid, 'select', '21');
            assert.equal(selected.code, 0, selected.stderr);
            const { answer } = await cli(...pid, 'snapshot', '--all');
            assert.equal(answer.mode, 'visual');
            assert.deepEqual(answer.prefixes, [[0, 2]], 'the heading\'s "# "');
            for (const range of [[13, 15], [19, 21]]) assert.ok(answer.hidden.some(h => h[0] === range[0] && h[1] === range[1]), `${range} is hidden: ${JSON.stringify(answer.hidden)}`);
            assert.deepEqual(answer.visibleBefore, { char: 'd', from: 18, to: 19 }, 'the hidden ** after "bold" is stepped over');
        });

        await step('editor.mjs: press --explain answers the transaction with its key and the findings', async () => {
            const { code, answer, stderr } = await cli(...pid, 'press', 'Backspace', '--explain');
            assert.equal(code, 0, stderr);
            assert.equal(answer.doc, '# Plan\n\nsome **bol** text\n');
            const tx = answer.entries.find(e => e.userEvent === 'delete.backward');
            assert.ok(tx, JSON.stringify(answer.entries));
            assert.equal(tx.input.key, 'Backspace');
            assert.deepEqual(tx.findings.filter(f => f.severity === 'fail'), []);
            assert.equal(tx.handler, 'visual.backspace', 'the command of the visual editor that took the key');
            assert.deepEqual(tx.trace, ['stepped back past hidden 19–21; removes 18–19']);
        });

        await step('editor.mjs: a click on visible text puts the cursor at its end, and typing types', async () => {
            const clicked = await cli(...pid, 'click', '--visible', 'text', '--explain');
            assert.equal(clicked.code, 0, clicked.stderr);
            assert.deepEqual(clicked.answer.entries.at(-1).selAfter, [[25, 25]], 'after "text"');
            const typed = await cli(...pid, 'type', '!?', '--explain');
            assert.equal(typed.answer.doc, '# Plan\n\nsome **bol** text!?\n');
            assert.deepEqual(typed.answer.entries.filter(e => e.input).map(e => e.input.key), ['!', '?']);
        });

        await step('editor.mjs: save-repro, then replay passes; a repro that expects another text differs', async () => {
            const saved = await cli(...pid, 'save-repro', repro);
            assert.equal(saved.code, 0, saved.stderr);
            // The same recording blurred, for the step after this one (a replay plays in a tab of its own).
            const savedBlurred = await cli(...pid, 'save-repro', blurred, '--blur');
            assert.equal(savedBlurred.code, 0, savedBlurred.stderr);
            const file = JSON.parse(readFileSync(repro, 'utf8'));
            assert.equal(file.format, 'markwork-repro');
            assert.ok(file.steps.some(s => s.key === 'Backspace') && file.steps.some(s => s.type === '!?'), JSON.stringify(file.steps));
            const played = await cli(...pid, 'replay', repro);
            assert.equal(played.code, 0, JSON.stringify(played.answer) + played.stderr);
            assert.equal(played.answer.result, 'pass');
            assert.equal(played.answer.doc, file.expect.doc);
            writeFileSync(repro, JSON.stringify({ ...file, expect: { doc: 'something else' } }));
            const differs = await cli(...pid, 'replay', repro);
            assert.equal(differs.code, 1, 'a replay that differs exits 1');
            assert.equal(differs.answer.result, 'differs');
        });

        await step('editor.mjs: save-repro --blur keeps every offset, so the blurred repro plays the same way', async () => {
            const plain = JSON.parse(readFileSync(repro, 'utf8')), file = JSON.parse(readFileSync(blurred, 'utf8'));
            assert.equal(file.blurred, true);
            assert.equal(file.start.doc, '# Xxxx\n\nxxxx **xxxx** xxxx\n');
            assert.deepEqual(file.start.selection, plain.start.selection);
            assert.deepEqual(file.steps, plain.steps, 'keys, punctuation typed, clicks, and selections are the same');
            const played = await cli(...pid, 'replay', blurred);
            assert.equal(played.answer.result, 'pass', JSON.stringify(played.answer) + played.stderr);
            assert.equal(played.answer.doc, '# Xxxx\n\nxxxx **xxx** xxxx!?\n');
        });

        await step('editor.mjs: a picture of the editor, and a usage error exits 2', async () => {
            const png = join(scratch, 'editor.png');
            const { code, stderr } = await cli(...pid, 'screenshot', png, '--overlay');
            assert.equal(code, 0, stderr);
            assert.deepEqual([...readFileSync(png).subarray(1, 4)], [0x50, 0x4e, 0x47], 'a PNG');
            const wrong = await cli(...pid, 'frobnicate');
            assert.equal(wrong.code, 2);
            const bad = await cli(...pid, 'press', 'Hyper+x');
            assert.equal(bad.code, 2);
            assert.match(bad.stderr, /not a modifier/);
        });
        await step('editor.mjs: snapshot with an emoji, in UTF-16 and with --cp in code points; around, visibleAfter, and the parse', async () => {
            assert.equal((await cli(...pid, 'open', 'emoji.md')).code, 0);
            const selected = await cli(...pid, '--cp', 'select', '24');
            assert.equal(selected.code, 0, selected.stderr);
            const { answer: u16 } = await cli(...pid, 'snapshot');
            assert.equal(u16.units, 'utf16');
            assert.deepEqual(u16.cursor, { pos: 26, line: 3, col: 18, inPrefix: false, cp: 24 }, 'before "text", after "🎉 ": the emoji is two units and one character');
            assert.deepEqual(u16.around, { before: 'some **bold** 🎉 ', after: 'text' });
            assert.deepEqual(u16.visibleBefore, { char: ' ', from: 25, to: 26 });
            assert.deepEqual(u16.visibleAfter, { char: 't', from: 26, to: 27 });
            assert.ok(u16.hidden.some(([a, b]) => a === 20 && b === 22), JSON.stringify(u16.hidden));
            assert.equal(u16.parse.line, 3);
            assert.ok(u16.parse.spans.some(([style]) => /bold|strong/.test(style)), JSON.stringify(u16.parse.spans));
            assert.ok(Array.isArray(u16.widgets) && typeof u16.parseMs === 'number');
            const { answer: cp } = await cli(...pid, '--cp', 'snapshot');
            assert.equal(cp.units, 'cp');
            assert.deepEqual(cp.cursor, { pos: 24, line: 3, col: 17, inPrefix: false });
            assert.deepEqual(cp.visibleBefore, { char: ' ', from: 23, to: 24 });
            assert.ok(cp.hidden.some(([a, b]) => a === 19 && b === 21), JSON.stringify(cp.hidden));
            assert.equal(cp.length, u16.length - 2, 'two emoji');
        });

        await step('editor.mjs: click --line clicks where the eye sees a line start and end, past its hidden syntax', async () => {
            const end = await cli(...pid, 'click', '--line', '3', '--explain');
            assert.equal(end.code, 0, end.stderr);
            assert.deepEqual(end.answer.entries.at(-1).selAfter, [[30, 30]], 'past the end of "some **bold** 🎉 text"');
            const start = await cli(...pid, 'click', '--line', '1', '--start', '--explain');
            assert.deepEqual(start.answer.entries.at(-1).selAfter, [[2, 2]], 'after the hidden "# "');
            const hidden = await cli(...pid, 'click', '--line', '9');
            assert.equal(hidden.code, 2, 'a line the text does not have');
        });

                await step('editor.mjs: fuzz with a fixed seed on the long sample passes every check', async () => {
            const sample = fileURLToPath(new URL('../samples/all-formats.md', import.meta.url));
            const { code, answer, stderr } = await cli(...pid, 'fuzz', '--docs', sample, '--runs', '1', '--steps', '100', '--seed', '1', '--out', scratch);
            assert.ok(answer, stderr);
            assert.deepEqual(answer.failures, [], JSON.stringify(answer.failures));
            assert.equal(answer.steps, 100);
            assert.equal(code, 0);
        });

        await step('editor.mjs: test-from keeps a repro as a test that must pass every check', async () => {
            const { code, answer, stderr } = await cli('test-from', repro, '--name', 'kept', '--dir', scratch);
            assert.equal(code, 0, stderr);
            const kept = JSON.parse(readFileSync(answer.file, 'utf8'));
            assert.equal(kept.expect.checks, 'pass');
            assert.equal(kept.actual, undefined, 'what happened once is not what is expected');
        });
    } finally {
        await close(app);
    }

    await step('fuzz: shrinking keeps the fewest steps that still make the check fail', async () => {
        // A window that fails "undo" once it has had both an "A" and a "B" since the text was loaded.
        let played = [];
        const conn = {
            ask: async request => {
                if (request.op === 'load') { played = []; return {}; }
                played.push(request.keys?.[0]);
                const fails = played.includes('A') && played.includes('B');
                return { doc: '', entries: [{ n: played.length, findings: fails ? [{ check: 'undo', severity: 'fail', message: 'made up' }] : [] }] };
            },
        };
        const steps = Array.from({ length: 40 }, (_, i) => ({ key: i === 7 ? 'A' : i === 30 ? 'B' : 'x' }));
        const { steps: left } = await shrink(conn, { start: { doc: '', selection: [[0, 0]] } }, steps, 'undo', { quiet: 40, seconds: 30 });
        assert.deepEqual(left, [{ key: 'A' }, { key: 'B' }]);
    });

    await step('editor.mjs --headless starts a window of its own on a copy of the folder, plays a repro, and closes', async () => {
        const before = readFileSync(join(notes, 'bridge.md'), 'utf8');
        // The repro of the step above, without the text it was told to expect: only its checks decide.
        const { expect: _expect, ...played } = JSON.parse(readFileSync(repro, 'utf8'));
        writeFileSync(repro, JSON.stringify(played));
        const run = await cli('--headless', '--folder', notes, 'replay', repro, '--then', 'open', 'bridge.md', '--then', 'press', 'End', 'x');
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.answers[0].result, 'pass');
        assert.match(run.answers.at(-1).doc, /^# Planx\n/, 'the keys went to the copy');
        assert.equal(readFileSync(join(notes, 'bridge.md'), 'utf8'), before, 'the folder itself is not written');
    });
}

async function close(app) {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
}

try {
    await inNormalStart();
    await inDevMode();
    await throughTheBridge();
} catch {
    failed = true;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron editor inspector');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
