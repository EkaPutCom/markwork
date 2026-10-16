// Model provider interface. The real client (deepseek.ts) and the fake provider in tests use the same shape.
// Pure TypeScript without GTK.

import type { Cancellable } from '../cancel.js';

// One tool the model may call. `parameters` is a JSON Schema.
export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

// A model request to run a tool; arguments is the raw JSON string from the model.
export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

export type ChatMessage =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCall[] }
    | { role: 'tool'; toolCallId: string; content: string };

export interface Usage {
    prompt: number;         // input tokens
    cached: number;         // of that input, the part served from the prefix cache
    completion: number;     // output tokens
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
    thinking?: boolean;      // model thinking mode; off = faster and cheaper
    onText: (delta: string) => void;
    onReasoning?: (delta: string) => void;   // the model's "thoughts", separate from the answer
    cancellable?: Cancellable;
}

export interface ChatResult {
    usage: Usage | null;
    cancelled: boolean;
    toolCalls: ToolCall[];   // non-empty = the model asks for tools to be run instead of answering
    reasoning: string;       // must be sent back together with toolCalls when thinking mode is active
}

export interface Provider {
    // Streams the answer through onText. Throws an Error with an English message on failure.
    chat(request: ChatRequest): Promise<ChatResult>;
}
