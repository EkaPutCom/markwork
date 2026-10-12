// The real Transport: libsoup 3. Loaded when needed, so without its typelib only collaboration stops working, not the whole app.

import GLib from 'gi://GLib';
import type SoupModule from 'gi://Soup?version=3.0';
import type { HttpRequest, HttpResponse, Transport } from './types.js';

type Soup = typeof SoupModule;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TIMEOUT_SECONDS = 30;

function send(Soup: Soup, request: HttpRequest): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session({ timeout: TIMEOUT_SECONDS, idle_timeout: TIMEOUT_SECONDS });
        const message = Soup.Message.new(request.method, request.url);
        let contentType = '';
        for (const [name, value] of Object.entries(request.headers ?? {})) {
            if (name.toLowerCase() === 'content-type') contentType = value;
            else message.get_request_headers().append(name, value);
        }
        if (request.body !== undefined) message.set_request_body_from_bytes(contentType || 'application/json', new GLib.Bytes(encoder.encode(request.body)));
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                resolve({ status: message.get_status(), body: decoder.decode(bytes.get_data() ?? new Uint8Array()) });
            } catch (e) {
                reject(e);
            }
        });
    });
}

export const soupTransport: Transport = async request => {
    let Soup: Soup;
    try {
        Soup = (await import('gi://Soup?version=3.0')).default;
    } catch (e) {
        throw new Error('libsoup 3 is not installed (on Debian/Ubuntu: package gir1.2-soup-3.0)');
    }
    return send(Soup, request);
};
