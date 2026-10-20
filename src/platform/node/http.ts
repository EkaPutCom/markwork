// The transports on Node: the built-in fetch.

import type { HttpRequest, HttpStream, StreamTransport, Transport } from '../index.js';

const TIMEOUT_SECONDS = 30;

// A body without a Content-Type is sent as JSON.
function init(request: HttpRequest, signal: AbortSignal): RequestInit {
    const headers = { ...request.headers };
    if (request.body !== undefined && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    return { method: request.method, headers, body: request.body, signal };
}

export const fetchTransport: Transport = async request => {
    const response = await fetch(request.url, init(request, AbortSignal.timeout(TIMEOUT_SECONDS * 1000)));
    return { status: response.status, body: await response.text() };
};

// timeoutSeconds is how long the server may stay silent: before the headers, and between pieces of the body.
export const fetchStreamTransport: StreamTransport = async request => {
    const seconds = request.timeoutSeconds ?? TIMEOUT_SECONDS;
    const abort = new AbortController();
    let silence: ReturnType<typeof setTimeout> | null = null;
    const quiet = () => {
        if (silence) clearTimeout(silence);
        silence = setTimeout(() => abort.abort(new Error(`no answer within ${seconds} seconds`)), seconds * 1000);
    };
    const unlink = request.cancel?.onCancel(() => abort.abort(new Error('cancelled'))) ?? (() => {});
    if (request.cancel?.cancelled) abort.abort(new Error('cancelled'));
    quiet();
    let response: Response;
    try {
        response = await fetch(request.url, init(request, abort.signal));
    } catch (e) {
        if (silence) clearTimeout(silence);
        unlink();
        throw e;
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '', ended = !reader, closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        if (silence) clearTimeout(silence);
        unlink();
        reader?.cancel().catch(() => { /* already finished */ });
    };
    const stream: HttpStream = {
        status: response.status,
        async readLine() {
            for (;;) {
                const at = buffer.indexOf('\n');
                if (at >= 0) {
                    const line = buffer.slice(0, at).replace(/\r$/, '');
                    buffer = buffer.slice(at + 1);
                    return line;
                }
                if (ended) {
                    if (!buffer) { close(); return null; }
                    const line = buffer;
                    buffer = '';
                    return line;
                }
                quiet();
                const { done, value } = await reader!.read();
                if (done) { ended = true; buffer += decoder.decode(); } else buffer += decoder.decode(value, { stream: true });
            }
        },
        close,
    };
    return stream;
};
