// DeepSeek client tests against a fake SSE server on 127.0.0.1 (the test host's), through the platform's streaming
// transport, without a real network.

import { DeepSeek } from '../../src/agent/deepseek.js';
import { section, test, eq, ok, contains, within } from '../core/framework.js';
import { host, type FakeReply } from '../core/host.js';
import { Cancellable } from '../../src/base/cancel.js';

export async function deepseekTests(): Promise<void> {
    section('DeepSeek client (fake server)');

    let auth = '', requested = '';
    let mode: 'stream' | 'unauthorized' | 'tools' | 'busy' | 'truncated' | 'hold' = 'stream';
    let body: any = null;
    let requests = 0;
    const held: FakeReply[] = [];
    const server = await host().serve((msg, reply) => {
        if (msg.path !== '/chat/completions') { reply.status(404); reply.end(); return; }
        requests++;
        if (mode === 'busy') {
            if (requests === 1) { reply.status(503); reply.write('{}'); reply.end(); return; }
            mode = 'stream';
        }
        if (mode === 'hold') {
            // One piece of text, then the stream stays open (chunked, body never completed) until the client gives up.
            reply.status(200);
            reply.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
            held.push(reply);
            return;
        }
        if (mode === 'truncated') {
            reply.status(200);
            reply.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
            reply.end();
            return;
        }
        auth = msg.headers.authorization ?? '';
        requested = msg.method;
        try {
            body = JSON.parse(msg.body);
        } catch (e) {
            body = null;
        }
        if (mode === 'unauthorized') {
            reply.status(401);
            reply.header('Content-Type', 'application/json');
            reply.write('{"error":{"message":"Authentication Fails"}}');
            reply.end();
            return;
        }
        reply.status(200);
        reply.header('Content-Type', 'text/event-stream');
        if (mode === 'tools') {
            // Two tools, their arguments arrive in pieces and interleaved by index.
            const delta = (tool_calls: object[]) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}`;
            const lines = [
                'data: {"choices":[{"delta":{"reasoning_content":"need to look up"}}]}',
                delta([{ index: 0, id: 'c1', type: 'function', function: { name: 'search_text', arguments: '{"te' } }]),
                delta([{ index: 1, id: 'c2', type: 'function', function: { name: 'list_files', arguments: '' } }]),
                delta([{ index: 0, function: { arguments: 'xt":"Laras"}' } }]),
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":9}}',
                'data: [DONE]',
            ];
            reply.write(lines.join('\n\n') + '\n\n');
            reply.end();
            return;
        }
        const lines = [
            ': keep-alive',
            'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
            'data: {"choices":[{"delta":{"reasoning_content":"Considering…  "}}]}',
            'data: {"choices":[{"delta":{"content":"Hello "}}]}',
            'data: {"choices":[{"delta":{"content":"writer"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_cache_hit_tokens":100}}',
            'data: [DONE]',
        ];
        reply.write(lines.join('\n\n') + '\n\n');
        reply.end();
    });
    const port = server.port;
    const client = (key: string) => new DeepSeek(key, `http://127.0.0.1:${port}`);
    const request = { model: 'deepseek-chat', messages: [{ role: 'user' as const, content: 'hai' }] };

    await test('the answer streams in pieces, reasoning is separate, usage is read, the key is sent as a Bearer', async () => {
        mode = 'stream';
        let text = '', thinking = '';
        const result = await within(client('sk-test').chat({ ...request, onText: d => { text += d; }, onReasoning: d => { thinking += d; } }));
        eq(text, 'Hello writer');
        eq(thinking, 'Considering…  ');
        eq(result, { usage: { prompt: 120, cached: 100, completion: 7 }, cancelled: false, toolCalls: [], reasoning: 'Considering…  ' });
        eq(body.thinking, { type: 'disabled' });   // default: without thinking mode
        eq(body.stream, true);
        ok(!('tools' in body), 'without tools it must not send tools');
        eq(auth, 'Bearer sk-test');
        eq(requested, 'POST');
    });

    await test('tools are sent as tools; tool calls that arrive in pieces are assembled per index', async () => {
        mode = 'tools';
        let text = '';
        const result = await within(client('sk-test').chat({
            model: 'deepseek-flash', thinking: true, onText: d => { text += d; },
            tools: [{ name: 'search_text', description: 'search', parameters: { type: 'object', properties: {} } }],
            messages: [
                { role: 'system', content: 'system' },
                { role: 'user', content: 'question' },
                { role: 'assistant', content: '', reasoning: 'think', toolCalls: [{ id: 'x', name: 'list_files', arguments: '{}' }] },
                { role: 'tool', toolCallId: 'x', content: 'result' },
            ],
        }));
        eq(text, '');
        eq(result.toolCalls, [{ id: 'c1', name: 'search_text', arguments: '{"text":"Laras"}' }, { id: 'c2', name: 'list_files', arguments: '' }]);
        eq(result.reasoning, 'need to look up');
        eq(result.usage, { prompt: 50, cached: 0, completion: 9 });
        eq(body.thinking, { type: 'enabled' });
        eq(body.tools, [{ type: 'function', function: { name: 'search_text', description: 'search', parameters: { type: 'object', properties: {} } } }]);
        eq(body.messages[2], { role: 'assistant', content: '', reasoning_content: 'think', tool_calls: [{ id: 'x', type: 'function', function: { name: 'list_files', arguments: '{}' } }] });
        eq(body.messages[3], { role: 'tool', tool_call_id: 'x', content: 'result' });
    });

    await test('a 503 before output is retried; a stream cut off after text is not repeated', async () => {
        mode = 'busy'; requests = 0;
        let text = '';
        await within(client('sk-test').chat({ ...request, onText: d => { text += d; } }));
        eq(requests, 2); eq(text, 'Hello writer');
        mode = 'truncated'; requests = 0; text = '';
        let failed = false;
        try { await within(client('sk-test').chat({ ...request, onText: d => { text += d; } })); } catch (e) { failed = true; contains(String(e), 'completion marker'); }
        eq(failed, true); eq(requests, 1); eq(text, 'partial');
    });

    await test('cancellation during the retry pause finishes without sending a second request', async () => {
        mode = 'busy'; requests = 0;
        const cancellable = new Cancellable();
        setTimeout(() => cancellable.cancel(), 50);
        const r = await within(client('sk-test').chat({ ...request, cancellable, onText: () => {} }));
        eq(r.cancelled, true); eq(requests, 1);
    });

    await test('cancelling while the answer streams keeps the text so far and stops reading', async () => {
        mode = 'hold'; requests = 0;
        const cancellable = new Cancellable();
        let partial = '';
        const r = await within(client('sk-test').chat({ ...request, cancellable, onText: d => { partial += d; cancellable.cancel(); } }));
        eq([r.cancelled, partial, requests], [true, 'Hello ', 1]);
    });

    await test('status 401 becomes an error with the server message', async () => {
        mode = 'unauthorized';
        let message = '';
        try {
            await within(client('wrong').chat({ ...request, onText: () => {} }));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        contains(message, 'API key rejected');
        contains(message, 'Authentication Fails');
    });

    await test('a request that was already cancelled finishes as cancelled, not as an error', async () => {
        mode = 'stream';
        const cancellable = new Cancellable();
        cancellable.cancel();
        const result = await within(client('sk-test').chat({ ...request, onText: () => {}, cancellable }));
        ok(result.cancelled, 'should have been cancelled');
    });

    await test('an unreachable server produces a clear error', async () => {
        let message = '';
        try {
            await within(new DeepSeek('k', 'http://127.0.0.1:1').chat({ ...request, onText: () => {} }));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        contains(message, 'DeepSeek');
    });

    for (const reply of held) reply.end();
    server.close();
}
