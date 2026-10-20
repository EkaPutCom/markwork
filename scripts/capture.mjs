// Screenshots and animations of the real app for the site and the README (docs/assets/), with Playwright on the Electron
// window. The model, the forge, and the agent are scripted fakes (scripts/capture/), so nothing reaches the network and no
// key is needed. Afterwards the width and height of every image in docs/ are set to what was written.
//
//   npm run docs                                    every scene (needs a display; under CI: xvfb-run)
//   MARKWORK_SCENES=editor,agents npm run docs      only these groups: editor, history, collab, agents, daily
//   MARKWORK_OUT=/tmp/shots npm run docs            write somewhere else (the docs are not touched then)

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import gifenc from 'gifenc';
import { repo, scratchFolder, launchApp } from '../tests/electron-support.mjs';
import { LAUNCH, RESEARCH, SCHEDULE } from './capture/forge.mjs';

const { GIFEncoder, applyPalette, quantize } = gifenc;   // a CommonJS package
const OUT = process.env.MARKWORK_OUT ?? join(repo, 'docs', 'assets');
const ONLY = process.env.MARKWORK_SCENES?.split(',');
const WIDTH = 1280, HEIGHT = 780;
const GIF_WIDTH = 900, GIF_STEP = 140, GIF_COLORS = 128;
const module = name => pathToFileURL(join(repo, 'scripts', 'capture', name)).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
mkdirSync(OUT, { recursive: true });

// ---------- The sample contents ----------

const WORK = {
    'plans/launch.md': LAUNCH,
    'notes/meeting-1-oct.md': '# Weekly meeting, 1 October\n\n## Decisions\n\n- The public release is postponed to **22 November** because the sync testing is not finished.\n- The budget does not change.\n- Sari prepares the release material.\n\n## Follow-up\n\n- [ ] Budi fixes the sync bug\n- [ ] Dewi schedules the beta trial\n',
    'notes/meeting-8-oct.md': '# Weekly meeting, 8 October\n\nThe sync bug is still open. The closed beta stays on 20 October.\n',
    'research/competitors.md': RESEARCH,
    'research/users.md': '# User interviews\n\nFive users want syncing without an account.\n',
    'tasks.md': '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Prepare the release material #marketing [due:: 2026-11-10]\n- [ ] Write the release notes #docs\n\n## In Progress\n\n- [ ] Fix the sync bug #bug #important [due:: 2026-10-25]\n\n## Done\n\n- [x] Redesign the home page #design\n',
    'ideas.md': '# Ideas\n\nA PDF export feature.\n',
};
const ASK_READ = 'Is there a meeting decision that has not made it into the launch plan yet?';
const ASK_ACT = 'Yes, update the release date and move the release material card to In Progress.';
const ASK_WORK = 'Sync the release schedule with the meeting decisions, and then make sure nothing is left behind.';

const DOC = `# Product Meeting Notes

Weekly meeting, **Friday morning**. Things that *need* follow-up are below, this text is ==highlighted== and ~~this one is struck through~~.

## Decisions

- The \`1.0\` release is postponed by one week
- [x] Fix the HTML export bug
- [ ] Write the kanban feature [documentation](https://github.com/EkaPutCom/markwork)

> A quote from a user: "At last, an editor that stays out of the way."

\`\`\`ts
function remainingBudget(total: number, spent: number): number {
    return total - spent;
}
\`\`\`

## Schedule

| Task | Owner | Deadline |
| :---- | :--------------: | ------: |
| Redesign | **Sari** | 10 Oct |
| Trial run | *Budi* | 17 Oct |
`;
const TABLE_DOC = '# Project Budget\n\nTables are rendered as a grid. Click a cell to edit it.\n\n| Item | Owner | Cost ($) |\n| :-- | :--------------: | ---------: |\n| **Design** | Sari | 750 |\n| Development | *Budi* | 2,800 |\n| Testing | Dewi | 530 |\n| `Server` | Andi | 375 |\n| [License](https://example.com) | Rina | 200 |\n\nThe total cost is still below the **budget**.\n';
const DBML_DOC = '# Database Schema\n\nA `dbml` block (the dbdiagram.io language) is drawn as an ER diagram.\n\n```dbml\nTable projects {\n  id int [pk]\n  name varchar\n}\n\nTable tasks {\n  id int [pk]\n  title varchar\n  project_id int\n}\n\nRef: tasks.project_id > projects.id\n```\n';
const BOARD = '---\nlayout: board\n---\n\n## Plan\n\n- [ ] User research #research [due:: 2026-10-10]\n  Interview five active users.\n- [ ] Redesign the home page #design\n- [ ] Write the **API** documentation #docs [due:: 2026-10-25]\n\n## In Progress\n\n- [ ] Implement the kanban board #feature #important\n- [ ] Fix the `HTML export` bug #bug [due:: 2026-10-03]\n\n## Review\n\n- [ ] Trial on Ubuntu 24.04 #qa\n\n## Done\n\n- [x] Choose the project name: Markwork\n- [x] Set up the GitHub repository #infra\n';
const day = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
const LAYOUTS_DOC = () => `---\nlayout: board\nfields:\n  status: select(todo:gray, doing:blue, done:green) = todo\n  start: date\n  due: date\n---\n\n# Launch plan\n\nOne file. Change the layout: line and the same notes become a list, a table, a calendar, a timeline, a gallery, or a chart.\n\n## Plan\n\n- [ ] Write the changelog #docs [status:: todo] [start:: ${day(3)}] [due:: ${day(6)}]\n- [ ] Prepare the release material #marketing [status:: todo] [start:: ${day(1)}] [due:: ${day(8)}]\n\n## In Progress\n\n- [ ] Fix the sync bug #bug [status:: doing] [start:: ${day(-4)}] [due:: ${day(2)}]\n- [ ] Review the parser #dev [status:: doing] [start:: ${day(-1)}] [due:: ${day(4)}]\n\n## Done\n\n- [x] Redesign the home page #design [status:: done] [start:: ${day(-9)}] [due:: ${day(-3)}]\n- [x] Move to Electron #dev [status:: done] [start:: ${day(-12)}] [due:: ${day(-6)}]\n`;
const SALES = ['date,customer,city,amount,status', '2026-10-02,PT Maju Jaya,Jakarta,12400000,paid', '2026-10-03,CV Sinar Baru,Bandung,8750000,paid', '2026-10-04,Toko Makmur,Surabaya,6200000,pending', '2026-10-05,UD Berkah,Medan,2300000,refunded', '2026-10-06,PT Nusa Kita,Semarang,9100000,paid', '2026-10-07,CV Harapan,Makassar,4800000,pending'].join('\n') + '\n';
const SALES_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sales report</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:32px 40px;color:#2e3436;background:#fff}
h1{font-size:22px;margin:0 0 4px}p{color:#5e6a6e;margin:0 0 20px}
.row{display:flex;align-items:center;gap:12px;margin:8px 0}.name{width:110px}
.bar{height:22px;border-radius:5px;background:#3584e4}.value{color:#5e6a6e}
button{margin-top:18px;font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #c0bfbc;background:#f6f5f4}
</style></head><body><h1>Sales per city</h1><p>A page in the work folder. It runs its own script, but it cannot reach the network.</p>
<div id="bars"></div><button id="b">Show in millions</button>
<script>
const data = [['Jakarta', 12.4], ['Surabaya', 6.2], ['Bandung', 8.75], ['Semarang', 9.1], ['Medan', 2.3]];
const box = document.getElementById('bars');
let millions = false;
function draw() {
  box.innerHTML = '';
  for (const [city, v] of data) {
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = '<span class="name">' + city + '</span><div class="bar" style="width:' + v * 28 + 'px"></div><span class="value">' + (millions ? v + ' M' : (v * 1000000).toLocaleString('en-US')) + '</span>';
    box.append(r);
  }
}
document.getElementById('b').onclick = () => { millions = !millions; draw(); };
draw();
</script></body></html>
`;
const PI_BOARD = '---\nlayout: board\nproject: web-ecommerce\n---\n\n## Plan\n\n- [ ] Checkout with QRIS #feature\n  Use the official SDK.\n- [ ] Test the cart #test\n- [ ] Tidy up the README #docs\n\n## In Progress\n\n## Review\n\n## Done\n\n- [x] Product page #feature\n';

// ---------- Files, git, and images ----------

function put(root, rel, text) {
    const path = join(root, ...rel.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
}
const gitIn = (cwd, name = 'Eka Putra', email = 'eka@example.com') => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
} }).trim();

// GIF: one palette from every frame of the animation (sampled every 4 pixels), one index left for "transparent", and the
// pixels that did not change from the frame before written as transparent (much smaller).
function writeGif(name, frames) {
    const { width, height } = frames[0];
    const sample = new Uint8Array(frames.reduce((sum, f) => sum + Math.ceil(f.rgba.length / 16) * 4, 0));
    let at = 0;
    for (const f of frames) for (let i = 0; i < f.rgba.length; i += 16) { sample.set(f.rgba.subarray(i, i + 4), at); at += 4; }
    const palette = quantize(sample, GIF_COLORS - 1);
    const clear = palette.length;
    palette.push([0, 0, 0]);
    const gif = GIFEncoder();
    let previous = null;
    for (const f of frames) {
        const index = applyPalette(f.rgba, palette);
        if (!previous) gif.writeFrame(index, width, height, { palette, delay: f.delay });
        else {
            const diff = index.slice();
            for (let i = 0; i < diff.length; i++) if (diff[i] === previous[i]) diff[i] = clear;
            gif.writeFrame(diff, width, height, { delay: f.delay, transparent: true, transparentIndex: clear, dispose: 1 });
        }
        previous = index;
    }
    gif.finish();
    writeFileSync(join(OUT, `${name}.gif`), gif.bytes());
    console.log(`  ${name}.gif: ${frames.length} frames, ${Math.round(gif.bytes().length / 1024)} KB`);
}

// ---------- One run of the app ----------

class Run {
    constructor(name, folder, { env = {}, settings = {} } = {}) {
        Object.assign(this, { name, folder, env, settings });
        this.gifs = new Map();
        this.scratch = scratchFolder(`capture-${name}`).scratch;
    }

    async start() {
        const config = join(this.scratch, 'config', 'markwork-electron');
        mkdirSync(config, { recursive: true });
        writeFileSync(join(config, 'settings.json'), JSON.stringify({ welcomed: true, home: false, 'color-scheme': 'light', sidebar: true, chat: false, 'forge-notify': false, ...this.settings }));
        // HOME is the folder's parent, so the window names the folder ~/name rather than a temporary path.
        this.app = await launchApp({ scratch: this.scratch, notes: this.folder, env: { HOME: dirname(this.folder), DEEPSEEK_API_KEY: 'example', MARKWORK_TEST_MODEL: module('model.mjs'), ...this.env } });
        this.page = await this.app.firstWindow();
        await this.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [WIDTH, HEIGHT]);
        await this.page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [WIDTH, HEIGHT]);
        await this.page.getByRole('tree').waitFor({ timeout: 20000 });
        // The toasts are kept, so a scene that stops can say what the app last told the user.
        await this.page.evaluate(() => {
            window.toasts = [];
            new MutationObserver(() => {
                const text = document.querySelector('.notification .message')?.textContent;
                if (text && window.toasts.at(-1) !== text) window.toasts.push(text);
            }).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await this.idle(500);
    }

    async close() {
        // A scene that stopped leaves a picture of where it was, next to the shots.
        if (this.failed) {
            await this.page?.screenshot({ path: join(OUT, `failed-${this.name}.png`) }).catch(() => {});
            for (const text of await this.page?.evaluate(() => window.toasts).catch(() => []) ?? []) console.log(`  toast: ${text}`);
        }
        for (const [name, frames] of this.gifs) writeGif(name, frames);
        await Promise.race([this.app.close().catch(() => {}), sleep(5000)]);
        try { this.app.process().kill(); } catch { /* already gone */ }
    }

    idle(ms) { return sleep(ms); }

    // A PNG of the window, or of one element of it.
    async shot(name, locator = null) {
        // A toast left from an earlier step is not part of the picture.
        const toast = this.page.locator('.notification').getByRole('button', { name: 'Dismiss' });
        if (await toast.isVisible().catch(() => false)) await toast.click().catch(() => {});
        await this.idle(250);
        await (locator ?? this.page).screenshot({ path: join(OUT, `${name}.png`) });
        console.log(`  ${name}.png`);
    }

    // A frame of an animation, held for `hold` more steps.
    async frame(gif, hold = 0) {
        const { width, height, data } = await this.app.evaluate(async ({ BrowserWindow }, w) => {
            const image = (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).resize({ width: w, quality: 'best' });
            return { ...image.getSize(), data: image.toBitmap().toString('base64') };
        }, GIF_WIDTH);
        const rgba = new Uint8Array(Buffer.from(data, 'base64'));
        for (let i = 0; i < rgba.length; i += 4) { const b = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = b; rgba[i + 3] = 255; }   // BGRA → RGBA
        if (!this.gifs.has(gif)) this.gifs.set(gif, []);
        this.gifs.get(gif).push({ width, height, rgba, delay: GIF_STEP * (1 + hold) });
    }

    // Frames of `gif` every `every` ms until `done` settles.
    async record(gif, done, every = 280) {
        let finished = false;
        const outcome = Promise.resolve(done).then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
        while (!finished) { await this.frame(gif); await sleep(every); }
        const { value, error } = await outcome;
        if (error) throw error;
        return value;
    }

    // The social share image: the window scaled to 1200 px wide, cut to 1200 × 631.
    async ogImage(name) {
        const data = await this.app.evaluate(async ({ BrowserWindow }) => {
            const image = (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).resize({ width: 1200, quality: 'best' });
            return image.crop({ x: 0, y: 0, width: 1200, height: 631 }).toPNG().toString('base64');
        });
        writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
        console.log(`  ${name}.png`);
    }

    // A file of the folder in its tab: its folders are opened in the Files tab first. The other tabs are closed, so a
    // picture shows one document, unless `keep` (the tabs scene).
    async open(rel, { keep = false } = {}) {
        const { page } = this;
        if ((await page.getByRole('button', { name: 'Files', exact: true }).getAttribute('aria-pressed')) !== 'true') await page.getByRole('button', { name: 'Files', exact: true }).click();
        const parts = rel.split('/');
        for (const folder of parts.slice(0, -1)) {
            const item = page.getByRole('treeitem', { name: new RegExp(`^${folder}$`) });
            if ((await item.getAttribute('aria-expanded')) !== 'true') await item.click();
        }
        const name = parts.at(-1);
        await page.getByRole('treeitem', { name: new RegExp(`^${name.replace(/\./g, '\\.')}`) }).first().click();
        await page.locator('.headerbar .title').getByText(name, { exact: true }).waitFor();
        if (!keep) await this.closeOtherTabs();
        await this.idle(400);
    }

    async closeOtherTabs() {
        const { page } = this;
        for (let i = 0; i < 20; i++) {
            const other = page.getByRole('tab', { selected: false }).getByRole('button', { name: /Close/ });
            if (!(await other.count())) return;
            await other.first().click();
            const ask = page.getByRole('alertdialog');
            if (await ask.waitFor({ timeout: 500 }).then(() => true, () => false)) await ask.getByRole('button', { name: /Discard|Don.t Save|Close Without Saving/ }).first().click();
        }
    }

    // The editor: the cursor at a line (from 0) and column, and text inserted at a position.
    cursorTo(line, column = 0) {
        return this.page.evaluate(([l, c]) => {
            const view = document.querySelector('.cm-content').cmTile.view;
            const at = view.state.doc.line(Math.min(l + 1, view.state.doc.lines));
            view.dispatch({ selection: { anchor: Math.min(at.from + c, at.to) }, scrollIntoView: true });
            view.focus();
        }, [line, column]);
    }
    insert(text, at = null) {
        return this.page.evaluate(([t, a]) => {
            const view = document.querySelector('.cm-content').cmTile.view;
            const from = a ?? view.state.selection.main.head;
            view.dispatch({ changes: { from, insert: t }, selection: { anchor: from + t.length }, userEvent: 'input.type' });
        }, [text, at]);
    }
    async scrollTop() { await this.page.evaluate(() => { const s = document.querySelector('.cm-scroller'); if (s) s.scrollTop = 0; }); }

    // A setting the window writes (Toggle Sidebar, the Assistant) when it is not what is wanted.
    async panel(name, open) {
        const button = name === 'chat' ? this.page.getByRole('button', { name: 'Assistant', exact: true }) : this.page.getByRole('button', { name: 'Toggle Sidebar' });
        if (((await button.getAttribute('aria-pressed')) === 'true') !== open) await button.click();
        await this.idle(250);
    }
    async dark(on) {
        const isDark = await this.page.evaluate(() => document.documentElement.dataset.theme === 'dark');
        if (isDark !== on) await this.page.keyboard.press('ControlOrMeta+Shift+D');
        await this.page.waitForFunction(d => (document.documentElement.dataset.theme === 'dark') === d, on);
        await this.idle(300);
    }
    // A command run from the palette by its name.
    async command(name) {
        await this.page.keyboard.press('ControlOrMeta+Shift+P');
        await this.page.locator('.palette input').fill(name);
        await this.page.keyboard.press('Enter');
        await this.idle(200);
    }
    async menu(item) {
        await this.page.getByRole('button', { name: 'Main Menu' }).click();
        await this.page.getByRole('menuitem', { name: item }).click();
    }

    // The Assistant: a question asked, and its answer waited for.
    get chat() { return this.page.getByRole('complementary', { name: 'Assistant' }); }
    async ask(question) {
        const send = this.page.getByRole('button', { name: 'Send', exact: true });
        await send.waitFor();
        await this.page.getByLabel('Ask the Assistant').fill(question);
        await send.click();
        await this.page.getByRole('button', { name: 'Stop', exact: true }).waitFor().catch(() => {});
    }
    answered() { return this.page.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 30000 }); }
    async newConversation() { await this.chat.getByRole('button', { name: 'New conversation' }).click(); await this.idle(200); }
}

// ---------- The scenes ----------

// The launch project with every sample document the editor scenes open, and a run of the app on it.
function workRun(name, settings = {}) {
    const root = join(scratchFolder('capture-work').scratch, 'markwork-launch');
    for (const [rel, text] of Object.entries(WORK)) put(root, rel, text);
    put(root, 'meeting-notes.md', DOC);
    put(root, 'budget.md', TABLE_DOC);
    put(root, 'schema.md', DBML_DOC);
    put(root, 'board.md', BOARD);
    put(root, 'typing.md', '');
    put(root, 'workflow.md', '# Workflow\n\n```mermaid\ngraph LR\n    A[Note] --> B[Plan]\n```\n');
    put(root, 'launch-plan.md', LAYOUTS_DOC());
    put(root, 'image.md', '# Image\n\nDouble-click the image to enlarge it.\n\n![Example image](images/example.png)\n');
    mkdirSync(join(root, 'images'), { recursive: true });
    copyFileSync(join(repo, 'tests/samples/images/example.png'), join(root, 'images', 'example.png'));
    put(root, 'data/sales.csv', SALES);
    put(root, 'reports/sales.html', SALES_PAGE);
    return { root, run: new Run(name, root, { settings: { 'chat-save': true, ...settings } }) };
}

const GROUPS = {
    // The Markdown editor and the structured views: tables, diagrams, the syntax, typing, the board, and the layouts.
    async markdown() {
        const { root, run } = workRun('markdown');
        await run.start();
        const { page } = run;
        try {
            // Markdown: a table, a database diagram, and a board.
            await run.open('budget.md');
            await run.cursorTo(0);
            await run.shot('table');
            await run.panel('sidebar', false);
            await run.open('schema.md').catch(async () => { await run.panel('sidebar', true); await run.open('schema.md'); await run.panel('sidebar', false); });
            await run.cursorTo(0);
            await page.locator('.cm-md-diagram svg').first().waitFor({ timeout: 20000 });
            await run.shot('dbml');

            // The syntax shows on the cursor's line only.
            await run.panel('sidebar', true);
            await run.open('meeting-notes.md');
            for (const [line, col] of [[0, 8], [2, 20], [2, 55], [5, 12], [6, 8], [7, 20], [0, 0]]) {
                await run.cursorTo(line, col);
                await run.idle(150);
                await run.frame('syntax', 2);
            }

            // Typing Markdown.
            await run.open('typing.md');
            await run.cursorTo(0);
            await run.frame('typing', 2);
            const typed = '# Meeting Notes\n\nDecision: release on **22 November**, the budget is *unchanged*, and the bug is in `syncing`.\n\n- [ ] Budi: fix the bug\n- [x] Sari: prepare the material\n- [ ] Dewi: schedule the beta\n';
            let count = 0;
            for (const ch of typed) {
                await run.insert(ch);
                count++;
                if (' \n*`#'.includes(ch) || (/[a-z]/i.test(ch) && count % 3 === 0)) await run.frame('typing');
            }
            await run.frame('typing', 6);

            // A diagram drawn while it is written.
            await run.panel('sidebar', false);
            await run.panel('sidebar', true);
            await run.open('workflow.md');
            await run.panel('sidebar', false);
            await run.cursorTo(0);
            await page.locator('.cm-md-diagram svg').first().waitFor({ timeout: 20000 });
            await run.frame('diagram', 3);
            await run.cursorTo(4, 20);
            await run.idle(400);
            await run.frame('diagram', 3);
            for (const add of ['\n    B --> C[Do it]', '\n    C --> D[Review]', '\n    D --> A']) {
                const end = await page.evaluate(() => { const v = document.querySelector('.cm-content').cmTile.view; return v.state.doc.line(5).to; });
                await run.insert(add, end);
                await run.idle(900);
                await run.frame('diagram', 3);
            }
            await run.cursorTo(0);
            await run.idle(900);
            await run.frame('diagram', 8);

            // The board, and cards moved across it.
            await run.panel('sidebar', true);
            await run.open('board.md');
            await run.panel('sidebar', false);
            await page.locator('.board .card').first().waitFor();
            await run.shot('kanban');
            await run.frame('kanban', 5);
            const card = text => page.locator('.board .card', { hasText: text });
            const list = name => page.locator(`.board .column[aria-label="${name}"] .cards`);
            for (const [text, to] of [['User research', 'In Progress'], ['Fix the', 'Review'], ['Implement the kanban', 'Review']]) {
                await card(text).dragTo(list(to));
                await run.idle(500);
                await run.frame('kanban', 5);
            }
            // The card dialog.
            await card('Redesign the home page').click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor();
            await run.shot('kanban-card', dialog);
            await page.keyboard.press('Escape');

            // One file, many layouts.
            await run.panel('sidebar', true);
            await run.open('launch-plan.md');
            await run.panel('sidebar', false);
            // The page of each layout (a list is drawn by the inbox page).
            for (const [layout, label, shown] of [['board', 'Board', 'board'], ['list', 'List', 'inbox'], ['table', 'Table', 'table'], ['calendar', 'Calendar', 'calendar'], ['timeline', 'Timeline', 'timeline'], ['gallery', 'Gallery', 'gallery'], ['chart', 'Chart', 'chart']]) {
                await page.locator('.headerbar button[aria-label=Layout]').click();
                await page.getByRole('menuitem', { name: new RegExp(`^(✓ )?${label}$`) }).click();
                await page.locator(`[data-page=${shown}]`).waitFor();
                await run.idle(600);
                await run.shot(`layout-${layout}`);
                await run.frame('layouts', 8);
            }
            await page.locator('.headerbar button[aria-label=Layout]').click();
            await page.getByRole('menuitem', { name: /^(✓ )?Board$/ }).click();
            await run.idle(400);
            await run.frame('layouts', 8);

        } catch (e) {
            run.failed = true;
            throw e;
        } finally {
            await run.close();
        }
    },

    // The Assistant: an answer from the folder, proposals reviewed and applied, the tree, tabs, conversations, the context, a plan of work, and the agent log.
    async assistant() {
        const { root, run } = workRun('assistant');
        await run.start();
        const { page } = run;
        try {
            // The Assistant answers from the folder.
            await run.panel('sidebar', true);
            await run.open('plans/launch.md');
            await run.panel('chat', true);
            await run.frame('assistant', 4);
            await run.ask(ASK_READ);
            await run.record('assistant', run.answered());
            await run.frame('assistant', 10);

            // It proposes changes; each is reviewed, applied, and the answer says what was done.
            await run.newConversation();
            await run.ask(ASK_ACT);
            const review = page.getByRole('dialog', { name: /Agent proposal/ });
            for (const [name, hold] of [['proposal-diff', 6], ['proposal-kanban', 0]]) {
                await run.record('agent', review.waitFor({ timeout: 30000 }));
                await run.idle(300);
                await run.frame('agent', 8);
                await run.shot(name, review);
                await review.getByRole('button', { name: 'Apply', exact: true }).click();
                await review.waitFor({ state: 'detached' });
                if (hold) { await run.idle(400); await run.frame('agent', hold); }
            }
            await run.record('agent', run.answered());
            await run.idle(600);
            await run.frame('agent', 14);
            await run.shot('agent-done');
            await run.ogImage('og-image');

            // The folder tree, with the sample contents back as they were.
            for (const [rel, text] of Object.entries(WORK)) put(root, rel, text);
            await run.panel('chat', false);
            await run.open('research/competitors.md');
            await run.open('plans/launch.md');
            await run.shot('files');

            // Several tabs, one with unsaved changes.
            await run.command('Autosave');   // off, so the tab with the typing shows that it is not saved
            for (const rel of ['notes/meeting-1-oct.md', 'research/users.md', 'plans/launch.md']) await run.open(rel, { keep: true });
            const end = await page.evaluate(() => document.querySelector('.cm-content').cmTile.view.state.doc.length);
            await run.insert('\n## Risks\n\nThe sync bug could push back the public release.\n', end);
            await run.scrollTop();
            await run.cursorTo(0);
            await run.shot('tab');
            await page.keyboard.press('ControlOrMeta+s');
            await run.command('Autosave');

            // Earlier conversations in the history list.
            await run.panel('chat', true);
            for (const question of ['Summarize this week\'s meeting notes', 'List the launch risks']) {
                await run.newConversation();
                await run.ask(question);
                await run.answered();
            }
            await run.newConversation();
            await run.ask(ASK_READ);
            await run.answered();
            await run.chat.getByRole('button', { name: 'Conversations' }).click();
            await run.chat.getByRole('dialog', { name: 'Conversations' }).waitFor();
            await run.shot('chat-history');
            await page.keyboard.press('Escape');

            // What is sent as context, with a selection in the plan.
            await page.evaluate(() => {
                const view = document.querySelector('.cm-content').cmTile.view, text = view.state.doc.toString();
                view.dispatch({ selection: { anchor: text.indexOf('- Public release'), head: text.indexOf('15 November') + '15 November'.length } });
                view.focus();
            });
            await run.idle(400);
            await run.chat.getByRole('button', { name: /^Context/ }).click();
            await run.chat.getByRole('dialog', { name: 'Context' }).waitFor();
            await run.shot('context');
            await page.keyboard.press('Escape');

            // A plan of work, a batch reviewed in part, and the result checked.
            for (const [rel, text] of Object.entries(WORK)) put(root, rel, text);
            await run.cursorTo(0);
            await run.panel('sidebar', false);
            await run.newConversation();
            await run.frame('work', 4);
            await run.ask(ASK_WORK);
            await run.record('work', review.waitFor({ timeout: 30000 }));
            await run.frame('work', 8);
            const picks = review.locator('.picks input[type=checkbox]');
            await picks.nth(2).uncheck();
            await review.getByLabel('Note for the agent').fill('I will write the 8 October meeting notes myself');
            await run.shot('proposal-batch', review);
            await picks.nth(2).check();
            await review.getByLabel('Note for the agent').fill('');
            await review.getByRole('button', { name: 'Apply', exact: true }).click();
            await run.record('work', run.answered());
            await run.idle(600);
            await run.frame('work', 16);
            await run.shot('work');
            await page.locator('.chat-messages').evaluate(el => { el.scrollTop = 0; });
            await run.shot('plan', run.chat);

            // The agent log of that work.
            await run.chat.getByRole('button', { name: 'Agent log' }).click();
            const log = page.getByRole('dialog', { name: 'Agent log' });
            await log.getByRole('treeitem').first().waitFor();
            await run.shot('agent-log', log);
            await page.keyboard.press('Escape');
            await run.panel('chat', false);

        } catch (e) {
            run.failed = true;
            throw e;
        } finally {
            await run.close();
        }
    },

    // The small tools: a picture enlarged, search, a CSV table, an HTML page, the command palette, and Preferences.
    async tools() {
        const { root, run } = workRun('tools');
        await run.start();
        const { page } = run;
        try {
            // A picture enlarged.
            await run.panel('sidebar', true);
            await run.open('image.md');
            await page.locator('.cm-md-pictures img').first().waitFor();
            await page.waitForFunction(() => [...document.querySelectorAll('.cm-md-pictures img')].every(i => i.naturalWidth > 0));
            await page.locator('.cm-md-pictures img').first().dblclick();
            await page.locator('.image-viewer img').waitFor();
            await run.shot('image-zoom');
            await page.keyboard.press('Escape');

            // Search across the notes.
            await page.keyboard.press('ControlOrMeta+Shift+f');
            await page.getByRole('searchbox', { name: 'Search' }).fill('release');
            await page.locator('.results .hit').first().waitFor();
            await run.shot('search');

            // A CSV file and an HTML page in tabs of their own.
            await run.open('data/sales.csv');
            await page.locator('[data-page=csv]').waitFor();
            await run.shot('csv');
            await run.open('reports/sales.html');
            await page.frameLocator('iframe').getByRole('heading', { name: 'Sales per city' }).waitFor();
            await run.idle(500);
            await run.shot('html-page');

            // The command palette, and Preferences.
            await run.open('meeting-notes.md');
            await run.panel('sidebar', false);
            await page.keyboard.press('ControlOrMeta+Shift+P');
            await page.locator('.palette input').fill('table');
            await run.shot('palette');
            await page.keyboard.press('Escape');
            await run.menu('Preferences');
            const prefs = page.getByRole('dialog', { name: 'Preferences' });
            await prefs.waitFor();
            await run.shot('preferences');
            await prefs.getByRole('tab', { name: 'Agents' }).click();
            await run.shot('preferences-agents');
            await page.keyboard.press('Escape');
        } catch (e) {
            run.failed = true;
            throw e;
        } finally {
            await run.close();
        }
    },

    // The Git history of a small repository, the reading window of a commit, and the Assistant reading the history.
    async history() {
        const root = join(scratchFolder('capture-history').scratch, 'launch-notes');
        mkdirSync(root, { recursive: true });
        const git = gitIn(root);
        git('init', '-q', '-b', 'main');
        for (const [message, text] of [
            ['Create the plan outline', '# Launch Plan\n\n## Goal\n\nRelease Markwork 1.0.\n'],
            ['Add a schedule section', '# Launch Plan\n\n## Goal\n\nRelease Markwork 1.0.\n\n## Schedule\n\n- Closed beta: October\n'],
            ['Clarify the goal and the dates', '# Launch Plan\n\n## Goal\n\nRelease Markwork 1.0 for Linux users, complete with folder syncing.\n\n## Schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n'],
        ]) {
            put(root, 'plan.md', text);
            git('add', 'plan.md');
            git('commit', '-q', '-m', message);
        }
        put(root, 'plan.md', `${readFileSync(join(root, 'plan.md'), 'utf8')}- Evaluation: 30 November\n`);
        put(root, 'ideas.md', '# Ideas\n\nA PDF export feature (not in git yet).\n');
        const run = new Run('history', root);
        await run.start();
        const { page } = run;
        try {
            await run.open('plan.md');
            await page.getByRole('button', { name: 'History', exact: true }).click();
            const history = page.getByRole('complementary', { name: 'History' });
            await history.getByRole('button', { name: /Clarify the goal/ }).waitFor({ timeout: 15000 });
            await run.shot('history');
            await run.dark(true);
            await run.shot('history-dark');
            await run.dark(false);
            await history.getByRole('button', { name: /Clarify the goal/ }).click();
            const viewer = page.getByRole('dialog', { name: /Clarify the goal/ });
            await viewer.locator('pre.diff .line.add').first().waitFor();
            await run.shot('history-diff', viewer);
            await page.keyboard.press('Escape');
            await run.panel('chat', true);
            await run.ask('When was the public release date written in the plan, and by whom?');
            await run.answered();
            await run.idle(500);
            await run.shot('agent-git');
        } catch (e) {
            run.failed = true;
            throw e;
        } finally {
            await run.close();
        }
    },

    // Pull requests: the list, a review with its note view, raw diff, and discussion, a conflict resolved here, and
    // sending the folder's changes. The forge is a fake; git is real (a local bare repository stands for the server's).
    async collab() {
        const root = scratchFolder('capture-collab').scratch;
        const bare = join(root, 'forge.git'), work = join(root, 'markwork-launch'), author = join(root, 'author');
        mkdirSync(bare, { recursive: true });
        gitIn(bare)('init', '-q', '--bare', '-b', 'main');
        gitIn(root)('clone', '-q', bare, work);
        const sh = gitIn(work, 'Sari', 'sari@example.com');
        sh('checkout', '-q', '-B', 'main');
        // The app merges here itself, as the user; HOME has no git config, so the folder names who that is.
        sh('config', 'user.name', 'Eka Putra');
        sh('config', 'user.email', 'eka@example.com');
        for (const [rel, text] of [['plans/launch.md', LAUNCH], ['plans/schedule.md', SCHEDULE], ['notes/meeting-1-oct.md', WORK['notes/meeting-1-oct.md']], ['research/competitors.md', RESEARCH]]) put(work, rel, text);
        sh('add', '-A');
        sh('commit', '-q', '-m', 'Start the launch project');
        sh('push', '-q', '-u', 'origin', 'main');
        // Pull request 12 edits a line that main changes too, so it conflicts. A forge keeps its head under refs/pull/12/head.
        gitIn(root)('clone', '-q', bare, author);
        const by = gitIn(author, 'Dewi', 'dewi@example.com');
        by('checkout', '-q', '-b', 'research-wording');
        put(author, 'research/competitors.md', RESEARCH.replace('Three similar', 'Three similar, comparable'));
        by('commit', '-q', '-a', '-m', 'Fix the wording');
        by('push', '-q', 'origin', 'research-wording');
        gitIn(bare)('update-ref', 'refs/pull/12/head', by('rev-parse', 'HEAD'));
        put(work, 'research/competitors.md', RESEARCH.replace('Three similar note apps', 'Four similar note apps'));
        sh('commit', '-q', '-a', '-m', 'Count the fourth app');
        sh('push', '-q', 'origin', 'main');

        const run = new Run('collab', work, { env: { MARKWORK_TEST_FORGE: module('forge.mjs'), MARKWORK_CAPTURE_BARE: bare } });
        await run.start();
        const { page } = run;
        try {
            await run.open('plans/launch.md');
            await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
            const collab = page.getByRole('complementary', { name: 'Pull requests' });
            await collab.getByRole('button', { name: /Postpone the public release/ }).waitFor({ timeout: 15000 });
            await run.idle(400);
            await run.frame('collab', 8);
            const pull = page.locator('.pull-page');
            await collab.getByRole('button', { name: /Postpone the public release/ }).click();
            await pull.locator('pre.diff .line.add').first().waitFor({ timeout: 15000 });
            await run.idle(500);
            await run.shot('collab-review');
            await run.frame('collab', 10);
            await pull.getByRole('tab', { name: 'Raw diff' }).click();
            await run.idle(300);
            await run.shot('collab-diff');
            await run.frame('collab', 8);
            await pull.getByRole('tab', { name: /Discussion/ }).click();
            await pull.locator('.comment').first().waitFor();
            await run.shot('collab-discussion');
            await run.frame('collab', 10);
            // The conflicting one, merged here: the file opens with git's markers.
            await collab.getByRole('button', { name: /Fix the wording/ }).click();
            await pull.getByRole('button', { name: 'Resolve locally…' }).click();
            await page.getByRole('alertdialog').getByRole('button', { name: 'Merge Here' }).click();
            await page.locator('.cm-content').getByText('<<<<<<<').first().waitFor({ timeout: 15000 });
            await run.idle(800);
            await run.shot('collab-resolve');
            await run.frame('collab', 12);
            // The merge is undone from its pull request, which the opened file put behind the document.
            await collab.getByRole('button', { name: /Fix the wording/ }).click();
            await pull.getByRole('button', { name: 'Abort merge' }).click();
            const abort = page.getByRole('alertdialog');
            if (await abort.waitFor({ timeout: 2000 }).then(() => true, () => false)) await abort.getByRole('button', { name: 'Undo the Merge' }).click();
            await pull.getByRole('button', { name: 'Abort merge' }).waitFor({ state: 'detached' });
            await run.open('plans/launch.md');
            await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
            await page.getByRole('button', { name: 'Dismiss' }).click().catch(() => {});
            await run.idle(600);
            // Sending the folder's changes as a pull request.
            put(work, 'plans/launch.md', LAUNCH.replace('Public release: 15 November', 'Public release: 22 November'));
            await collab.getByRole('button', { name: 'Send changes as a pull request' }).click();
            const send = page.getByRole('dialog', { name: 'Send Changes as Pull Request' });
            await send.waitFor();
            await send.getByLabel('Title').fill('Move the public release to 22 November').catch(() => {});
            await run.idle(500);
            await run.shot('collab-send');
            await run.frame('collab', 12);
            await send.getByRole('button', { name: 'Cancel' }).click();
        } catch (e) {
            run.failed = true;
            throw e;
        } finally {
            await run.close();
        }
    },

    // Cards worked on by an agent (a fake pi): running and queued, done, waiting for an answer, its log, the review of its
    // worktree, a pull request from it, the project and machine settings, and the question when the window closes.
    async agents() {
        const root = scratchFolder('capture-agents').scratch;
        const notes = join(root, 'workspace'), project = join(root, 'web-ecommerce'), pi = join(root, 'pi');
        mkdirSync(pi, { recursive: true });
        put(notes, 'development.md', PI_BOARD);
        const git = gitIn(project);
        put(project, 'README.md', '# Web e-commerce\n\nInstall with `npm install` or `pnpm install`.\n');
        put(project, 'src/checkout/cart.ts', 'export const cartTotal = (items: { price: number; qty: number }[]) => items.reduce((sum, i) => sum + i.price * i.qty, 0);\n');
        put(project, 'src/checkout/index.ts', "export { cartTotal } from './cart.js';\n");
        git('init', '-q', '-b', 'main');
        git('add', '-A');
        git('commit', '-q', '-m', 'Start the shop');
        git('remote', 'add', 'origin', 'https://git.example.org/markwork/launch.git');   // the fake forge answers for it
        const mode = m => writeFileSync(join(pi, 'mode'), m);
        const run = new Run('agents', notes, {
            env: { MARKWORK_TEST_HARNESS: module('agent.mjs'), MARKWORK_CAPTURE_PI: pi, MARKWORK_PICK_FOLDER: project, MARKWORK_TEST_FORGE: module('forge.mjs') },
            settings: { projects: { 'web-ecommerce': project }, machines: { vps: 'eka@vps.example.com', nas: 'eka@nas.local' } },
        });
        await run.start();
        const { page } = run;
        const card = text => page.locator('.board .card', { hasText: text });
        const badge = (text, status) => card(text).locator('.chip.agent', { hasText: status });
        const choose = async (text, item) => {
            await card(text).click({ button: 'right' });
            await page.getByRole('menuitem', { name: item }).click();
        };
        try {
            await run.open('development.md');
            await run.panel('sidebar', false);
            await card('Checkout').waitFor();
            await run.frame('pi', 8);
            mode('slow');
            // One at a time: a card that starts moves to In Progress, and a right-click during that move hits another card.
            await choose('Checkout with QRIS', 'Work on it with pi');
            await badge('Checkout', 'working').waitFor({ timeout: 20000 });
            await run.idle(400);
            await choose('Test the cart', 'Work on it with pi');
            await card('Test the cart').locator('.chip.agent').waitFor({ timeout: 20000 });
            await run.idle(500);
            await run.frame('pi', 10);
            await run.shot('pi-board');
            writeFileSync(join(pi, 'release'), '');
            await badge('Checkout', 'done').waitFor({ timeout: 30000 });
            await badge('Test the cart', 'done').waitFor({ timeout: 30000 });
            await run.idle(500);
            await run.frame('pi', 8);
            mode('ask');
            await choose('Tidy up the README', 'Work on it with pi');
            await badge('Tidy up the README', 'waiting').waitFor({ timeout: 20000 });
            await run.idle(500);
            await run.frame('pi', 14);
            await run.shot('pi-waiting');
            await choose('Tidy up the README', 'Answer pi…');
            const answer = page.getByRole('dialog', { name: /pi/ });
            await answer.waitFor();
            await run.shot('pi-answer', answer);
            await answer.getByRole('button', { name: 'Later' }).click();
            await choose('Checkout with QRIS', 'View pi Log');
            const log = page.getByRole('dialog', { name: /pi Log/ });
            await log.getByRole('treeitem').first().waitFor();
            await run.shot('pi-log', log);
            await page.keyboard.press('Escape');

            // The question when the window closes while an agent waits.
            await run.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
            const closing = page.getByRole('alertdialog');
            await closing.waitFor({ timeout: 10000 });
            await run.shot('pi-close');
            await closing.getByRole('button', { name: 'Cancel' }).click();
            await choose('Tidy up the README', 'Stop pi');

            // A card's worktree reviewed (its first run committed): its files, a diff with a comment, and how it is finished.
            await page.locator('.board .card', { hasText: 'Checkout with QRIS' }).waitFor();
            await choose('Checkout with QRIS', 'Review Changes');
            const files = page.getByRole('navigation', { name: 'Changed files' });
            await files.getByRole('button', { name: /qris\.ts/ }).first().waitFor({ timeout: 20000 });
            await files.getByRole('button', { name: /qris\.ts/ }).first().click();
            const line = page.locator('pre.diff .line.add').nth(1);
            await line.hover();
            await line.getByRole('button', { name: /Comment on line/ }).click();
            await page.getByLabel('Comment', { exact: true }).fill('Use the official SDK here, as the card says.');
            await page.getByRole('button', { name: 'Add Comment' }).click();
            await run.idle(400);
            await run.shot('pi-review');
            await page.getByRole('button', { name: 'More ways to finish' }).click();
            const finish = page.getByRole('menu');
            await finish.waitFor();
            await run.shot('pi-pr-menu', finish);
            const pullItem = finish.getByRole('menuitem', { name: /Pull Request/ });
            if (await pullItem.isEnabled()) {
                await pullItem.click();
                const form = page.getByRole('dialog', { name: /Pull Request/ });
                await form.waitFor();
                await run.shot('pi-pr-dialog');
                await form.getByRole('button', { name: 'Cancel' }).click();
            } else {
                console.log('  pi-pr-dialog: skipped, the project has no forge to send a pull request to');
                await page.keyboard.press('Escape');
            }
            await page.getByRole('button', { name: 'Close the review' }).click().catch(() => {});

            // Preferences → Agents: the machines, and the page of one project.
            await run.menu('Preferences');
            const prefs = page.getByRole('dialog', { name: 'Preferences' });
            await prefs.getByRole('tab', { name: 'Agents' }).click();
            await prefs.getByRole('button', { name: 'Remove vps' }).waitFor();
            await run.shot('pi-machines');
            await prefs.getByRole('button', { name: /web-ecommerce/ }).click();
            await prefs.getByText('A worktree per card').waitFor();
            await run.shot('pi-project');
            await page.keyboard.press('Escape');
        } catch (e) {
            run.failed = true;
            throw e;
        } finally {
            await run.close();
        }
    },

    // The daily flow: Home with what is due, the inbox, and the journal.
    async daily() {
        const root = join(scratchFolder('capture-daily').scratch, 'markwork-launch');
        for (const [rel, text] of Object.entries(WORK)) put(root, rel, text);
        put(root, 'tasks.md', `---\nlayout: board\nproject: launch\n---\n\n## Plan\n\n- [ ] Prepare the release material #marketing [due:: ${day(1)}]\n- [ ] Write the release notes #docs [due:: ${day(2)}]\n\n## In Progress\n\n- [ ] Fix the sync bug #bug #important [due:: ${day(0)}]\n\n## Done\n\n- [x] Redesign the home page #design\n`);
        put(root, 'inbox.md', `---\nlayout: list\n---\n\n# Inbox\n\nA place to capture ideas, notes, and things to process later.\n\n- Read the article about writing release notes #read [created:: ${day(0)} 08:10]\n- Idea: offer a PDF export #idea [created:: ${day(-1)} 17:45]\n`);
        const run = new Run('daily', root);
        await run.start();
        const { page } = run;
        try {
            for (const rel of ['plans/launch.md', 'notes/meeting-1-oct.md', 'research/users.md']) await run.open(rel);
            await page.keyboard.press('Alt+Home');
            await page.getByRole('heading', { name: 'Due dates' }).waitFor();
            await run.idle(500);
            await run.frame('home', 10);
            await page.getByLabel('Mark done: Fix the sync bug').click();
            await run.idle(600);
            await run.frame('home', 6);
            await page.getByRole('button', { name: 'Add to Journal…', exact: true }).click();
            const add = page.getByRole('alertdialog');
            await add.getByRole('textbox').fill('Standup: the sync bug is done, the beta is next');
            await add.getByRole('button', { name: 'Add' }).click();
            await run.idle(600);
            await run.frame('home', 12);

            await run.open('inbox.md');
            await run.frame('inbox', 8);
            for (const text of ['Ask Dewi about the beta schedule #question', 'Write the release notes for 1.0 #docs']) {
                await page.getByLabel('Quick capture to the inbox').fill(text);
                await page.getByLabel('Quick capture to the inbox').press('Enter');
                await page.locator('.inbox-row', { hasText: text.split(' #')[0] }).waitFor();
                await run.idle(300);
                await run.frame('inbox', 8);
            }

            await run.open('tasks.md');
            await page.locator('.board .card', { hasText: 'Prepare the release' }).dragTo(page.locator('.board .column[aria-label="In Progress"] .cards'));
            await run.idle(500);
            await run.menu(/Today's Journal/);
            await run.idle(800);
            await run.scrollTop();
            await run.frame('journal', 10);
            await run.menu(/Add to Journal/);
            const note = page.getByRole('alertdialog');
            await note.getByRole('textbox').fill('? Does the beta need the sync fix first');
            await note.getByRole('button', { name: 'Add' }).click();
            await run.idle(800);
            await run.frame('journal', 14);
        } catch (e) {
            run.failed = true;
            throw e;
        } finally {
            await run.close();
        }
    },
};

// ---------- The sizes in the docs ----------

// The width and height of a PNG or GIF from its header.
function sizeOf(path) {
    const bytes = readFileSync(path);
    if (bytes.subarray(1, 4).toString() === 'PNG') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (bytes.subarray(0, 3).toString() === 'GIF') return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
    return null;
}

// Every <img src="…assets/NAME" width=… height=…> in docs/ gets the size of the file as it is now.
function updateSizes() {
    const pages = [join(repo, 'docs', 'index.html'), ...readdirSync(join(repo, 'docs', 'docs')).filter(f => f.endsWith('.html')).map(f => join(repo, 'docs', 'docs', f))];
    for (const page of pages) {
        const html = readFileSync(page, 'utf8');
        const next = html.replace(/<img src="((?:\.\.\/)?assets\/([^"]+))" width="\d+" height="\d+"/g, (all, src, name) => {
            const file = join(repo, 'docs', 'assets', name);
            const size = existsSync(file) && sizeOf(file);
            return size ? `<img src="${src}" width="${size[0]}" height="${size[1]}"` : all;
        });
        if (next !== html) writeFileSync(page, next);
    }
}

for (const [name, scene] of Object.entries(GROUPS)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(name);
    try {
        await scene();
    } catch (e) {
        console.error(`  ${name} stopped: ${e?.stack ?? e}`);
        process.exitCode = 1;
    }
}
if (!process.env.MARKWORK_OUT) updateSizes();
console.log(`Done: ${OUT}`);
process.exit();   // Playwright keeps the event loop alive
