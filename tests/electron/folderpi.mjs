// Fake pi runtime and new-format fixtures, used only through MARKWORK_TEST_PI. Never calls a provider.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

export function seedFolderAgent({ scratch, notes, title = 'New chat', messages = [] }) {
    const agentId = randomUUID(), chatId = randomUUID();
    mkdirSync(join(notes, 'workspace'), { recursive: true });
    mkdirSync(join(notes, 'chats'), { recursive: true });
    writeFileSync(join(notes, 'agent.json'), JSON.stringify({ version: 2, id: agentId, runtime: 'pi', name: 'Research Assistant', instructions: 'instructions.md' }));
    writeFileSync(join(notes, 'instructions.md'), 'Cite sources. Work in workspace/.');
    const runtime = join(scratch, 'data', 'markwork', 'folder-agents', agentId), native = join(runtime, 'sessions', chatId + '.jsonl');
    mkdirSync(dirname(native), { recursive: true });
    const projection = '---\nlayout: chat\ntitle: ' + JSON.stringify(title) + '\nmodel: fake/test\ncreated: 2026-11-01\n---\n\n' + messages.map(message => `## ${message.role === 'user' ? 'You' : 'Assistant'}\n${typeof message.content === 'string' ? message.content : message.content.map(block => block.text || '').join('')}\n`).join('\n') + '\n';
    const path = join(notes, 'chats', chatId + '.md');
    writeFileSync(path, projection); writeFileSync(join(notes, 'chats', '.gitignore'), '*\n');
    writeFileSync(native, JSON.stringify(messages));
    writeFileSync(join(runtime, 'index.json'), JSON.stringify({ version: 1, root: notes, chats: [{ id: chatId, title, created: '2026-11-01', native, status: 'idle', projectionHash: createHash('sha256').update(projection).digest('hex') }] }));
    return { agentId, chatId, path, native, runtime };
}

export function createRuntime(PiRpc, _platform) {
    return { discover: async () => 'fake-pi', connect(argv, cwd) {
        const arg = name => argv[argv.indexOf(name) + 1];
        const native = argv.includes('--session') ? arg('--session') : join(arg('--session-dir'), arg('--session-id') + '.jsonl');
        const id = basename(native).replace('.jsonl', '');
        mkdirSync(dirname(native), { recursive: true });
        let messages = existsSync(native) ? JSON.parse(readFileSync(native, 'utf8')) : [];
        let ended = false, running = false, release = null, streamed = '';
        const spawn = (_argv, _cwd, handlers) => {
            const send = record => { if (!ended) handlers.line(JSON.stringify(record)); };
            const save = () => writeFileSync(native, JSON.stringify(messages));
            const delta = text => { streamed += text; send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }); };
            const complete = text => {
                if (!running) return;
                delta(text); messages.push({ role: 'assistant', content: [{ type: 'text', text: streamed }], stopReason: 'stop' }); save();
                send({ type: 'message_end', message: messages.at(-1) }); running = false;
                send({ type: 'agent_end' }); send({ type: 'agent_settled', aborted: false });
            };
            const prompt = text => {
                const task = text.split('\n')[0];
                running = true; streamed = ''; messages.push({ role: 'user', content: text }); save(); send({ type: 'agent_start' });
                if (task === 'slow') { delta('Working on a slow task.'); return; }
                if (text === 'Continue the research' && process.env.MARKWORK_TEST_PI_GATE) {
                    const partial = 'Stream checkpoint\n\n' + process.env.MARKWORK_TEST_PI_ANSWER;
                    delta(partial);
                    const deadline = Date.now() + 20000;
                    release = setInterval(() => {
                        if (Date.now() > deadline) { clearInterval(release); send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Layout stream gate was not released' } }); running = false; send({ type: 'agent_settled' }); }
                        else if (existsSync(process.env.MARKWORK_TEST_PI_GATE)) { clearInterval(release); complete('\n\nFinal streamed paragraph.'); }
                    }, 20);
                    return;
                }
                if (text === 'research table') {
                    send({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'research', args: { command: 'python3 research.py' } });
                    const output = join(cwd, 'output', 'research'); mkdirSync(output, { recursive: true });
                    const report = '## Research findings\n\n| CVE | Risk | Score | Source |\n| :--- | :---: | ---: | --- |\n| **CVE-2026-0001** | High | `9.8` | https://example.com/advisory |\n| CVE-2026-0002 | Investigating | — | Awaiting verification |\n\n3. Verify the source.\n4. Review the affected versions.\n\n- [x] Save the report\n- [ ] Verify deployment\n';
                    writeFileSync(join(output, 'cve-report.md'), report);
                    send({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'research', result: { content: [{ type: 'text', text: 'Created output/research/cve-report.md' }] }, isError: false });
                    complete(report); return;
                }
                if (task === 'write report') {
                    send({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'write', args: { command: 'write report.md' } });
                    writeFileSync(join(cwd, 'report.md'), '# Research report\n\nhttps://example.com\n\nRevision ' + messages.filter(message => message.role === 'user' && String(message.content).startsWith('write report')).length + '\n');
                    send({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'write', result: { content: [{ type: 'text', text: 'Wrote report.md' }] }, isError: false });
                }
                complete('Echo: ' + text);
            };
            return {
                write(line) {
                    if (ended) return false;
                    const command = JSON.parse(line), response = data => send({ type: 'response', id: command.id, success: true, data: data || {} });
                    switch (command.type) {
                        case 'get_state': response({ sessionId: id, sessionFile: native, model: { provider: 'fake', id: 'test', contextWindow: 64000 }, thinkingLevel: 'off', isStreaming: running }); break;
                        case 'get_available_models': response({ models: [{ provider: 'fake', id: 'test' }] }); break;
                        case 'get_messages': response({ messages }); break;
                        case 'prompt': response({ disposition: 'started' }); prompt(command.message); break;
                        case 'abort': if (release) clearInterval(release); running = false; send({ type: 'agent_settled', aborted: true }); response(); break;
                        default: response();
                    }
                    return true;
                },
                closeInput() { if (!ended) { ended = true; if (release) clearInterval(release); handlers.exit(0, ''); } },
                stop() { if (!ended) { ended = true; if (release) clearInterval(release); handlers.exit(143, ''); } },
            };
        };
        return new PiRpc(argv, cwd, spawn);
    } };
}
