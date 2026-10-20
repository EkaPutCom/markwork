// The structured-view scenarios (kanban, inbox, layouts, table layout, csv) run against the
// Electron window with Playwright: the real main process, core, and renderer. What the core decides is also in
// tests/unit/protocol.ts. Run with `npm run test:electron`.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scratchFolder, launchApp, waitFor, stepper } from './support.mjs';

const { scratch, notes } = scratchFolder('structured');
const pad = n => String(n).padStart(2, '0');
const now = new Date();
const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const read = name => readFileSync(join(notes, name), 'utf8');

writeFileSync(join(notes, 'board.md'), '---\nlayout: board\n---\n\n## Plan\n\n- [ ] One\n- [ ] Two\n\n## Done\n\n- [x] Old\n');
writeFileSync(join(notes, 'list.md'), '---\nlayout: list\nadd: top\nfields:\n  created: date = now\n  kind: select(idea:purple, task:amber)\n---\n\n# Inbox\n\nThings to sort.\n\n- First idea #idea [kind:: idea]\n- Second\n');
writeFileSync(join(notes, 'table.md'), '---\nlayout: table\nfields:\n  status: select(todo:gray, doing:blue, done:green) = todo\n  qty: number\n---\n\n# Table\n\n- Bravo [status:: todo] [qty:: 5]\n- Alpha [status:: done] [qty:: 9]\n');
writeFileSync(join(notes, 'cal.md'), `---\nlayout: calendar\nfields:\n  due: date\n---\n\n# Calendar\n\n- Release [due:: ${month}-10]\n- Undated\n`);
writeFileSync(join(notes, 'line.md'), '---\nlayout: timeline\nzoom: month\nfields:\n  start: date\n  due: date\n---\n\n# Line\n\n- Build [start:: 2026-10-05] [due:: 2026-10-09]\n');
writeFileSync(join(notes, 'gallery.md'), '---\nlayout: gallery\nfields:\n  cover: link\n---\n\n# Gallery\n\n- Sunset #sky\n- Forest #tree\n');
writeFileSync(join(notes, 'chart.md'), '---\nlayout: chart\nfields:\n  status: select(todo:gray, done:green)\n---\n\n# Chart\n\n- A [status:: todo]\n- B [status:: done]\n- C [status:: done]\n');
writeFileSync(join(notes, 'sheet.csv'), 'name,qty\nada,3\nlin,5\n');

const { steps, step } = stepper();

const app = await launchApp({ scratch, notes });
let failed = false;
try {
    const page = await app.firstWindow();
    const open = async name => {
        await page.getByRole('treeitem', { name: new RegExp(name.replace('.', '\\.')) }).click();
    };
    // The file once it is saved as `expect` says: Ctrl+S, then the disk is read until it matches. A change may not have
    // reached the document when the first Ctrl+S goes, so the key is pressed again while the file is not there yet.
    const saved = async (name, expect) => {
        let text = '';
        await waitFor(async () => {
            await page.keyboard.press('ControlOrMeta+s');
            for (const end = Date.now() + 500; Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
                text = read(name);
                if (expect.test(text)) return true;
            }
            return false;
        });
        return text;
    };
    const dialog = page.getByRole('dialog');
    const alert = page.getByRole('alertdialog');

    await step('the window starts and lists the folder', async () => {
        await page.getByRole('treeitem', { name: /board\.md/ }).waitFor({ timeout: 15000 });
    });

    // ---------- Board ----------

    await step('board: a card is added from the list and shows in the text', async () => {
        await open('board.md');
        await page.locator('[data-page=board]').waitFor();
        await page.getByRole('button', { name: 'Add card' }).first().click();
        await dialog.getByLabel('Title').fill('Three');
        await dialog.getByLabel('Tags').fill('tag');
        await dialog.getByLabel('Due', { exact: true }).fill('2026-10-25');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await page.locator('.board .card', { hasText: 'Three' }).waitFor();
        await page.locator('.board .card', { hasText: 'Three' }).getByText('#tag').waitFor();
        assert.match(await saved('board.md', /- \[ \] Three #tag \[due:: 2026-10-25\]/), /- \[ \] Three #tag \[due:: 2026-10-25\]/);
    });

    await step('board: a card is edited in the dialog, keeping the fields the dialog does not show', async () => {
        await page.locator('.board .card', { hasText: 'Three' }).click();
        await dialog.getByLabel('Title').fill('Three edited');
        await dialog.getByLabel('Notes').fill('a note\nsecond line');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await page.locator('.board .card', { hasText: 'Three edited' }).waitFor();
        const expected = /- \[ \] Three edited #tag \[due:: 2026-10-25\]\n {2}a note\n {2}second line/;
        const text = await saved('board.md', expected);
        assert.match(text, expected);
    });

    await step('board: a card dragged to another list moves there', async () => {
        const card = page.locator('.board .card', { hasText: 'Two' });
        await card.dragTo(page.locator('.board .column[aria-label=Done] .cards'));
        await page.locator('.board .column[aria-label=Done] .card', { hasText: 'Two' }).waitFor();
        assert.match(await saved('board.md', /## Done\n\n(?:- \[[ x]\] .*\n(?: {2}.*\n)*)*- \[ \] Two/), /## Done\n\n(?:- \[[ x]\] .*\n(?: {2}.*\n)*)*- \[ \] Two/);
    });

    await step('board: the check, the card menu, and a delete that asks first', async () => {
        await page.getByRole('button', { name: 'Mark done: One' }).click();
        await page.locator('.board .card.done', { hasText: 'One' }).waitFor();
        await page.locator('.board .card', { hasText: 'Old' }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        await alert.getByText('Delete the card “Old”?').waitFor();
        await alert.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(await page.locator('.board .card', { hasText: 'Old' }).count(), 1, 'Cancel keeps it');
        await page.locator('.board .card', { hasText: 'Old' }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        await alert.getByRole('button', { name: 'Delete' }).click();
        await page.locator('.board .card', { hasText: 'Old' }).waitFor({ state: 'detached' });
    });

    await step('board: a list is added, renamed, and deleted', async () => {
        await page.getByRole('button', { name: 'Add list' }).click();
        await page.getByLabel('New list name').fill('Later');
        await page.keyboard.press('Enter');
        await page.locator('.board .column[aria-label=Later]').waitFor();
        await page.getByRole('button', { name: 'List menu: Later' }).click();
        await page.getByRole('menuitem', { name: 'Rename…' }).click();
        await alert.getByLabel('List name').fill('Someday');
        await alert.getByRole('button', { name: 'OK' }).click();
        await page.locator('.board .column[aria-label=Someday]').waitFor();
        await page.getByRole('button', { name: 'List menu: Someday' }).click();
        await page.getByRole('menuitem', { name: 'Delete List…' }).click();
        await alert.getByRole('button', { name: 'Delete' }).click();
        await page.locator('.board .column[aria-label=Someday]').waitFor({ state: 'detached' });
    });

    await step('Fields…: a field with colored options is added, and a card\'s chip changes it from a popover', async () => {
        await page.getByRole('button', { name: 'Main Menu' }).click();
        await page.getByRole('menuitem', { name: 'Fields…' }).click();
        await dialog.getByRole('button', { name: '+ Add field' }).click();
        await dialog.getByLabel('Field name').fill('prio');
        await dialog.getByLabel('Field type').selectOption('select');
        await dialog.getByLabel('Add an option').fill('high');
        await dialog.getByLabel('Add an option').press('Enter');
        await dialog.getByLabel('Add an option').fill('low');
        await dialog.getByLabel('Add an option').press('Enter');
        await dialog.getByRole('button', { name: 'Color of this option' }).first().click();
        await dialog.getByRole('button', { name: 'red', exact: true }).click();
        await dialog.getByRole('button', { name: 'Save' }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.match(await saved('board.md', /fields:\n {2}prio: select\(high:red, low\)/), /fields:\n {2}prio: select\(high:red, low\)/);
        // The field is on the card dialog and set from there; the chip then opens the popover.
        await page.locator('.board .card', { hasText: 'One' }).click();
        await dialog.getByLabel('prio').selectOption('high');
        await dialog.getByRole('button', { name: 'Save' }).click();
        const chip = page.locator('.board .card', { hasText: 'One' }).locator('.chip.opt-red', { hasText: 'high' });
        await chip.waitFor();
        await chip.click();
        await page.locator('.field-popover').getByRole('button', { name: 'low' }).click();
        await page.locator('.board .card', { hasText: 'One' }).locator('.chip', { hasText: 'low' }).waitFor();
        assert.match(await saved('board.md', /One \[prio:: low\]/), /One \[prio:: low\]/);
    });

    // ---------- List ----------

    await step('list: a note is captured from the line, with the capture time of its field', async () => {
        await open('list.md');
        await page.locator('[data-page=inbox]').waitFor();
        await page.locator('.inbox-page').getByText('Things to sort.').waitFor();
        await page.getByLabel('Quick capture to the inbox').fill('Third idea #new');
        await page.keyboard.press('Enter');
        await page.locator('.inbox-row', { hasText: 'Third idea' }).waitFor();
        await page.locator('.inbox-row', { hasText: 'Third idea' }).getByText('just now').waitFor();
        assert.match(await saved('list.md', /- Third idea #new \[created:: \d{4}-\d\d-\d\d \d\d:\d\d\]\n- First idea/), /- Third idea #new \[created:: \d{4}-\d\d-\d\d \d\d:\d\d\]\n- First idea/);
    });

    await step('list: a note is edited in its dialog and moved into a new section from its menu', async () => {
        await page.locator('.inbox-row', { hasText: 'Second' }).click();
        await dialog.getByLabel('Title').fill('Second, edited');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await page.locator('.inbox-row', { hasText: 'Second, edited' }).waitFor();
        await page.locator('.inbox-row', { hasText: 'Second, edited' }).click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Move to' }).click();
        await page.getByRole('menuitem', { name: 'New section…' }).click();
        await alert.getByLabel('Section name').fill('Later');
        await alert.getByRole('button', { name: 'OK' }).click();
        await page.locator('.inbox-section', { hasText: 'Later' }).waitFor();
        assert.match(await saved('list.md', /## Later\n\n- Second, edited/), /## Later\n\n- Second, edited/);
    });

    await step('list: a note is dragged to another place', async () => {
        const first = page.locator('.inbox-row', { hasText: 'First idea' });
        const third = page.locator('.inbox-row', { hasText: 'Third idea' });
        await first.dragTo(third, { targetPosition: { x: 40, y: 3 } });
        const text = await saved('list.md', /First idea[\s\S]*Third idea/);
        assert.ok(text.indexOf('First idea') < text.indexOf('Third idea'), 'First idea is now above Third idea');
    });

    // ---------- Table ----------

    await step('table: a header sorts, and a cell changes its field from a popover', async () => {
        await open('table.md');
        await page.locator('[data-page=table]').waitFor();
        const titles = () => page.locator('.notes-table tbody .title-cell').allTextContents();
        assert.deepEqual(await titles(), ['Bravo', 'Alpha']);
        await page.getByRole('button', { name: 'Title' }).click();
        await page.waitForFunction(() => document.querySelector('.notes-table tbody .title-cell').textContent === 'Alpha');
        await page.getByRole('button', { name: /^Title/ }).click();
        assert.deepEqual(await titles(), ['Bravo', 'Alpha'], 'descending');
        await page.getByRole('button', { name: /^Title/ }).click();
        await page.locator('.notes-table tbody tr', { hasText: 'Bravo' }).locator('td[data-field=status]').click();
        await page.locator('.field-popover').getByRole('button', { name: 'doing' }).click();
        await page.locator('.notes-table tbody tr', { hasText: 'Bravo' }).locator('.chip', { hasText: 'doing' }).waitFor();
        assert.match(await saved('table.md', /Bravo \[status:: doing\]/), /Bravo \[status:: doing\]/);
    });

    await step('table: a row is added from the capture line and deleted after asking', async () => {
        await page.getByLabel('Quick capture to the table').fill('Charlie');
        await page.keyboard.press('Enter');
        await page.locator('.notes-table .title-cell', { hasText: 'Charlie' }).waitFor();
        assert.match(await saved('table.md', /- Charlie \[status:: todo\]/), /- Charlie \[status:: todo\]/);
        await page.getByRole('button', { name: 'Delete row: Charlie' }).click();
        await alert.getByRole('button', { name: 'Delete' }).click();
        await page.locator('.notes-table .title-cell', { hasText: 'Charlie' }).waitFor({ state: 'detached' });
    });

    // ---------- Calendar, timeline, gallery, chart ----------

    await step('calendar: a note is dragged to a day and takes that date; the empty part of a day adds a note', async () => {
        await open('cal.md');
        await page.locator('[data-page=calendar]').waitFor();
        await page.locator(`.calendar-day[data-date="${month}-10"]`).getByText('Release').waitFor();
        await page.locator('.calendar-undated').getByText('Undated').dragTo(page.locator(`.calendar-day[data-date="${month}-15"]`));
        await page.locator(`.calendar-day[data-date="${month}-15"]`).getByText('Undated').waitFor();
        const undated = new RegExp(`Undated \\[due:: ${month}-15\\]`);
        assert.match(await saved('cal.md', undated), undated);
        await page.locator(`.calendar-day[data-date="${month}-16"]`).dblclick({ position: { x: 20, y: 60 } });
        await dialog.getByLabel('Title').fill('Planning');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await page.locator(`.calendar-day[data-date="${month}-16"]`).getByText('Planning').waitFor();
        await page.getByRole('button', { name: 'Agenda' }).click();
        await page.locator('.agenda').getByText('Planning').waitFor();
        await page.getByRole('button', { name: 'Week' }).click();
        await page.locator('.calendar-grid').waitFor();
    });

    await step('timeline: a bar is dragged to move both dates, and an edge to change one', async () => {
        await open('line.md');
        await page.locator('[data-page=timeline]').waitFor();
        const bar = page.locator('.timeline-bar');
        await bar.waitFor();
        const title = bar.locator('.bar-title');
        // The timeline opens scrolled to today; the bar may start outside the window (a narrower window on macOS and Windows).
        await title.scrollIntoViewIfNeeded();
        let box = await title.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 4 });
        await page.mouse.move(box.x + box.width / 2 + 41, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        assert.match(await saved('line.md', /\[start:: 2026-10-07\] \[due:: 2026-10-11\]/), /\[start:: 2026-10-07\] \[due:: 2026-10-11\]/);
        const handle = bar.locator('.handle.end');
        await handle.scrollIntoViewIfNeeded();
        box = await handle.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 41, box.y + box.height / 2, { steps: 6 });
        await page.mouse.up();
        assert.match(await saved('line.md', /\[start:: 2026-10-07\] \[due:: 2026-10-13\]/), /\[start:: 2026-10-07\] \[due:: 2026-10-13\]/);
    });

    await step('timeline: a click on a bar edits the note', async () => {
        await page.locator('.timeline-bar .bar-title').click();
        await dialog.getByLabel('Title').fill('Build it');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await page.locator('.timeline-label', { hasText: 'Build it' }).waitFor();
    });

    await step('gallery: a search hides the cards that do not match, and a size changes their width', async () => {
        await open('gallery.md');
        await page.locator('[data-page=gallery]').waitFor();
        assert.equal(await page.locator('.gallery-card').count(), 2);
        await page.getByLabel('Search the notes of the gallery').fill('forest');
        await page.waitForFunction(() => document.querySelectorAll('.gallery-card').length === 1);
        await page.getByLabel('Search the notes of the gallery').fill('');
        const width = () => page.locator('.gallery-card').first().evaluate(el => el.getBoundingClientRect().width);
        const medium = await width();
        await page.getByRole('button', { name: 'Large' }).click();
        assert.ok(await width() > medium, 'large is wider than medium');
        await page.getByRole('button', { name: 'Delete note: Sunset' }).click();
        await alert.getByRole('button', { name: 'Delete' }).click();
        await page.waitForFunction(() => document.querySelectorAll('.gallery-card').length === 1);
    });

    await step('chart: numbers and a donut over the notes, and the panels are edited from the settings', async () => {
        await open('chart.md');
        await page.locator('[data-page=chart]').waitFor();
        await page.locator('.chart-kpi', { hasText: 'Notes' }).getByText('3').waitFor();
        await page.locator('.donut svg[aria-label*="done: 2"]').waitFor();
        await page.getByRole('button', { name: 'Edit the panels' }).click();
        await page.getByRole('button', { name: 'Remove' }).last().click();
        assert.match(await saved('chart.md', /charts: \[kpi, bar, donut\]/), /charts: \[kpi, bar, donut\]/);
        await page.getByRole('button', { name: 'Reset to default' }).click();
        assert.doesNotMatch(await saved('chart.md', /^(?![\s\S]*charts:)/), /charts:/);
    });

    // ---------- Layout menu ----------

    await step('the layout menu shows the same notes as another layout, and Text shows the Markdown', async () => {
        await open('table.md');
        await page.locator('[data-page=table]').waitFor();
        await page.locator('.headerbar button[aria-label=Layout]').click();
        await page.locator('.layout-menu [role=menuitem].checked', { hasText: 'Table' }).waitFor();
        await page.getByRole('menuitem', { name: 'Board' }).click();
        await page.locator('[data-page=board]').waitFor();
        assert.match(await saved('table.md', /layout: board/), /layout: board/);
        await page.locator('.headerbar button[aria-label=Layout]').click();
        await page.getByRole('menuitem', { name: 'Text' }).click();
        await page.locator('.cm-content').getByText('layout: board').waitFor();
    });

    await step('New → New Inbox opens a list with the cursor in its capture line', async () => {
        await page.getByRole('button', { name: 'More ways to create' }).click();
        await page.getByRole('menuitem', { name: 'New Inbox' }).click();
        await page.locator('[data-page=inbox]').waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Quick capture to the inbox');
        await page.keyboard.type('typed at once');
        await page.keyboard.press('Enter');
        await page.locator('.inbox-row', { hasText: 'typed at once' }).waitFor();
    });

    // ---------- CSV ----------

    await step('csv: a CSV file is a grid; a cell is written when it loses the focus, and Enter on the last row adds one', async () => {
        await open('sheet.csv');
        await page.locator('[data-page=csv]').waitFor();
        await page.locator('.statusbar').getByText('2 rows · 2 columns').waitFor();
        const cell = (r, c) => page.locator(`[data-cell="${r}:${c}"]`);
        await cell(1, 0).fill('ada lovelace');
        await cell(1, 0).press('Enter');
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-cell') === '2:0');
        await cell(2, 1).fill('55');
        await cell(2, 1).press('Enter');   // the last row: Enter adds one and keeps the column
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-cell') === '3:1');
        await cell(3, 0).fill('mo');
        await cell(3, 1).fill('9');
        await cell(3, 1).press('Enter');
        await page.locator('.statusbar').getByText('4 rows · 2 columns').waitFor({ timeout: 8000 });
        const expected = /^name,qty\nada lovelace,3\nlin,55\nmo,9\n/;
        const text = await saved('sheet.csv', expected);
        assert.match(text, expected);
    });

    await step('csv: rows and columns are added and removed from the menus, and Escape puts the old value back', async () => {
        await page.getByRole('button', { name: 'Add Column' }).click();
        await page.locator('[data-cell="0:2"]').waitFor();
        await page.locator('[data-cell="1:0"]').click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Delete Column' }).click();
        await page.waitForFunction(() => !document.querySelector('[data-cell="0:2"]'));
        await page.locator('[data-cell="1:0"]').fill('changed');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[data-cell="1:0"]').inputValue(), '3', 'the first column is now qty (name was deleted), and Escape restored it');
        const expected = /^qty,Column 3\n3,\n55,\n9,\n/;
        const text = await saved('sheet.csv', expected);
        assert.match(text, expected);
    });

    await step('csv: the search bar marks the cells that match and replaces them', async () => {
        await page.locator('[data-cell="1:0"]').click();
        await page.keyboard.press('ControlOrMeta+h');
        await page.getByLabel('Find in the table').fill('5');
        await page.locator('.csv-cell.current-match').waitFor();
        await page.getByLabel('Replace in the table').fill('7');
        await page.getByRole('button', { name: 'Replace All', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-cell="2:0"]')?.value === '77');
        assert.match(await saved('sheet.csv', /^qty,Column 3\n3,\n77,\n9,\n/), /^qty,Column 3\n3,\n77,\n9,\n/);
        await page.getByLabel('Find in the table').press('Escape');
        await page.locator('.csv-find').waitFor({ state: 'detached' });
    });
} catch {
    failed = true;
} finally {
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    try { app.process().kill(); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
}

console.log('Electron structured views');
console.log(steps.join('\n'));
process.exit(failed ? 1 : 0);
