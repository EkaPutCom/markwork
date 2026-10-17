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

// A file or folder as a listing or a lookup sees it, without following a symbolic link. stamp changes whenever the
// contents may have (size and modification time); it is compared, never parsed.
export interface EntryInfo {
    name: string;
    kind: EntryKind;
    size: number;
    stamp: string;
}

// Raw UTF-8 text files and folders: no queueing, no change notices (files.ts adds those for the app). Each call throws on
// failure; handling is up to the caller.
export interface FileSystem {
    readText(path: string): string;
    writeText(path: string, text: string): void;      // atomic: a reader sees the old file or the new one
    append(path: string, text: string): void;         // to the end, creating the file if needed
    // A write off the main thread (atomic, synced to disk). done(error) runs during startWrite() when the write cannot
    // begin, otherwise during pumpWrites(); error is null on success.
    startWrite(path: string, text: string, done: (error: unknown) => void): void;
    pumpWrites(wait: boolean): void;                   // run finished writes' done; wait = block until one has finished
    exists(path: string): boolean;
    remove(path: string): void;
    makeDirs(path: string, mode: number): void;
    setMode(path: string, mode: number): void;
    list(dir: string): string[];      // the names of a folder's entries, in no particular order
    kind(path: string): EntryKind;    // 'missing' only when nothing is there; any other error (no permission) throws
    isDirectory(path: string): boolean;   // a folder, also through a symbolic link
    trash(path: string): void;        // to the desktop trash, so it can be restored
    move(from: string, to: string): void;   // a file or folder; fails when something is already at `to`
    // A file, or a folder with everything in it, without following symbolic links (a link is copied as a link); fails
    // when something is already at `to`. The bytes are copied as they are, so it is the way to copy an image.
    copy(from: string, to: string): void;
    info(path: string): EntryInfo;    // throws when nothing is there
    listInfo(dir: string): EntryInfo[];
    // Calls onChange with the path of each entry in dir that is created, deleted, changed, or moved (both names for a
    // move). Throws when the folder cannot be watched (a network file system). Returns a function that stops watching.
    watchDir(dir: string, onChange: (path: string) => void): () => void;
}

export interface Paths {
    join(...parts: string[]): string;
    dirname(path: string): string;
    resolve(path: string): string;                       // absolute and without . or .. parts
    relative(dir: string, path: string): string | null;  // path relative to dir; null when it is not inside dir
    basename(path: string): string;
    isAbsolute(path: string): boolean;
    configDir(): string;              // the per-user configuration folder (~/.config on Linux)
    homeDir(): string;
    runtimeDir(): string;             // the per-user folder for sockets and other runtime files ($XDG_RUNTIME_DIR on Linux)
}

// The system keyring. A missing or dead keyring is not an error: lookup gives null, store gives false, clear does nothing.
export interface Secrets {
    lookup(schema: string, attributes: Record<string, string>): Promise<string | null>;
    store(schema: string, attributes: Record<string, string>, label: string, secret: string): Promise<boolean>;
    clear(schema: string, attributes: Record<string, string>): Promise<void>;
}

// A program run once to the end, its output collected (git). status -1 = it was stopped or its result was lost; err says
// which. The run is null when the program could not be started (not installed, or the folder does not exist).
export interface RunRequest {
    argv: string[];
    cwd: string;
    env?: Record<string, string>;     // added to the inherited environment
    timeoutMs?: number;               // stop a run that has not finished by then
    lostMs?: number;                  // after the program has exited, how long to wait for its output before giving up
}
export interface RunResult { status: number; out: string; err: string }

// A long-running program spoken to line by line: commands to its stdin, its stdout read as lines (LF only). exit gets the
// exit code (128 + signal for a signal) and the tail of stderr, once, after both outputs are drained.
export interface ChildHandlers {
    line(text: string): void;
    exit(status: number, stderr: string): void;
}
export interface ChildProcess {
    write(line: string): boolean;     // false if stdin is already closed or failed
    closeInput(): void;
    stop(): void;                     // SIGTERM, then SIGKILL if it is ignored
}

export interface Processes {
    run(request: RunRequest): Promise<RunResult | null>;   // argv[0] is looked up on PATH
    // argv[0] is a path (from findProgram), not looked up on PATH. Throws if the program cannot be run.
    spawn(argv: string[], cwd: string, handlers: ChildHandlers): ChildProcess;
    // The program's path, also in the user's own bin folders that a desktop launch may leave out of PATH; null = not found.
    findProgram(name: string): string | null;
    launch(argv: string[]): boolean;                  // starts a program and lets it run on its own (a terminal); argv[0] on PATH
    hostName(): string;
}

// The app's stored preferences, by key. The values are the shapes AppSettings (settings.ts) reads and writes; which keys
// exist and their defaults belong to the store (a GSettings schema under GJS).
export type SettingValue = boolean | number | string | [string, number][] | Record<string, string>;

export interface SettingsStore {
    get(key: string): SettingValue;
    set(key: string, value: SettingValue): void;
    onChanged(listener: (key: string) => void): () => void;   // returns a function that stops listening
}

// Work that may wait for the window: it runs after drawing and input. fn returns true to run again on the next idle turn.
// Each returns a function that cancels it (harmless after it ran).
export interface Scheduler {
    idle(fn: () => boolean): () => void;
    idleAfter(ms: number, fn: () => void): () => void;
}

// A connection that carries lines both ways (to markworkd). onClose fires once; reason is null for a clean close.
export interface LineLink {
    onLine: ((line: string) => void) | null;
    onClose: ((reason: string | null) => void) | null;
    send(line: string): boolean;      // false if the link is already closed
    close(): void;
}
export interface Links {
    socket(path: string): LineLink;   // a Unix socket on this machine; throws if nobody listens there
    // A command's stdin and stdout (ssh … markworkd bridge); it ends when the command does, with its stderr tail as
    // the reason. argv[0] is looked up on PATH.
    command(argv: string[]): LineLink;
}

// The interface text in the user's language (gettext under GJS). Without a translation the source text comes back.
export interface Translations {
    text(text: string): string;
    plural(one: string, many: string, n: number): string;
    context(context: string, text: string): string;
}

export type OS = 'linux' | 'darwin' | 'win32';

export interface Platform {
    readonly os: OS;
    readonly fs: FileSystem;
    readonly paths: Paths;
    readonly secrets: Secrets;
    readonly http: Transport;
    readonly httpStream: StreamTransport;
    readonly processes: Processes;
    readonly scheduler: Scheduler;
    readonly links: Links;
    readonly translations: Translations;
    env(name: string): string | null;
    realName(): string | null;        // the user's full name, when the system knows it
    monotonicMs(): number;            // a clock that only moves forward, in milliseconds; for measuring durations
}

let current: Platform | null = null;

export function setPlatform(platform: Platform): void {
    current = platform;
}

// For i18n.ts: code that runs before an entry point installed a platform (or without one) shows the source text.
export function installedPlatform(): Platform | null {
    return current;
}

export function platform(): Platform {
    if (!current) throw new Error('No platform installed: the entry point must import platform/gjs/install.js first');
    return current;
}
