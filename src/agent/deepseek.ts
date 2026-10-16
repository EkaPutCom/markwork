// DeepSeek API client (OpenAI-compatible: POST /chat/completions) through libsoup 3.
// GJS has no fetch, so answers are read line by line from the SSE stream.

import { TemporaryProviderError, requestWithRetry } from './recovery.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type SoupModule from 'gi://Soup?version=3.0';
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall, Usage } from './provider.js';
import { httpErrorMessage, parseStreamLine } from './sse.js';

export const DEEPSEEK_URL = 'https://api.deepseek.com';
// Models listed in the current DeepSeek documentation (1M token context, supporting tools and thinking mode).
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

const encoder = new TextEncoder();

type Soup = typeof SoupModule;

// Message shape in the API (snake_case). When thinking mode is active, reasoning_content must be sent back together with tool_calls.
export function toApiMessage(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
            role: 'assistant', content: m.content,
            ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
            tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        };
    }
    return { role: m.role, content: m.content };
}

export class DeepSeek implements Provider {
    constructor(private readonly apiKey: string, private readonly baseUrl = DEEPSEEK_URL) {}

    // libsoup is loaded when needed: without its typelib (gir1.2-soup-3.0) only the assistant stops working, not the whole app.
    async chat(request: ChatRequest): Promise<ChatResult> {
        let Soup: Soup;
        try {
            Soup = (await import('gi://Soup?version=3.0')).default;
        } catch (e) {
            throw new Error('libsoup 3 is not installed (on Debian/Ubuntu: package gir1.2-soup-3.0); the assistant needs it to connect to DeepSeek');
        }
        return requestWithRetry({ chat: r => this.stream(Soup, r) }, request, ms => new Promise(resolve => {
            let timer = 0;
            let stopListening = () => {};
            const finish = () => {
                if (timer) { GLib.source_remove(timer); timer = 0; }
                stopListening();
                resolve();
            };
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { timer = 0; finish(); return GLib.SOURCE_REMOVE; });
            if (request.cancellable) stopListening = request.cancellable.onCancel(finish);
        }));
    }

    private stream(Soup: Soup, { model, messages, tools, thinking, onText, onReasoning, cancellable }: ChatRequest): Promise<ChatResult> {
        return new Promise((resolve, reject) => {
            // A reasoning model can stay silent for a long time before the answer streams in; the server sends keep-alives every few seconds.
            const session = new Soup.Session({ idle_timeout: 120, timeout: 120 });
            const message = Soup.Message.new('POST', `${this.baseUrl}/chat/completions`);
            message.get_request_headers().append('Authorization', `Bearer ${this.apiKey}`);
            const body = {
                model, stream: true, stream_options: { include_usage: true },
                messages: messages.map(toApiMessage),
                thinking: { type: thinking ? 'enabled' : 'disabled' },
                ...(tools?.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
            };
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));

            // GIO needs its own Cancellable; ours cancels it. The link is dropped when the request settles.
            const gioCancellable = new Gio.Cancellable();
            const unlink = cancellable?.onCancel(() => gioCancellable.cancel()) ?? (() => {});
            const cancelled = () => !!cancellable?.cancelled;
            const collected = new StreamCollector(onText, onReasoning);
            const settle = (result: ChatResult | null, error?: Error) => {
                unlink();
                if (error) reject(error);
                else resolve(result!);
            };
            session.send_async(message, GLib.PRIORITY_DEFAULT, gioCancellable, (_session, result) => {
                let stream: Gio.InputStream;
                try {
                    stream = session.send_finish(result);
                } catch (e) {
                    if (cancelled()) settle({ ...collected.result(true), toolCalls: [] });
                    else settle(null, new TemporaryProviderError(`Cannot connect to DeepSeek: ${e instanceof Error ? e.message : e}`));
                    return;
                }
                const status: number = message.get_status();
                const reader = new Gio.DataInputStream({ base_stream: stream, close_base_stream: true });
                const finish = (error?: Error) => {
                    try { reader.close(null); } catch (e) { /* already closed */ }
                    if (error) settle(null, error);
                    else settle(collected.result(cancelled()));
                };

                // A status other than 200: the whole body is a JSON error, not a stream.
                let errorBody = '';
                const readLine = () => reader.read_line_async(GLib.PRIORITY_DEFAULT, gioCancellable, (_reader, res) => {
                    let line: string | null;
                    try {
                        [line] = reader.read_line_finish_utf8(res);
                    } catch (e) {
                        if (cancelled()) finish();
                        else finish(new TemporaryProviderError(`The connection to DeepSeek was interrupted: ${e instanceof Error ? e.message : e}`));
                        return;
                    }
                    if (line === null) {
                        finish(endOfStreamError(status, errorBody));
                        return;
                    }
                    if (status !== 200) errorBody += line;
                    else if (collected.add(line)) { finish(); return; }
                    readLine();
                });
                readLine();
            });
        });
    }
}

// The stream ended without the completion marker. A cut-off answer or an overloaded server (429, 5xx) is temporary
// and may be retried; other HTTP errors are not.
function endOfStreamError(status: number, errorBody: string): Error {
    if (status === 200) return new TemporaryProviderError('The DeepSeek stream ended before the completion marker; the work can be resumed from the checkpoint.');
    const message = httpErrorMessage(status, errorBody);
    return status === 429 || status >= 500 ? new TemporaryProviderError(message) : new Error(message);
}

// The answer as it streams in: text and reasoning are passed on at once; tool calls arriving in pieces are joined per index.
class StreamCollector {
    private usage: Usage | null = null;
    private reasoning = '';
    private readonly calls: ToolCall[] = [];   // indexed by ToolDelta.index

    constructor(private readonly onText: (delta: string) => void, private readonly onReasoning?: (delta: string) => void) {}

    // One line of the stream. true = the completion marker.
    add(line: string): boolean {
        const event = parseStreamLine(line);
        if (event?.kind === 'done') return true;
        if (event?.kind !== 'chunk') return false;
        if (event.reasoning) { this.reasoning += event.reasoning; this.onReasoning?.(event.reasoning); }
        if (event.text) this.onText(event.text);
        for (const t of event.tools) {
            const call = this.calls[t.index] ??= { id: '', name: '', arguments: '' };
            if (t.id) call.id = t.id;
            if (t.name) call.name += t.name;
            if (t.arguments) call.arguments += t.arguments;
        }
        if (event.usage) this.usage = event.usage;
        return false;
    }

    result(cancelled: boolean): ChatResult {
        return { usage: this.usage, cancelled, toolCalls: this.calls.filter(Boolean), reasoning: this.reasoning };
    }
}
