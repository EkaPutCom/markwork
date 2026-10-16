// The platform port: what the core (markdown/, agent/, forge/, the orchestrator, and the base modules) needs from the
// runtime, as plain interfaces. The core reaches the runtime only through platform(), never through gi:// imports, so
// the same core can run under GJS (platform/gjs/, installed by every entry point) or another runtime later.
// This file imports nothing: it is the contract, not an implementation.

export interface HttpRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH';
    url: string;
    headers?: Record<string, string>;
    body?: string;
}
export interface HttpResponse { status: number; body: string }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

// What is at a path, without following a symbolic link.
export type EntryKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other';

// Synchronous UTF-8 text files and folders. Each call throws on failure; handling is up to the caller.
export interface FileSystem {
    readText(path: string): string;
    writeText(path: string, text: string): void;
    exists(path: string): boolean;
    remove(path: string): void;
    makeDirs(path: string, mode: number): void;
    setMode(path: string, mode: number): void;
    list(dir: string): string[];      // the names of a folder's entries, in no particular order
    kind(path: string): EntryKind;    // 'missing' only when nothing is there; any other error (no permission) throws
    trash(path: string): void;        // to the desktop trash, so it can be restored
}

export interface Paths {
    join(...parts: string[]): string;
    dirname(path: string): string;
    isAbsolute(path: string): boolean;
    configDir(): string;              // the per-user configuration folder (~/.config on Linux)
    runtimeDir(): string;             // the per-user folder for sockets and other runtime files ($XDG_RUNTIME_DIR on Linux)
}

// The system keyring. A missing or dead keyring is not an error: lookup gives null, store gives false, clear does nothing.
export interface Secrets {
    lookup(schema: string, attributes: Record<string, string>): Promise<string | null>;
    store(schema: string, attributes: Record<string, string>, label: string, secret: string): Promise<boolean>;
    clear(schema: string, attributes: Record<string, string>): Promise<void>;
}

export interface Platform {
    readonly fs: FileSystem;
    readonly paths: Paths;
    readonly secrets: Secrets;
    readonly http: Transport;
    env(name: string): string | null;
    monotonicMs(): number;            // a clock that only moves forward, in milliseconds; for measuring durations
}

let current: Platform | null = null;

export function setPlatform(platform: Platform): void {
    current = platform;
}

export function platform(): Platform {
    if (!current) throw new Error('No platform installed: the entry point must import platform/gjs/install.js first');
    return current;
}
