// The test host: what the test framework and the tests need from the runtime beyond the platform port (the command
// line, output, the environment, a fake HTTP server). host-gjs.ts and host-node.ts fill it; every test entry point
// installs one right after the platform, before anything imports framework.ts.

// One request to the fake server. Header names are lower case.
export interface FakeRequest {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
}

// The answer to a request. A reply that has not ended when the handler returns is streamed (chunked): what was written
// is sent at once, and later writes and end() continue it.
export interface FakeReply {
    status(code: number): void;
    header(name: string, value: string): void;
    write(text: string): void;
    end(): void;
}

export interface FakeServer {
    readonly port: number;
    close(): void;
}

export interface TestHost {
    readonly runtime: 'gjs' | 'node';
    readonly args: readonly string[];
    print(text: string): void;
    makeTempDir(): string;
    setenv(name: string, value: string | null): void;
    pathOfUrl(url: string): string;          // a file: URL (import.meta.url) as a path
    gc(): void;                              // collect garbage now, where the runtime allows it
    // What the port does not offer because the app never needs it, but tests do to set up a case.
    symlink(target: string, path: string): void;
    modified(path: string): number;          // the modification time, in microseconds since the epoch
    setModified(path: string, us: number): void;
    serve(handler: (request: FakeRequest, reply: FakeReply) => void): Promise<FakeServer>;
    // Waits for a Promise without returning to the caller (a nested main loop). Only the GJS host can; the Node host
    // throws, so a test that runs on both awaits instead.
    settle<T>(promise: Promise<T>, timeoutMs: number): T;
    exit(code: number): never;
}

let current: TestHost | null = null;

export function setHost(host: TestHost): void {
    current = host;
}

export function host(): TestHost {
    if (!current) throw new Error('No test host installed: the entry point must import tests/host-gjs.js or tests/host-node.js first');
    return current;
}
