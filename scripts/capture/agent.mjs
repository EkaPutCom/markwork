// The fake pi of the screenshots (scripts/capture.mjs): the core loads it when MARKWORK_TEST_HARNESS names this file, so no
// capture needs pi or a model. It speaks pi's RPC events. What it does is read from MARKWORK_CAPTURE_PI/mode when a prompt
// arrives: "slow" works until the file MARKWORK_CAPTURE_PI/release exists and then commits like "commit", "ask" ends its
// turn with a question, "commit" changes files in its folder (the card's worktree) and commits them, and anything else just
// finishes.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = () => process.env.MARKWORK_CAPTURE_PI ?? '';
const mode = () => { try { return readFileSync(join(dir(), 'mode'), 'utf8').trim(); } catch { return ''; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const assistant = (text, usage) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', ...usage ? { usage } : {} } });
const USAGE = { input: 5210, output: 640, totalTokens: 5850, cost: { total: 0.0042 } };

function commit(cwd) {
    const write = (rel, text) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), text); };
    const git = (...args) => execFileSync('git', ['-c', 'user.name=pi', '-c', 'user.email=pi@example.com', ...args], { cwd });
    write('src/checkout/qris.ts', "// QRIS payments at checkout.\nexport function qrisPayload(amount: number, merchant: string): string {\n    return `000201010212${merchant}54${String(amount).length}${amount}`;\n}\n");
    write('src/checkout/index.ts', "export { cartTotal } from './cart.js';\nexport { qrisPayload } from './qris.js';\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'Add QRIS payments at checkout');
    write('tests/qris.test.ts', "import { qrisPayload } from '../src/checkout/qris.js';\n\ntest('the payload names the amount', () => {\n    expect(qrisPayload(15000, 'ID1')).toContain('15000');\n});\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'Test the QRIS payload');
}

export function spawn(_argv, cwd, handlers) {
    const say = event => handlers.line(JSON.stringify(event));
    let turns = 0;
    async function work() {
        const m = mode();
        turns++;
        say({ type: 'turn_start' });
        say({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Look at the project structure first, then find the payment module.' } });
        say({ type: 'tool_execution_start', toolCallId: `t${turns}a`, toolName: 'bash', args: { command: 'ls src/checkout' } });
        await sleep(200);
        say({ type: 'tool_execution_end', toolCallId: `t${turns}a`, toolName: 'bash', result: { content: [{ type: 'text', text: 'cart.ts\npayment.ts\nindex.ts' }] }, isError: false });
        say({ type: 'tool_execution_start', toolCallId: `t${turns}b`, toolName: 'edit', args: { path: 'src/checkout/qris.ts' } });
        if (m === 'slow') while (!existsSync(join(dir(), 'release'))) await sleep(50);
        if (m === 'slow' || m === 'commit') commit(cwd);
        await sleep(200);
        say({ type: 'tool_execution_end', toolCallId: `t${turns}b`, toolName: 'edit', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
        if (m === 'ask' && turns === 1) {
            say(assistant('I have read the README.\n\nThe installation section uses both npm and pnpm. Shall I standardize it on pnpm only?'));
        } else {
            say(assistant('QRIS added in src/checkout/qris.ts with 3 tests', USAGE));
        }
        say({ type: 'agent_settled' });
    }
    return {
        write(line) {
            const message = JSON.parse(line);
            if (message.type === 'get_state') say({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: '7f3c2a91' } });
            else if (message.type === 'prompt') {
                say({ id: message.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
                void work();
            }
            return true;
        },
        closeInput() { setTimeout(() => handlers.exit(0, ''), 0); },
        stop() { setTimeout(() => handlers.exit(143, ''), 0); },
    };
}
