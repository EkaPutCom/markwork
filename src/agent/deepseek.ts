// DeepSeek API client (OpenAI-compatible: POST /chat/completions). The answer is read line by line from the SSE stream
// through platform().httpStream.

import { TemporaryProviderError, requestWithRetry } from './recovery';
import { RuntimeMissing, platform, type HttpStream } from '../platform/index';
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall, Usage } from './provider';
import { httpErrorMessage, parseStreamLine } from './sse';

export const DEEPSEEK_URL = 'https://api.deepseek.com';
export { DEEPSEEK_MODELS } from './models';

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

    async chat(request: ChatRequest): Promise<ChatResult> {
        return requestWithRetry({ chat: r => this.stream(r) }, request, ms => new Promise(resolve => {
            let stopListening = () => {};
            const timer = setTimeout(() => { stopListening(); resolve(); }, ms);
            if (request.cancellable) stopListening = request.cancellable.onCancel(() => { clearTimeout(timer); resolve(); });
        }));
    }

    private async stream({ model, messages, tools, thinking, onText, onReasoning, cancellable }: ChatRequest): Promise<ChatResult> {
        const body = {
            model, stream: true, stream_options: { include_usage: true },
            messages: messages.map(toApiMessage),
            thinking: { type: thinking ? 'enabled' : 'disabled' },
            ...(tools?.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        };
        const cancelled = () => !!cancellable?.cancelled;
        const collected = new StreamCollector(onText, onReasoning);
        let stream: HttpStream;
        try {
            // A reasoning model can stay silent for a long time before the answer streams in; the server sends keep-alives every few seconds.
            stream = await platform().httpStream({
                method: 'POST', url: `${this.baseUrl}/chat/completions`, timeoutSeconds: 120, cancel: cancellable,
                headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
        } catch (e) {
            if (e instanceof RuntimeMissing) throw new Error(`${e.message}; the assistant needs it to connect to DeepSeek`);
            if (cancelled()) return { ...collected.result(true), toolCalls: [] };
            throw new TemporaryProviderError(`Cannot connect to DeepSeek: ${e instanceof Error ? e.message : e}`);
        }
        try {
            return await readAnswer(stream, collected, cancelled);
        } finally {
            stream.close();
        }
    }
}

// A status other than 200: the whole body is a JSON error, not a stream.
async function readAnswer(stream: HttpStream, collected: StreamCollector, cancelled: () => boolean): Promise<ChatResult> {
    let errorBody = '';
    for (;;) {
        let line: string | null;
        try {
            line = await stream.readLine();
        } catch (e) {
            if (cancelled()) return collected.result(true);
            throw new TemporaryProviderError(`The connection to DeepSeek was interrupted: ${e instanceof Error ? e.message : e}`);
        }
        if (line === null) throw endOfStreamError(stream.status, errorBody);
        if (stream.status !== 200) errorBody += line;
        else if (collected.add(line)) return collected.result(cancelled());
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
