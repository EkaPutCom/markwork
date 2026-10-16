// DeepSeek client tests against a fake SSE server on 127.0.0.1 (libsoup), without a real network.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';
import { DeepSeek } from '../../src/agent/deepseek.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';
import { Cancellable } from '../../src/cancel.js';

const enc = new TextEncoder();

export function deepseekTests(): void {
    section('DeepSeek client (fake server)');
    // Earlier unit tests run without a main loop and can leave GC pending; a Soup callback that arrives
    // at that time is blocked by GJS ("callback during garbage collection"). In the app the main loop always runs.
    System.gc();

    let auth = '', requested = '';
    let mode: 'stream' | 'unauthorized' | 'tools' | 'busy' | 'truncated' | 'hold' = 'stream';
    let body: any = null;
    let requests = 0;
    const held: Soup.ServerMessage[] = [];
    const server = new Soup.Server();
    server.add_handler('/chat/completions', (_server, msg) => {
        requests++;
        if (mode === 'busy') {
            if (requests === 1) { msg.set_status(503, null); msg.get_response_body().append(enc.encode('{}')); return; }
            mode = 'stream';
        }
        if (mode === 'hold') {
            // One piece of text, then the stream stays open (chunked, body never completed) until the client gives up.
            msg.set_status(200, null);
            msg.get_response_headers().set_encoding(Soup.Encoding.CHUNKED);
            msg.get_response_body().append(enc.encode('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'));
            held.push(msg);
            return;
        }
        if (mode === 'truncated') {
            msg.set_status(200, null);
            msg.get_response_body().append(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            return;
        }
        auth = msg.get_request_headers().get_one('Authorization') ?? '';
        requested = msg.get_method();
        try {
            body = JSON.parse(new TextDecoder().decode(msg.get_request_body().data ?? new Uint8Array()));
        } catch (e) {
            body = null;
        }
        if (mode === 'unauthorized') {
            msg.set_status(401, null);
            msg.get_response_headers().set_content_type('application/json', null);
            msg.get_response_body().append(enc.encode('{"error":{"message":"Authentication Fails"}}'));
            return;
        }
        msg.set_status(200, null);
        msg.get_response_headers().set_content_type('text/event-stream', null);
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
            msg.get_response_body().append(enc.encode(lines.join('\n\n') + '\n\n'));
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
        msg.get_response_body().append(enc.encode(lines.join('\n\n') + '\n\n'));
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const port = server.get_uris()[0].get_port();
    const client = (key: string) => new DeepSeek(key, `http://127.0.0.1:${port}`);
    const request = { model: 'deepseek-chat', messages: [{ role: 'user' as const, content: 'hai' }] };

    test('the answer streams in pieces, reasoning is separate, usage is read, the key is sent as a Bearer', () => {
        mode = 'stream';
        let text = '', thinking = '';
        const result = settle(client('sk-test').chat({ ...request, onText: d => { text += d; }, onReasoning: d => { thinking += d; } }));
        eq(text, 'Hello writer');
        eq(thinking, 'Considering…  ');
        eq(result, { usage: { prompt: 120, cached: 100, completion: 7 }, cancelled: false, toolCalls: [], reasoning: 'Considering…  ' });
        eq(body.thinking, { type: 'disabled' });   // default: without thinking mode
        eq(body.stream, true);
        ok(!('tools' in body), 'without tools it must not send tools');
        eq(auth, 'Bearer sk-test');
        eq(requested, 'POST');
    });

    test('tools are sent as tools; tool calls that arrive in pieces are assembled per index', () => {
        mode = 'tools';
        let text = '';
        const result = settle(client('sk-test').chat({
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

    test('a 503 before output is retried; a stream cut off after text is not repeated', () => {
        mode = 'busy'; requests = 0;
        let text = '';
        settle(client('sk-test').chat({ ...request, onText: d => { text += d; } }));
        eq(requests, 2); eq(text, 'Hello writer');
        mode = 'truncated'; requests = 0; text = '';
        let failed = false;
        try { settle(client('sk-test').chat({ ...request, onText: d => { text += d; } })); } catch (e) { failed = true; contains(String(e), 'completion marker'); }
        eq(failed, true); eq(requests, 1); eq(text, 'partial');
    });

    test('cancellation during the retry pause finishes without sending a second request', () => {
        mode = 'busy'; requests = 0;
        const cancellable = new Cancellable();
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { cancellable.cancel(); return GLib.SOURCE_REMOVE; });
        const r = settle(client('sk-test').chat({ ...request, cancellable, onText: () => {} }));
        eq(r.cancelled, true); eq(requests, 1);
        // The timer has run by the time settle finishes.
        ok(timer > 0, 'the timer was not created');
    });

    test('cancelling while the answer streams keeps the text so far and stops reading', () => {
        mode = 'hold'; requests = 0;
        const cancellable = new Cancellable();
        let partial = '';
        const r = settle(client('sk-test').chat({ ...request, cancellable, onText: d => { partial += d; cancellable.cancel(); } }));
        eq([r.cancelled, partial, requests], [true, 'Hello ', 1]);
    });

    test('status 401 becomes an error with the server message', () => {
        mode = 'unauthorized';
        let message = '';
        try {
            settle(client('wrong').chat({ ...request, onText: () => {} }));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        contains(message, 'API key rejected');
        contains(message, 'Authentication Fails');
    });

    test('a request that was already cancelled finishes as cancelled, not as an error', () => {
        mode = 'stream';
        const cancellable = new Cancellable();
        cancellable.cancel();
        const result = settle(client('sk-test').chat({ ...request, onText: () => {}, cancellable }));
        ok(result.cancelled, 'should have been cancelled');
    });

    test('an unreachable server produces a clear error', () => {
        let message = '';
        try {
            settle(new DeepSeek('k', 'http://127.0.0.1:1').chat({ ...request, onText: () => {} }));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        contains(message, 'DeepSeek');
    });

    for (const msg of held) msg.get_response_body().complete();
    server.disconnect();
    GLib.usleep(1000);
}
