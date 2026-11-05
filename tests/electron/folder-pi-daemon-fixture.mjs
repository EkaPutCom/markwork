// Deterministic executable pi substitute. No credentials, providers, or network are accessed.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.4.0'); process.exit(0); }
if (args[0] === 'auth') { appendFileSync('auth-args', JSON.stringify(args) + '\n'); console.log(JSON.stringify({ status: existsSync('deny-auth') ? 'not_ready' : 'ready', provider: 'fixture' })); process.exit(0); }
const arg = name => args[args.indexOf(name) + 1];
const directory = arg('--session-dir');
mkdirSync(directory, { recursive: true });
const file = args.includes('--session') ? arg('--session') : join(directory, arg('--session-id') + '.jsonl');
const id = basename(file, '.jsonl');
let messages = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
writeFileSync(file, JSON.stringify(messages));
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const reply = (command, data = {}) => send({ type: 'response', id: command.id, command: command.type, success: true, data });
const model = { provider: existsSync('invalid-provider') ? '--credentials' : 'fixture', id: 'model', contextWindow: 32000 };
let timer = null;
createInterface({ input: process.stdin }).on('line', line => {
    const c = JSON.parse(line);
    if (c.type === 'get_state') reply(c, { sessionId: id, sessionFile: file, model, thinkingLevel: 'off', isStreaming: !!timer });
    else if (c.type === 'get_available_models') reply(c, { models: [model] });
    else if (c.type === 'get_messages') reply(c, { messages });
    else if (c.type === 'prompt') {
        messages.push({ role: 'user', content: c.message }); writeFileSync(file, JSON.stringify(messages));
        // Tests may kill the process as soon as submission is observed; publish only after the native snapshot is written.
        appendFileSync('submitted', c.message + '\n');
        reply(c, { disposition: 'started' });
        if (c.message.startsWith('burst')) for (let i = 0; i < 1000; i++) send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
        send({ type: 'tool_execution_start', toolCallId: 'write-report', toolName: 'bash', args: { command: 'wait for gate; write report' } });
        timer = setInterval(() => {
            if (!existsSync('continue')) return;
            clearInterval(timer); timer = null;
            writeFileSync('report.md', '# Completed while the window was closed\n');
            messages.push({ role: 'assistant', content: 'Background report completed.' }); writeFileSync(file, JSON.stringify(messages));
            send({ type: 'tool_execution_end', toolCallId: 'write-report', toolName: 'bash', result: { content: [{ type: 'text', text: 'Saved report.md' }] } });
            send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Background report completed.' } });
            send({ type: 'agent_end' }); send({ type: 'agent_settled' });
        }, 20);
    } else if (c.type === 'abort') {
        clearInterval(timer); timer = null; send({ type: 'agent_settled', aborted: true }); reply(c);
    } else reply(c);
}).on('close', () => process.exit(0));
