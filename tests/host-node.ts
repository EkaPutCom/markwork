// The test host on Node: process for the environment, node:http for the fake HTTP server.

import { mkdtempSync, realpathSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setHost, type FakeReply, type FakeRequest, type FakeServer, type TestHost } from './host.js';

function serve(handler: (request: FakeRequest, reply: FakeReply) => void): Promise<FakeServer> {
    const server = createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(', ') : value ?? '';
            res.statusCode = 200;
            handler({ method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0], headers, body }, {
                status: code => { res.statusCode = code; },
                header: (name, value) => res.setHeader(name, value),
                write: text => { res.write(text); },
                end: () => { if (!res.writableEnded) res.end(); },
            });
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            resolve({
                port: typeof address === 'object' && address ? address.port : 0,
                close: () => { server.closeAllConnections(); server.close(); },
            });
        });
    });
}

const nodeHost: TestHost = {
    runtime: 'node',
    args: process.argv.slice(2),
    print: text => { process.stdout.write(`${text}\n`); },
    // The real path: git reports paths without symlinks, and macOS's temp folder (/var/folders) is behind one (/private/var).
    makeTempDir: () => realpathSync(mkdtempSync(join(tmpdir(), 'markwork-test-'))),
    setenv: (name, value) => { if (value === null) delete process.env[name]; else process.env[name] = value; },
    pathOfUrl: url => fileURLToPath(url),
    gc: () => { (globalThis as { gc?: () => void }).gc?.(); },
    symlink: (target, path) => symlinkSync(target, path),
    modified: path => Number(statSync(path, { bigint: true }).mtimeNs / 1000n),
    setModified: (path, us) => utimesSync(path, statSync(path).atime, us / 1e6),   // seconds as a number keep the microseconds
    serve,
    settle: () => { throw new Error('settle() needs a nested main loop, which Node does not have; await the Promise instead'); },
    exit: code => process.exit(code),
};

setHost(nodeHost);
