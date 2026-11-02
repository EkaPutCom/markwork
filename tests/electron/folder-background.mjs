// A real window closes while a real daemon owns fake pi. No real pi or model is invoked.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { scratchFolder, launchApp, waitFor, repo, testModule } from './support.mjs';
import { seedFolderAgent } from './folderpi.mjs';
if (process.platform !== 'linux') { console.log('Pi folder background: Linux only'); process.exit(0); }
try { execFileSync('go', ['version'], { stdio: 'ignore' }); } catch { console.log('Pi folder background: skipped (Go unavailable)'); process.exit(0); }
const { scratch, notes } = scratchFolder('folder-background');
const seed = seedFolderAgent({ scratch, notes });
const bin = join(scratch, 'bin'); mkdirSync(bin);
const daemonBin = join(scratch, 'daemon'), socket = join(scratch, 'daemon.sock'), config = join(scratch, 'daemon.json');
execFileSync('go', ['build', '-o', daemonBin, './cmd/markworkd'], { cwd: join(repo, 'markworkd'), stdio: 'pipe' });
const pi = join(bin, 'pi');
writeFileSync(pi, `#!/bin/sh\nexec '${process.execPath}' '${join(repo, 'tests/electron/folder-pi-daemon-fixture.mjs')}' "$@"\n`, { mode: 0o755 });
writeFileSync(config, JSON.stringify({ roots: [notes, seed.runtime], programs: { pi }, default_idle_ttl_sec: 0 }));
writeFileSync(join(bin, 'markworkd'), `#!/bin/sh\nexec '${daemonBin}' "$@" --socket '${socket}' --config '${config}' --state-dir '${join(scratch, 'state')}'\n`, { mode: 0o755 });
const daemon = spawn(daemonBin, ['serve', '--socket', socket, '--config', config, '--state-dir', join(scratch, 'state')], { stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostics = ''; daemon.stderr.on('data', data => { diagnostics += data; });
const env = { PATH: bin + ':' + process.env.PATH, MARKWORK_TEST_PI: testModule('folderpi.mjs') };
let app;
const errors = [];
const open = async () => {
    app = await launchApp({ scratch, notes, env });
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('button', { name: 'Activate pi agent', exact: true }).waitFor();
    return page;
};
try {
    await waitFor(() => existsSync(socket), 10000, () => diagnostics);
    let page = await open();
    await page.getByRole('button', { name: 'Activate pi agent', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Activate pi agent', exact: true }).click();
    await page.getByRole('button', { name: 'Use background pi', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Change execution', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('finish after the window closes');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await waitFor(() => existsSync(join(notes, 'workspace', 'submitted')), 15000);
    const shotDir = process.env.MARKWORK_PHASE2_SHOTS || join(scratch, 'screenshots'); mkdirSync(shotDir, { recursive: true });
    for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.screenshot({ animations: 'disabled', path: join(shotDir, `background-${theme}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 800));
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.getByRole('complementary', { name: 'Agent sessions', exact: true }).waitFor();
    await page.screenshot({ animations: 'disabled', path: join(shotDir, 'background-narrow.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    const closing = page.waitForEvent('close');
    await page.getByRole('button', { name: 'Keep Them Going', exact: true }).click();
    await closing;
    await app.close(); app = null;
    writeFileSync(join(notes, 'workspace', 'continue'), 'go');
    await waitFor(() => existsSync(join(notes, 'workspace', 'report.md')), 10000, () => diagnostics);
    page = await open();
    await page.getByText('Background report completed.', { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(readFileSync(join(notes, 'workspace', 'submitted'), 'utf8'), 'finish after the window closes\n');
    await waitFor(() => !JSON.parse(readFileSync(join(seed.runtime, 'index.json'), 'utf8')).chats[0].run, 15000);
    await page.getByRole('button', { name: 'Activate pi agent', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Activate pi agent', exact: true }).click();
    unlinkSync(join(notes, 'workspace', 'continue'));
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('stop this original run explicitly');
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await waitFor(() => readFileSync(join(notes, 'workspace', 'submitted'), 'utf8').includes('stop this original run explicitly'), 15000);
    await page.getByRole('button', { name: 'Stop original run', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop original run', exact: true }).click();
    await page.getByRole('button', { name: 'Restore native session', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore native session', exact: true }).click();
    await waitFor(() => { const binding = JSON.parse(readFileSync(join(seed.runtime, 'index.json'), 'utf8')).chats[0]; return !binding.run && binding.status === 'idle'; }, 15000);
    assert.equal(readFileSync(join(notes, 'workspace', 'submitted'), 'utf8'), 'finish after the window closes\nstop this original run explicitly\n');
    assert.deepEqual(errors, []);
    console.log('Pi folder background: actual window close, detached tool completion, exact native reattach, no duplicate prompt; screenshots ' + shotDir);
} finally {
    if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    const run = JSON.parse(readFileSync(join(seed.runtime, 'index.json'), 'utf8')).chats[0].run?.id;
    if (run) await new Promise(resolve => {
        const stream = connect(socket), timer = setTimeout(() => { stream.destroy(); resolve(); }, 3000);
        stream.on('error', () => { clearTimeout(timer); resolve(); });
        stream.on('connect', () => stream.write(JSON.stringify({ id: 'cleanup-hello', op: 'hello', proto: 1, client: 'cleanup' }) + '\n' + JSON.stringify({ id: 'cleanup-stop', op: 'stop', run, grace_ms: 0 }) + '\n'));
        stream.on('data', data => { if (data.toString().includes('cleanup-stop')) { clearTimeout(timer); stream.destroy(); resolve(); } });
    });
    daemon.kill('SIGTERM');
    await new Promise(resolve => { if (daemon.exitCode !== null) resolve(); else { daemon.once('exit', resolve); setTimeout(() => { daemon.kill('SIGKILL'); resolve(); }, 5000).unref(); } });
}
