// The real transports: libsoup 3. Loaded when needed, so without its typelib only the features that talk HTTP stop working
// (collaboration, the assistant), not the whole app.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type SoupModule from 'gi://Soup?version=3.0';
import { RuntimeMissing, type HttpRequest, type HttpResponse, type HttpStream, type StreamTransport, type Transport } from '../index.js';

type Soup = typeof SoupModule;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TIMEOUT_SECONDS = 30;

async function loadSoup(): Promise<Soup> {
    try {
        return (await import('gi://Soup?version=3.0')).default;
    } catch (e) {
        throw new RuntimeMissing('libsoup 3 is not installed (on Debian/Ubuntu: package gir1.2-soup-3.0)');
    }
}

function message(Soup: Soup, request: HttpRequest): SoupModule.Message {
    const msg = Soup.Message.new(request.method, request.url);
    let contentType = '';
    for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (name.toLowerCase() === 'content-type') contentType = value;
        else msg.get_request_headers().append(name, value);
    }
    if (request.body !== undefined) msg.set_request_body_from_bytes(contentType || 'application/json', new GLib.Bytes(encoder.encode(request.body)));
    return msg;
}

function send(Soup: Soup, request: HttpRequest): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session({ timeout: TIMEOUT_SECONDS, idle_timeout: TIMEOUT_SECONDS });
        const msg = message(Soup, request);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                resolve({ status: msg.get_status(), body: decoder.decode(bytes.get_data() ?? new Uint8Array()) });
            } catch (e) {
                reject(e);
            }
        });
    });
}

export const soupTransport: Transport = async request => send(await loadSoup(), request);

// GIO needs its own Gio.Cancellable; the request's CancelSignal cancels it. The link is dropped when the stream closes.
export const soupStreamTransport: StreamTransport = async request => {
    const Soup = await loadSoup();
    const seconds = request.timeoutSeconds ?? TIMEOUT_SECONDS;
    const session = new Soup.Session({ timeout: seconds, idle_timeout: seconds });
    const msg = message(Soup, request);
    const gioCancellable = new Gio.Cancellable();
    const unlink = request.cancel?.onCancel(() => gioCancellable.cancel()) ?? (() => {});
    let input: Gio.InputStream;
    try {
        input = await new Promise<Gio.InputStream>((resolve, reject) => {
            session.send_async(msg, GLib.PRIORITY_DEFAULT, gioCancellable, (_session, result) => {
                try { resolve(session.send_finish(result)); } catch (e) { reject(e); }
            });
        });
    } catch (e) {
        unlink();
        throw e;
    }
    const reader = new Gio.DataInputStream({ base_stream: input, close_base_stream: true });
    const stream: HttpStream = {
        status: msg.get_status(),
        readLine: () => new Promise((resolve, reject) => {
            reader.read_line_async(GLib.PRIORITY_DEFAULT, gioCancellable, (_reader, res) => {
                try { resolve(reader.read_line_finish_utf8(res)[0]); } catch (e) { reject(e); }
            });
        }),
        close: () => {
            unlink();
            try { reader.close(null); } catch (e) { /* already closed */ }
        },
    };
    return stream;
};
