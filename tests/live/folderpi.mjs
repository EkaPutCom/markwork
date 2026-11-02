// Explicitly activated in-app smoke test. Uses real pi credentials, network and quota; never part of npm test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { launchApp, scratchFolder, waitFor } from '../electron/support.mjs';

if (!process.argv.includes('--activate')) throw Error('Live, unsandboxed smoke test requires --activate (real credentials and quota).');
const { scratch, notes } = scratchFolder('folderpi-live');
const id = randomUUID();
mkdirSync(join(notes, 'workspace'));
writeFileSync(join(notes, 'agent.json'), JSON.stringify({ version: 2, id, runtime: 'pi', name: 'Live pi research', instructions: 'instructions.md' }));
writeFileSync(join(notes, 'instructions.md'), '# Research agent\nUse tools, cite sources and persist concise facts in workspace/memory.md.');
const app = await launchApp({ scratch, notes, settings: { welcomed: true }, env: { MARKWORK_TEST_PI: '', MARKWORK_TEST_MODEL: '' } });
let failed = false, page;
const errors = [], started = performance.now();
console.log('Live evidence directory: ' + scratch);
try {
    page = await app.firstWindow(); page.setDefaultTimeout(180000);
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setViewportSize({ width: 1400, height: 900 });
    const chat = page.getByRole('complementary', { name: 'Agent conversation', exact: true });
    await chat.waitFor();
    await page.getByRole('button', { name: 'Activate pi agent', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Activate pi agent?', exact: true }).getByRole('button', { name: 'Activate pi agent', exact: true }).click();
    const input = chat.getByRole('textbox', { name: 'Message' });
    await input.waitFor({ timeout: 20000 });
    await input.fill('In this disposable workspace, use bash to print pwd and fetch https://example.com and https://www.iana.org/help/example-domains with curl --max-time 20. Use Python to analyze their titles and byte counts. Write a concise sourced Markdown report to report.md and a reusable fact to memory.md in the current working directory. Do not just describe these actions: execute them. End with RESEARCH_COMPLETE.');
    const turnStarted = performance.now(); await input.press('Enter');
    await chat.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    await chat.getByText(/RESEARCH_COMPLETE/).waitFor();
    await chat.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached' });
    const turnMs = performance.now() - turnStarted;
    assert.ok(existsSync(join(notes, 'workspace', 'report.md')));
    assert.ok(existsSync(join(notes, 'workspace', 'memory.md')));
    const report = readFileSync(join(notes, 'workspace', 'report.md'), 'utf8');
    assert.match(report, /https:\/\/example.com/); assert.match(report, /iana.org/);
    assert.deepEqual(errors, []);
    for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.screenshot({ path: join(scratch, 'live-' + theme + '.png'), animations: 'disabled' });
    }
    const runtime = join(scratch, 'data', 'markwork', 'folder-agents', id);
    const index = JSON.parse(readFileSync(join(runtime, 'index.json'), 'utf8'));
    const chatId = index.chats[0].id;
    const native = index.chats[0].native;
    assert.ok(native && existsSync(native));
    // Reopen the exact native session, with a new instruction revision and no synthetic transcript replay.
    writeFileSync(join(notes, 'instructions.md'), '# Research agent\nUse tools and cite sources. Append REVISION_TWO to the end of your next answer.');
    await input.fill('Read memory.md, then state one saved fact and its source.'); await input.press('Enter');
    await chat.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    await chat.getByText(/REVISION_TWO/).waitFor();
    await chat.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached' });
    const resumed = JSON.parse(readFileSync(join(runtime, 'index.json'), 'utf8')).chats.find(entry => entry.id === chatId);
    assert.equal(resumed.native, native); assert.ok(resumed.instructionRevision);
    await input.fill('Run bash command sleep 60 now, then write never.md. Do not skip the sleep.'); await input.press('Enter');
    await waitFor(() => readFileSync(native, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).some(entry =>
        entry.type === 'message' && entry.message?.role === 'assistant' && Array.isArray(entry.message.content) && entry.message.content.some(block => block.type === 'toolCall' && block.name === 'bash' && String(block.arguments?.command).includes('sleep 60'))), 90000);
    const stopStarted = performance.now(); await chat.getByRole('button', { name: 'Stop', exact: true }).click();
    await chat.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached' });
    const stopMs = performance.now() - stopStarted;
    assert.equal(existsSync(join(notes, 'workspace', 'never.md')), false);
    const messages = readFileSync(native, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message').map(entry => entry.message);
    const usage = messages.filter(message => message.role === 'assistant').reduce((total, message) => total + (message.usage?.totalTokens || 0), 0);
    const result = { scratch, id, chatId, native, turnMs, stopMs, totalMs: performance.now() - started, usage, revision: resumed.instructionRevision, errors, reportBytes: Buffer.byteLength(report) };
    writeFileSync(join(scratch, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} catch (error) { failed = true; console.error(error); if (page) console.error((await page.locator('body').innerText()).slice(-6000)); }
finally { await app.close(); }
process.exit(failed ? 1 : 0);
