import { estimateTokens, type Turn } from './context';
import type { ChatRequest, ChatResult, Provider } from './provider';

export class TemporaryProviderError extends Error {}

// Only retry requests that have not shown output yet; do not duplicate text/reasoning fragments.
export async function requestWithRetry(provider: Provider, request: ChatRequest, wait: (ms: number) => Promise<void>): Promise<ChatResult> {
    for (let attempt = 0; ; attempt++) {
        if (request.cancellable?.cancelled) return { usage: null, cancelled: true, toolCalls: [], reasoning: '' };
        let emitted = false;
        try {
            return await provider.chat({ ...request,
                onText: d => { if (d) emitted = true; request.onText(d); },
                onReasoning: d => { if (d) emitted = true; request.onReasoning?.(d); },
            });
        } catch (e) {
            if (!(e instanceof TemporaryProviderError) || emitted || attempt >= 2 || request.cancellable?.cancelled) throw e;
            await wait(attempt === 0 ? 300 : 900);
        }
    }
}

// Extractive summary: adds no facts. The full history stays saved on disk.
export function compactHistory(history: Turn[], budget: number): { recent: Turn[]; summary: string } {
    let start = 0;
    let size = history.reduce((n, t) => n + estimateTokens(t.content), 0);
    while (history.length - start > 2 && size > budget) {
        size -= estimateTokens(history[start].content) + estimateTokens(history[start + 1].content);
        start += 2;
    }
    const limit = Math.max(0, Math.min(4000, Math.floor(budget * 0.2) * 3));
    let summary = '';
    for (const t of history.slice(0, start).reverse()) {
        const line = `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.replace(/\s+/g, ' ').slice(0, 400)}\n`;
        if (summary.length + line.length > limit) break;
        summary = line + summary;
    }
    return { recent: history.slice(start), summary };
}
