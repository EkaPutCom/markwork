// Reads one line of an SSE stream from an OpenAI-style chat API (used by DeepSeek).
// Pure TypeScript so it is easy to test.

import type { Usage } from './provider';

// Tool-call fragments that arrive incrementally: `index` determines which tool, its arguments are concatenated.
export interface ToolDelta {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
}

export type StreamEvent =
    | { kind: 'chunk'; text: string; reasoning: string; tools: ToolDelta[]; usage: Usage | null }
    | { kind: 'done' };

// null = an ignored line (blank, keep-alive comment, broken JSON, or a fragment without content).
export function parseStreamLine(line: string): StreamEvent | null {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { kind: 'done' };
    let data: any;
    try {
        data = JSON.parse(payload);
    } catch (e) {
        return null;
    }
    const delta = data?.choices?.[0]?.delta;
    const text: string = delta?.content ?? '';
    const reasoning: string = delta?.reasoning_content ?? '';
    const tools: ToolDelta[] = Array.isArray(delta?.tool_calls)
        ? delta.tool_calls.map((t: any, i: number) => ({
            index: typeof t.index === 'number' ? t.index : i,
            id: t.id ?? undefined,
            name: t.function?.name ?? undefined,
            arguments: t.function?.arguments ?? undefined,
        }))
        : [];
    const u = data?.usage;
    const usage: Usage | null = u && typeof u.prompt_tokens === 'number'
        ? { prompt: u.prompt_tokens, cached: u.prompt_cache_hit_tokens ?? 0, completion: u.completion_tokens ?? 0 }
        : null;
    if (!text && !reasoning && !tools.length && !usage) return null;
    return { kind: 'chunk', text, reasoning, tools, usage };
}

// Error message from an HTTP status; the body (JSON {"error":{"message":…}}) is used as additional detail.
export function httpErrorMessage(status: number, body: string): string {
    let detail = '';
    try {
        detail = JSON.parse(body)?.error?.message ?? '';
    } catch (e) {
        detail = body.slice(0, 200);
    }
    const base: Record<number, string> = {
        400: 'Request rejected (invalid format, model name, or context length)',
        401: 'API key rejected; check the key again in the assistant settings',
        402: 'Insufficient DeepSeek account balance',
        422: 'Invalid request parameters',
        429: 'Too many requests; try again in a moment',
        500: 'DeepSeek server problem; try again later',
        503: 'DeepSeek server is busy; try again later',
    };
    const text = base[status] ?? `The server responded with status ${status}`;
    return detail ? `${text}: ${detail}` : text;
}
