// The test host on GJS: GLib for the environment and the main loop, libsoup for the fake HTTP server.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import { setHost, type FakeReply, type FakeRequest, type FakeServer, type TestHost } from './host.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function serve(handler: (request: FakeRequest, reply: FakeReply) => void): Promise<FakeServer> {
    const Soup = (await import('gi://Soup?version=3.0')).default;
    const server = new Soup.Server();
    server.add_handler(null, (_server, msg, path) => {
        const headers: Record<string, string> = {};
        msg.get_request_headers().foreach((name, value) => { headers[name.toLowerCase()] = value; });
        let ended = false, streaming = false;
        const body = msg.get_response_body();
        const reply: FakeReply = {
            status: code => msg.set_status(code, null),
            header: (name, value) => {
                if (name.toLowerCase() === 'content-type') msg.get_response_headers().set_content_type(value, null);
                else msg.get_response_headers().append(name, value);
            },
            write: text => body.append(enc.encode(text)),
            end: () => {
                if (ended) return;
                ended = true;
                if (streaming) body.complete();
            },
        };
        handler({ method: msg.get_method(), path, headers, body: dec.decode(msg.get_request_body().data ?? new Uint8Array()) }, reply);
        if (!ended) {
            // Still open: send what is there as chunks and keep the message going.
            streaming = true;
            msg.get_response_headers().set_encoding(Soup.Encoding.CHUNKED);
        }
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    return { port: server.get_uris()[0].get_port(), close: () => server.disconnect() };
}

function settle<T>(promise: Promise<T>, timeoutMs: number): T {
    let done = false, value: T | undefined, error: unknown;
    const loop = new GLib.MainLoop(null, false);
    const finish = () => { done = true; loop.quit(); };
    promise.then(v => { value = v; finish(); }, e => { error = e; finish(); });
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    if (!done) loop.run();
    if (done) GLib.source_remove(timer);
    if (!done) throw new Error('The Promise did not finish before the timeout');
    if (error) throw error;
    return value as T;
}

const gjsHost: TestHost = {
    runtime: 'gjs',
    args: System.programArgs,
    print: text => print(text),
    makeTempDir: () => GLib.dir_make_tmp('markwork-test-XXXXXX'),
    setenv: (name, value) => { if (value === null) GLib.unsetenv(name); else GLib.setenv(name, value, true); },
    pathOfUrl: url => GLib.filename_from_uri(url)[0],
    gc: () => System.gc(),
    symlink: (target, path) => { Gio.File.new_for_path(path).make_symbolic_link(target, null); },
    modified: path => {
        const info = Gio.File.new_for_path(path).query_info('time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_uint64('time::modified') * 1e6 + info.get_attribute_uint32('time::modified-usec');
    },
    setModified: (path, us) => {
        const file = Gio.File.new_for_path(path);
        file.set_attribute_uint64('time::modified', Math.floor(us / 1e6), Gio.FileQueryInfoFlags.NONE, null);
        file.set_attribute_uint32('time::modified-usec', us % 1e6, Gio.FileQueryInfoFlags.NONE, null);
    },
    serve,
    settle,
    exit: code => { System.exit(code); throw new Error('exit'); },
};

setHost(gjsHost);
