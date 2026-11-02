// Deterministic pi protocol fixture: no provider, credential, network, or user workspace access.
import { platform, type ChildHandlers, type ChildProcess } from '../../src/platform/index';
import { PiRpc, type PiRecord } from '../../src/agent/pirpc';
import type { FolderPiRuntime } from '../../src/app/folderpi';

export function fakeFolderPi() {
    const launches: { argv: string[]; cwd: string }[] = [];
    const prompts: string[] = [];
    const sessions = new Map<string, PiRecord[]>();
    const active = new Set<string>();
    const instructions: string[] = [];
    const spawn = (argv: string[], cwd: string, handlers: ChildHandlers): ChildProcess => {
        launches.push({ argv, cwd });
        const value = (flag: string) => argv[argv.indexOf(flag) + 1];
        const native = argv.includes('--session') ? value('--session') : platform().paths.join(value('--session-dir'), value('--session-id') + '.jsonl');
        const id = platform().paths.basename(native).replace('.jsonl', '');
        platform().fs.makeDirs(platform().paths.dirname(native), 0o700);
        let messages = sessions.get(native);
        if (!messages) {
            try { messages = JSON.parse(platform().fs.readText(native)); } catch { messages = []; }
            sessions.set(native, messages!);
        }
        const send = (record: PiRecord) => handlers.line(JSON.stringify(record));
        const save = () => platform().fs.writeText(native, JSON.stringify(messages));
        let stopped = false;
        const complete = (text: string) => {
            messages!.push({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
            send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
            send({ type: 'message_end', message: messages!.at(-1) });
            save(); active.delete(id);
            send({ type: 'agent_end' }); send({ type: 'agent_settled', aborted: false });
        };
        const prompt = (text: string) => {
            prompts.push(text); active.add(id);
            messages!.push({ role: 'user', content: text }); save();
            instructions.push(platform().fs.readText(value('--append-system-prompt')));
            send({ type: 'agent_start' });
            if (text === 'slow') {
                send({ type: 'tool_execution_start', toolCallId: 'slow', toolName: 'bash', args: { command: 'sleep 60' } });
                return;
            }
            if (text === 'fail') {
                send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Fake provider unavailable' } });
                active.delete(id); send({ type: 'agent_settled' }); return;
            }
            if (text === 'write report') {
                send({ type: 'tool_execution_start', toolCallId: 'write', toolName: 'bash', args: { command: 'write report', api_key: 'hidden-fake-key' } });
                platform().fs.writeText(platform().paths.join(cwd, 'report.md'), '# Report\nhttps://example.com\n');
                send({ type: 'tool_execution_end', toolCallId: 'write', toolName: 'bash', result: { content: [{ type: 'text', text: 'Written report.md' }] }, isError: false });
            }
            complete(text === 'history' ? messages!.filter(m => m.role === 'user').map(m => m.content).join(' | ') : 'Echo: ' + text);
        };
        return {
            write(line) {
                if (stopped) return false;
                const command = JSON.parse(line);
                const response = (data: PiRecord = {}) => send({ type: 'response', id: command.id, success: true, data });
                switch (command.type) {
                    case 'get_state': response({ sessionId: id, sessionFile: native, model: { provider: 'fake', id: 'test', contextWindow: 64000 }, thinkingLevel: 'off', isStreaming: active.has(id) }); break;
                    case 'get_available_models': response({ models: [{ provider: 'fake', id: 'test' }] }); break;
                    case 'get_messages': response({ messages }); break;
                    case 'prompt': prompt(command.message); response({ disposition: 'started' }); break;
                    case 'abort': active.delete(id); send({ type: 'agent_settled', aborted: true }); response(); break;
                    default: response();
                }
                return true;
            },
            closeInput() { if (!stopped) { stopped = true; active.delete(id); handlers.exit(0, ''); } },
            stop() { if (!stopped) { stopped = true; active.delete(id); handlers.exit(143, ''); } },
        };
    };
    const runtime: FolderPiRuntime = { discover: async () => 'fake-pi', connect: (argv, cwd) => new PiRpc(argv, cwd, spawn) };
    return { runtime, launches, prompts, sessions, instructions, active, spawn };
}
