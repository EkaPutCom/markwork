// Real daemon + packaged headless worker, with a fake model. Disconnecting never approves a proposal.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitFor, repo } from './support.mjs';
if (process.platform !== 'linux') { console.log('Agent worker daemon test: Linux only'); process.exit(0); }
try { execFileSync('go', ['version'], { stdio: 'ignore' }); } catch { console.log('Agent worker daemon test: skipped (Go unavailable)'); process.exit(0); }
const scratch = mkdtempSync(join(tmpdir(), 'markwork-folder-worker-'));
const root = join(scratch, 'agent'), chats = join(root, 'chats');
mkdirSync(chats, { recursive: true });
writeFileSync(join(root, 'agent.json'), JSON.stringify({ version: 1, name: 'Background test', instructions: 'instructions.md' }));
writeFileSync(join(root, 'instructions.md'), 'Use only these references and propose every change.');
writeFileSync(join(root, 'plan.md'), '# Plan\n\nShip 15 November\n');
writeFileSync(join(chats, 'worker.md'), '---\nlayout: chat\ntitle: "Background test"\nmodel: deepseek-flash\ncreated: 2026-10-31\n---\n\n');
const daemonBin = join(scratch, 'markworkd'), launcher = join(scratch, 'markwork-agent');
execFileSync('go', ['build', '-o', daemonBin, './cmd/markworkd'], { cwd: join(repo, 'markworkd'), stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/agent-worker-launcher.mjs', launcher], { cwd: repo, stdio: 'pipe' });
const socket = join(scratch, 'daemon.sock'), config = join(scratch, 'config.json');
writeFileSync(config, JSON.stringify({ roots: [root], programs: { 'markwork-agent': launcher }, default_idle_ttl_sec: 0 }));
const daemon = spawn(daemonBin, ['serve', '--socket', socket, '--state-dir', join(scratch, 'state'), '--config', config], {
    env: { ...process.env, DEEPSEEK_API_KEY: 'test', MARKWORK_TEST_MODEL: pathToFileURL(join(repo, 'tests/electron/model.mjs')).href }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = ''; daemon.stderr.on('data', data => { stderr += data; });
const connections = [];
async function client() {
    const stream = connect(socket); connections.push(stream);
    await new Promise((resolveReady, reject) => { stream.once('connect', resolveReady); stream.once('error', reject); });
    const waiting = new Map(), events = []; let sequence = 0, buffer = '';
    stream.on('data', data => {
        buffer += data;
        for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
            const message = JSON.parse(line);
            if (message.re) { const pending = waiting.get(message.re); if (pending) { waiting.delete(message.re); clearTimeout(pending.timer); message.ok ? pending.resolve(message) : pending.reject(Error(JSON.stringify(message))); } }
            else events.push(message);
        }
    });
    const call = (op, args = {}) => new Promise((resolveReply, reject) => {
        const id = 'test-' + ++sequence, timer = setTimeout(() => { waiting.delete(id); reject(Error('Timed out: ' + op)); }, 15000);
        waiting.set(id, { resolve: resolveReply, reject, timer }); stream.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
    await call('hello', { proto: 1, client: 'markwork-agent-worker-test' });
    return { stream, call, events };
}
const outputs = c => c.events.filter(e => e.ev === 'record' && e.kind === 'out').map(e => { try { return JSON.parse(e.line); } catch { return null; } }).filter(Boolean);
try {
    await waitFor(() => existsSync(socket), 10000, () => stderr);
    const first = await client();
    const command = JSON.stringify({ id: 'send-once', op: 'send', text: 'bump the date', model: 'deepseek-flash' });
    await first.call('spawn', { run: 'folder-worker', program: 'markwork-agent', args: ['worker.md'], cwd: root, initial_input: [command], labels: { kind: 'folder-agent', session: join(chats, 'worker.md'), root }, idle_ttl_sec: 0 });
    await first.call('subscribe', { run: 'folder-worker', from_seq: 1 });
    await waitFor(() => outputs(first).some(e => e.event === 'proposal'), 15000, () => JSON.stringify(first.events.slice(-5)) + stderr);
    const ask = outputs(first).find(e => e.event === 'proposal').data.ask;
    first.stream.destroy();
    assert.match(readFileSync(join(root, 'plan.md'), 'utf8'), /15 November/);
    const next = await client();
    await next.call('subscribe', { run: 'folder-worker', from_seq: 1 });
    await waitFor(() => outputs(next).some(e => e.event === 'proposal'), 10000);
    assert.equal(outputs(next).find(e => e.event === 'proposal').data.ask, ask);
    await next.call('write', { run: 'folder-worker', line: command });
    writeFileSync(join(root, 'plan.md'), '# Plan\n\nShip 22 November\n');
    await next.call('write', { run: 'folder-worker', line: JSON.stringify({ id: 'approve-once', op: 'decision', ask, result: { applied: true } }) });
    await waitFor(() => outputs(next).some(e => e.event === 'done'), 15000, () => JSON.stringify(next.events.slice(-5)) + stderr);
    await waitFor(async () => (await next.call('get', { run: 'folder-worker' })).state === 'exited', 10000);
    const receipts = JSON.parse(readFileSync(join(chats, 'worker.md.worker.json'), 'utf8'));
    assert.equal(receipts.filter(id => id === 'send-once').length, 1);
    assert.match(readFileSync(join(chats, 'worker.md'), 'utf8'), /Proposal answered/);
    console.log('Agent worker: real markworkd, disconnect/replay, pending approval, duplicate command, approved continuation passed');
} finally {
    try { const cleanup = await client(); await cleanup.call('stop', { run: 'folder-worker', grace_ms: 0 }); } catch {}
    for (const stream of connections) stream.destroy();
    daemon.kill('SIGTERM');
    await new Promise(resolveExit => { if (daemon.exitCode !== null) resolveExit(); else { daemon.once('exit', resolveExit); setTimeout(() => { daemon.kill('SIGKILL'); resolveExit(); }, 5000).unref(); } });
    rmSync(scratch, { recursive: true, force: true });
}
