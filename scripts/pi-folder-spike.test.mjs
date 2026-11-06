import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { SpikeRpc } from './pi-folder-spike-rpc.mjs';

const fake = `
let buffer = '';
let deferred;
const send = record => process.stdout.write(JSON.stringify(record) + '\\r\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\\n')) >= 0) {
        const command = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const respond = data => send({ type: 'response', id: command.id, command: command.type, success: true, data });
        if (command.type === 'first') deferred = () => respond({ echoed: 'first' });
        else if (command.type === 'second') { respond({ echoed: 'second' }); deferred(); }
        else if (command.type === 'reject') send({ type: 'response', id: command.id, success: false, error: 'rejected' });
        else if (command.type === 'silent') continue;
        else if (command.type === 'malformed') process.stdout.write('not JSON\\n');
        else if (command.type === 'exit') process.exit(3);
        else if (command.type === 'flood') {
            for (let i = 0; i < 1000; i++) send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'sample 🌱' } });
            respond({});
        } else if (command.type === 'oversize') process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
        else if (command.type === 'unicode') {
            const line = Buffer.from(JSON.stringify({ type: 'response', id: command.id, success: true, data: 'a\\u2028b\\u2029🌱' }) + '\\n');
            for (const byte of line) process.stdout.write(Buffer.from([byte]));
        } else if (command.type === 'prompt') {
            send({ type: 'agent_start' });
            if (command.message === 'handled') respond({ disposition: 'handled' });
            else {
                if (command.message === 'fail') send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' } });
                send({ type: 'agent_end' });
                if (command.message !== 'hold') send({ type: 'agent_settled', aborted: false });
                respond({ disposition: 'started' });
            }
        } else if (command.type === 'settle') { send({ type: 'agent_settled', aborted: false }); respond({}); }
        else if (command.type === 'clear_queue') respond({ cleared: true });
        else if (command.type === 'abort') { send({ type: 'agent_settled', aborted: true }); respond({}); }
        else respond({ echoed: command.type });
    }
});
`;

async function withClient(run, options = {}) {
    const client = new SpikeRpc(process.execPath, ['-e', fake], options);
    try {
        await run(client);
    } finally {
        await client.close();
    }
}

test('manual spike refuses execution without explicit activation', () => {
    const result = spawnSync(
        process.execPath,
        ['scripts/pi-folder-spike.mjs'],
        { encoding: 'utf8' }
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /NOT a sandbox/);
    assert.equal(result.stdout, '');
});

test('correlates concurrent commands by unique IDs', () =>
    withClient(async (client) => {
        const results = await Promise.all([
            client.command('first'),
            client.command('second'),
        ]);
        assert.deepEqual(results, [{ echoed: 'first' }, { echoed: 'second' }]);
    }));

test('LF framing preserves Unicode separators and split UTF-8', () =>
    withClient(async (client) => {
        assert.equal(await client.command('unicode'), 'a\u2028b\u2029🌱');
    }));

test('subscribes before prompting, including' +
    ' completion before acknowledgement', () =>
    withClient(async (client) => {
        await client.prompt('fast');
        assert.equal(client.listeners.size, 0);
    }));

test('agent_end is not completion', () =>
    withClient(async (client) => {
        const ended = client.waitFor((event) => event.type === 'agent_end');
        let done = false;
        const turn = client.prompt('hold').then(() => {
            done = true;
        });
        await ended.promise;
        await client.command('barrier');
        assert.equal(done, false);
        await client.command('settle');
        await turn;
    }));

test('provider failure after acceptance is not success', () =>
    withClient(async (client) => {
        await assert.rejects(client.prompt('fail'), /provider failed/);
        assert.equal(client.listeners.size, 0);
    }));

test('handled prompt does not wait for a nonexistent run', () =>
    withClient(async (client) => {
        await assert.rejects(
            client.prompt('handled'),
            /Unexpected disposition/
        );
        assert.equal(client.listeners.size, 0);
    }));

test('Stop clears queued work before abort', () =>
    withClient(async (client) => {
        const commands = [];
        client.onEvent((event) => {
            if (event?.type === 'response') commands.push(event.command);
        });
        const settled = client.waitFor(
            (event) => event.type === 'agent_settled'
        );
        await client.stop();
        assert.equal((await settled.promise).aborted, true);
        assert.deepEqual(commands, ['clear_queue', 'abort']);
    }));

test('command rejection is reported', () =>
    withClient(async (client) => {
        await assert.rejects(client.command('reject'), /rejected/);
    }));

test('unknown command outcome times out without retry', () =>
    withClient(async (client) => {
        await client.command('ready');
        await assert.rejects(
            client.command('silent', {}, 25),
            /outcome unknown/
        );
        assert.equal(client.sequence, 2);
        assert.equal(client.pending.size, 0);
    }));

test('malformed stdout fails pending requests', () =>
    withClient(async (client) => {
        await assert.rejects(client.command('malformed'), SyntaxError);
    }));

test('unexpected exit fails pending commands', () =>
    withClient(async (client) => {
        await assert.rejects(client.command('exit'), /pi exited/);
    }));

test('missing executable fails promptly', async () => {
    const client = new SpikeRpc('/nonexistent/markwork-pi-phase0', []);
    try {
        await assert.rejects(client.command('get_state'), /ENOENT/);
    } finally {
        await client.close();
    }
});

test('oversized unterminated records fail' +
    ' instead of growing indefinitely', () =>
    withClient(async (client) => {
        await assert.rejects(client.command('oversize'), /exceeds 8 MiB/);
    }));

test('event deadlines release subscriptions', () =>
    withClient(async (client) => {
        const wait = client.waitFor(() => false, 25);
        await assert.rejects(wait.promise, /event deadline/);
        assert.equal(client.listeners.size, 0);
    }));

test('transport measurement: 20 batches of 1,000 events after 3 warmups', () =>
    withClient(async (client) => {
        const samples = [];
        let delivered = 0;
        const off = client.onEvent((event) => {
            if (event?.type === 'message_update') delivered++;
        });
        for (let i = 0; i < 23; i++) {
            const before = performance.now();
            await client.command('flood');
            if (i >= 3) samples.push(performance.now() - before);
        }
        off();
        assert.equal(delivered, 23_000);
        samples.sort((a, b) => a - b);
        console.log(
            `${"Spike JSONL" +
            " parse/delivery, 1000" +
            " events: median="}${samples[10].toFixed(3)}ms p95=${samples[18].toFixed(3)}ms max=${samples[19].toFixed(3)}ms`
        );
    }));
