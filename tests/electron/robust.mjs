// The broadest checks of the editor, in the Electron window with Playwright: the sample document with every format (tests/samples/all-formats.md) is styled right
// and exports to HTML, and hunting for crashes — the cursor over every line, typing on every line, deleting everything,
// random edits with undo — leaves the editor drawing exactly what a fresh tab draws for the same text. That the parse
// cache equals a full parse is the core's own test (tests/unit/highlight.ts); here it is what reaches the screen.
// Run with `npm run test:electron`.

import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo, scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('robust');
const SAMPLE = readFileSync(join(repo, 'tests/samples/all-formats.md'), 'utf8');
writeFileSync(join(notes, 'all-formats.md'), SAMPLE);
cpSync(join(repo, 'tests/samples/images'), join(notes, 'images'), { recursive: true });
writeFileSync(join(notes, 'edited.md'), '');
const exported = join(scratch, 'exported.html');
const { steps, step } = stepper();

const app = await launchApp({ scratch, notes, env: { MARKWORK_CHOOSE_FILE: exported } });
let failed = false;
let page;
const errors = [];
try {
    page = await app.firstWindow();
    page.on('pageerror', e => errors.push(`page: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

    const title = page.locator('.headerbar .title');
    const open = async name => {
        const files = page.getByRole('button', { name: 'Files', exact: true });
        if ((await files.getAttribute('aria-pressed')) !== 'true') await files.click();
        await page.getByRole('treeitem', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).click();
        await title.getByText(name, { exact: true }).waitFor();
    };
    // The editor in the page: its text, a whole-text replacement, an edit, the cursor, and the styles at a position.
    const view = 'document.querySelector(".cm-content").cmTile.view';
    const docText = () => page.evaluate(`${view}.state.doc.toString()`);
    const setDoc = text => page.evaluate(([v, t]) => { const ed = eval(v); ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: t }, selection: { anchor: 0 } }); }, [view, text]);
    const edit = (from, to, insert, cursor) => page.evaluate(([v, f, t, i, c]) => {
        const ed = eval(v);
        ed.dispatch({ changes: { from: f, to: t, insert: i }, selection: { anchor: Math.min(c, ed.state.doc.length - (t - f) + i.length) }, userEvent: 'input' });
    }, [view, from, to, insert, cursor]);
    const cursorTo = pos => page.evaluate(([v, p]) => { const ed = eval(v); ed.dispatch({ selection: { anchor: p }, scrollIntoView: true }); }, [view, pos]);
    const cursorLine = () => page.evaluate(`(v => v.state.doc.lineAt(v.state.selection.main.head).number)(${view})`);
    const frame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    // The classes on the way from the character at `pos` up to its line: the styles the editor gave it.
    const classesAt = async pos => {
        await cursorTo(pos);
        await frame();
        return page.evaluate(([v, p]) => {
            const ed = eval(v);
            const { node, offset } = ed.domAtPos(p + 1);
            let el = node.nodeType === 3 ? node.parentElement : node.childNodes[Math.max(0, offset - 1)] ?? node;
            const found = [];
            for (; el && !el.classList?.contains('cm-content'); el = el.parentElement) found.push(...(el.classList ?? []));
            return found;
        }, [view, pos]);
    };
    const offsetOf = async needle => {
        const at = (await docText()).indexOf(needle);
        assert.ok(at >= 0, `${JSON.stringify(needle)} is not in the text`);
        return at;
    };
    const styled = async (needle, style, shift = 1) => (await classesAt((await offsetOf(needle)) + shift)).includes(`cm-md-${style}`);
    // What the editor shows of its text, by line: the classes and contents of each drawn line and the kind of each widget,
    // without what depends on timing (pictures loading, diagrams drawing). CodeMirror draws only the lines near the viewport,
    // and which ones depends on measured heights, so two snapshots are compared on the lines both drew.
    const snapshot = () => page.evaluate(v => {
        const ed = eval(v);
        const out = {};
        for (const el of document.querySelectorAll('.cm-content > *')) {
            const line = ed.state.doc.lineAt(ed.posAtDOM(el)).number;
            out[el.classList.contains('cm-line') ? `line ${line}` : `widget ${line} ${Object.keys(out).length}`] = el.classList.contains('cm-line')
                ? `${el.className.replace(/\s*cm-activeLine\b/, '')}|${el.innerHTML.replace(/<img[^>]*>/g, '<img>')}`
                : [...el.classList].filter(c => c.startsWith('cm-md-') && c !== 'cm-md-dim').sort().join(' ');
        }
        return out;
    }, view);
    const sameLines = (a, b, what) => {
        const both = Object.keys(a).filter(k => k.startsWith('line ') && k in b);
        assert.ok(both.length >= 10, `${what}: only ${both.length} lines drawn in both`);
        for (const k of both) assert.equal(a[k], b[k], `${what}, ${k}`);
    };

    // ---------- sample.ts ----------

    await step('sample: the file opens and every heading, and only those, is in the outline', async () => {
        await open('all-formats.md');
        await page.getByRole('button', { name: 'Outline' }).click();
        const rows = page.locator('.outline .row');
        await rows.first().waitFor();
        const names = await rows.allTextContents();
        for (const h of ['Markdown All-Formats Test', 'Heading 6', 'Heading with closing marks', '15. Tricky cases']) assert.ok(names.includes(h), `the heading "${h}" is missing`);
        assert.ok(!names.some(n => n.includes('Seven hashes') || n.includes('No space')), 'text that is not a heading is in the outline');
    });

    await step('sample: inline formats get their styles', async () => {
        for (const [needle, style] of [['bold with asterisks', 'bold'], ['italic with underscores', 'italic'], ['bold italic*', 'bolditalic'],
            ['struck through', 'strike'], ['highlighted', 'mark'], ['gjs -m markwork.js', 'code']]) {
            assert.ok(await styled(needle, style), `"${needle}" is not styled ${style}`);
        }
    });

    await step('sample: tricky cases are not mis-formatted', async () => {
        assert.ok(!(await styled('case_like', 'italic', 2)), 'snake_case became italic');
        assert.ok(!(await styled('3 * 4', 'italic', 0)), '"2 * 3 * 4" became italic');
        assert.ok(!(await styled('not code\\`', 'code')), 'an escaped backtick became code');
        assert.ok(!(await styled('**not bold**`', 'bold', 3)), 'inline code contents became bold');
        assert.ok(!(await styled('this_file_name', 'italic', 6)), 'a URL with underscores became italic');
    });

    await step('sample: tables with and without pipes at the edges are tables', async () => {
        assert.ok(await styled('| Left', 'tablehead', 2), 'a table header with pipes');
        assert.ok(await styled('One | 1', 'table', 0), 'a table row without pipes at the edges');
        assert.ok(await styled('Name | Value', 'tablehead', 0), 'a table header without pipes at the edges');
    });

    await step('sample: a 4-backtick block holds ``` inside it, and a nested quote is a quote of level three', async () => {
        assert.ok(await styled('code\n```\n````', 'codeblock', 0), 'the contents of the block are not code');
        assert.ok(await styled('Level three', 'quote', 0) || await styled('Level three', 'quote3', 0), 'the nested quote is not a quote');
        assert.ok(await styled('Level three', 'quote3', 0), 'the nested quote is not of level three');
    });

    await step('sample: the cursor sweeps the whole document, to the start and the end of every line', async () => {
        const lines = await page.evaluate(`${view}.state.doc.lines`);
        for (let n = 1; n <= lines; n++) {
            await page.evaluate(([v, line]) => { const ed = eval(v); const l = ed.state.doc.line(line); ed.dispatch({ selection: { anchor: l.from }, scrollIntoView: true }); ed.dispatch({ selection: { anchor: l.to } }); }, [view, n]);
        }
        await frame();
        assert.equal(await docText(), SAMPLE, 'moving the cursor changed the text');
    });

    await step('sample: Export HTML writes the whole document', async () => {
        await page.keyboard.press('ControlOrMeta+Shift+E');
        await waitFor(() => { try { return readFileSync(exported, 'utf8').includes('</html>'); } catch { return false; } }, 15000);
        const html = readFileSync(exported, 'utf8');
        for (const tag of ['<h6', '<strong><em>', '<del>', '<mark>', '<code>', '<a href=', '<img ', '<ol start="7">', 'type="checkbox"',
            '<blockquote>\n<p>Level two', '<pre><code class="language-bash">', '<pre class="mermaid">', '<table>', '<hr>', '<br>']) {
            assert.ok(html.includes(tag), `the export has no ${tag}`);
        }
        assert.equal((html.match(/<table>/g) ?? []).length, 3, 'the number of tables');
        assert.ok(html.includes('>a | b</td>'), '\\| inside a cell is |');
    });

    // ---------- robust.ts ----------

    await step('robust: typing on every line of the sample document', async () => {
        await open('edited.md');
        await setDoc(SAMPLE);
        const lines = SAMPLE.split('\n').length;
        for (let n = lines; n >= 1; n--) {
            await page.evaluate(([v, line]) => { const ed = eval(v); const l = ed.state.doc.line(line); ed.dispatch({ changes: { from: l.from, insert: 'x' }, selection: { anchor: l.from + 1 }, userEvent: 'input.type', scrollIntoView: true }); }, [view, n]);
        }
        await frame();
        const typed = SAMPLE.split('\n').map(l => `x${l}`).join('\n');
        assert.equal(await docText(), typed);
    });

    await step('robust: deleting the whole document bit by bit', async () => {
        for (let length = SAMPLE.length; length > 0; length = (await docText()).length) {
            await page.evaluate(([v]) => { const ed = eval(v); const end = ed.state.doc.length; ed.dispatch({ changes: { from: Math.max(0, end - 37), to: end }, selection: { anchor: Math.max(0, end - 37) }, userEvent: 'delete', scrollIntoView: true }); }, [view]);
        }
        assert.equal(await docText(), '');
    });

    // Each round: a few random edits, sometimes an undo; then what the editor shows must be what a fresh tab shows for the
    // same text (its own parse from scratch), at the top and at the end of the document.
    const sameAsFresh = async what => {
        const text = await docText();
        await cursorTo(0);
        await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; });
        await frame();
        const top = await snapshot();
        await page.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = s.scrollHeight; });
        await frame();
        const end = await snapshot();
        writeFileSync(join(notes, 'fresh.md'), text);
        await open('fresh.md');
        await waitFor(async () => (await docText()) === text);
        await cursorTo(0);
        await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; });
        await frame();
        sameLines(await snapshot(), top, `the top of the document after ${what}`);
        await page.evaluate(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = s.scrollHeight; });
        await frame();
        sameLines(await snapshot(), end, `the end of the document after ${what}`);
        await page.getByRole('tab', { name: /fresh\.md/ }).getByRole('button', { name: /Close/ }).click();
        await open('edited.md');
    };

    await step('robust: random edits and undo draw what a fresh tab draws for the same text', async () => {
        await setDoc(SAMPLE);
        let seed = 7;
        const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const pieces = ['x', '\n', '**', '`', '```\n', '| a |', '# ', '- [ ] ', '> ', '🎉', '~~', '\n\n', '![g](images/example.png)'];
        for (let round = 0; round < 30; round++) {
            for (let k = 0; k < 1 + rand(4); k++) {
                const n = (await docText()).length;
                const at = rand(n + 1);
                if (rand(3) === 0 && n > 0) await edit(at, Math.min(n, at + 1 + rand(30)), '', at);
                else { const piece = pieces[rand(pieces.length)]; await edit(at, at, piece, at + piece.length); }
            }
            await cursorTo(rand((await docText()).length + 1));
            if (round % 3 === 2) { await page.locator('.cm-content').focus(); await page.keyboard.press('ControlOrMeta+z'); }
            if (round % 10 === 9) await sameAsFresh(`round ${round + 1}`);
        }
    });

    await step('robust: a long document is drawn the same to its end, also after an edit near its start', async () => {
        const long = Array.from({ length: 600 }, (_, i) => `## Section ${i}\n\nParagraph **bold** and *italic* number ${i} 🎉 with \`code\`.\n`).join('\n');
        await setDoc(long);
        await edit(30, 30, '**new**\n\n', 30);
        await sameAsFresh('an edit near the start of a long document');
        assert.ok(await styled('bold** and *italic* number 599', 'bold'), 'the last paragraph is not styled');
    });

    await step('robust: the outline follows a heading that is edited, removed, and shifted, and a click lands on it', async () => {
        await setDoc('# One\n\n## Two\n\n# Three');
        await page.getByRole('button', { name: 'Outline' }).click();
        const rows = page.locator('.outline .row');
        await waitFor(async () => (await rows.allTextContents()).join('|') === 'One|Two|Three');
        await edit(13, 13, ' new', 17);   // at the end of "## Two"
        await waitFor(async () => (await rows.allTextContents()).join('|') === 'One|Two new|Three');
        await edit(7, 7, 'x', 8);   // the second heading becomes a paragraph
        await waitFor(async () => (await rows.allTextContents()).join('|') === 'One|Three');
        await rows.nth(1).click();
        await waitFor(async () => (await cursorLine()) === 5);
        await edit(0, 0, 'new line\n', 0);
        await waitFor(async () => (await rows.allTextContents()).join('|') === 'One|Three');
        await rows.nth(1).click();
        await waitFor(async () => (await cursorLine()) === 6);
    });

    await step('robust: focus and typewriter modes together, over every line', async () => {
        await setDoc(SAMPLE);
        await page.locator('.cm-content').focus();
        await page.keyboard.press('F8');
        await page.keyboard.press('F9');
        const lines = await page.evaluate(`${view}.state.doc.lines`);
        for (let n = 1; n <= lines; n += 3) await page.evaluate(([v, line]) => { const ed = eval(v); ed.dispatch({ selection: { anchor: ed.state.doc.line(line).from }, scrollIntoView: true }); }, [view, n]);
        await frame();
        await page.keyboard.press('F8');
        await page.keyboard.press('F9');
        assert.equal(await docText(), SAMPLE);
    });

    await step('nothing failed in the page or the core along the way', async () => {
        assert.deepEqual(errors, []);
        assert.equal(await page.locator('.notification.error').count(), 0, 'the core stopped');
    });
} catch {
    failed = true;
    if (errors.length) console.error(errors.join('\n'));
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron sample document and robustness');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
