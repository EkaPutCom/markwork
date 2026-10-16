// The platform port: what the core (markdown/, agent/, forge/, the orchestrator, and the base modules) needs from the
// runtime, as plain interfaces. The core reaches the runtime only through platform(), never through gi:// imports, so
// the same core can run under GJS (platform/gjs/, installed by every entry point) or another runtime later.
// This file imports nothing: it is the contract, not an implementation (RuntimeMissing is the one class it defines).

export interface HttpRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH';
    url: string;
    headers?: Record<string, string>;
    body?: string;
}
export interface HttpResponse { status: number; body: string }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

// A cancellation the port can listen to; cancel.ts's Cancellable is one.
export interface CancelSignal {
    readonly cancelled: boolean;
    onCancel(listener: () => void): () => void;
}

// A response read line by line as it arrives (a server-sent event stream). readLine gives null at the end and rejects
// when the connection breaks or the request is cancelled; close may be called at any time, more than once.
export interface HttpStream {
    readonly status: number;
    readLine(): Promise<string | null>;
    close(): void;
}
export interface StreamRequest extends HttpRequest {
    timeoutSeconds?: number;          // how long the server may stay silent, also between lines
    cancel?: CancelSignal;
}
export type StreamTransport = (request: StreamRequest) => Promise<HttpStream>;

// The runtime lacks something a feature needs (a library that is not installed). Not worth retrying.
export class RuntimeMissing extends Error {}

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

// The app's stored preferences, by key. The values are the shapes AppSettings (settings.ts) reads and writes; which keys
// exist and their defaults belong to the store (a GSettings schema under GJS).
export type SettingValue = boolean | number | string | [string, number][] | Record<string, string>;

export interface SettingsStore {
    get(key: string): SettingValue;
    set(key: string, value: SettingValue): void;
    onChanged(listener: (key: string) => void): () => void;   // returns a function that stops listening
}

export interface Platform {
    readonly fs: FileSystem;
    readonly paths: Paths;
    readonly secrets: Secrets;
    readonly http: Transport;
    readonly httpStream: StreamTransport;
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
