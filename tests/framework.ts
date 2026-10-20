// A mini test framework used by all test modules: the result recorder and assertion functions. It reaches the runtime
// only through the test host (host.ts) and the platform port, so the core's tests run on GJS and on Node.

import { platform } from '../src/platform/index.js';
import { host } from './host.js';

export const opt = (name: string) => host().args.includes(`--${name}`);
export const optVal = (name: string) => host().args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

// The project folder. This module lives in tests/ (source) or dist/chunks/ (build output),
// so it is computed from the entry location (run-tests) through setRoot.
export let ROOT = '';
export function setRoot(url: string): void {
    const { dirname } = platform().paths;
    ROOT = dirname(dirname(host().pathOfUrl(url)));
}

// Settings and test files are put in a temporary folder, not ~/.config. It is safe to set
// after the import because settings.ts only reads XDG_CONFIG_HOME when called.
export const tmp = host().makeTempDir();
host().setenv('XDG_CONFIG_HOME', tmp);

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

export const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

let passed = 0, failed = 0;

export const say = (text: string): void => host().print(text);

export function section(name: string): void { say(`\n${name}`); }

const pass = (name: string) => { passed++; say(`  ${GREEN}✓${RESET} ${name}`); };
const fail = (name: string, e: unknown) => { failed++; say(`  ${RED}✗ ${name}${RESET}\n    ${errorMessage(e).split('\n').join('\n    ')}`); };

// GJS collects garbage incrementally, and until a collection has finished sweeping it drops every signal callback into
// JavaScript ("Attempting to call back into JSAPI during the sweeping phase of GC"). Such a sweep can outlast the test
// that started it, and the next tests' buffer and window handlers then never run, so the GUI tests finish it first.
let collectFirst = false;
export function collectBeforeEachTest(on: boolean): void { collectFirst = on; }

// A synchronous test is recorded before test() returns; an async one when the returned Promise settles, so a module
// whose tests wait awaits each test() in turn.
export function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    let result: void | Promise<void>;
    if (platform().env('MARKWORK_TRACE')) host().print(`  … ${name}`);   // which test a stalled run is in (CI sets it)
    if (collectFirst) host().gc();
    try {
        result = fn();
    } catch (e) {
        fail(name, e);
        return Promise.resolve();
    }
    if (!(result instanceof Promise)) {
        pass(name);
        return Promise.resolve();
    }
    // A test that never settles (a process that was never answered) fails after a minute instead of stalling the run.
    let cancelTimer = () => {};
    const stalled = new Promise<never>((_, reject) => { cancelTimer = platform().scheduler.idleAfter(60000, () => reject(new Error('the test did not finish in 60 s'))); });
    return Promise.race([result, stalled]).then(() => { cancelTimer(); pass(name); }, e => { cancelTimer(); fail(name, e); });
}

// Used by the runner for failures outside test(), e.g. a GUI test that stops halfway.
export function recordFailure(): void { failed++; }

export function summary(): { passed: number; failed: number } { return { passed, failed }; }

export function eq(actual: unknown, expected: unknown, what = 'value'): void {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what} is wrong\n    got:      ${a}\n    expected: ${b}`);
}

export function ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export function contains(haystack: string, needle: string): void {
    if (!haystack.includes(needle)) throw new Error(`does not contain ${JSON.stringify(needle)}\n    in: ${JSON.stringify(haystack.slice(0, 300))}`);
}

// A Promise that rejects when the one given has not finished within timeoutMs; await it in a test that runs on every
// runtime.
export function within<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The Promise did not finish before the timeout')), timeoutMs);
    });
    return Promise.race([promise, late]).finally(() => { if (timer) clearTimeout(timer); });
}

// Waits for a Promise to finish while running the main loop, so a synchronous (GUI) test can use its value. GJS only:
// a test of the core awaits within() instead. Throws on an error or a timeout.
export function settle<T>(promise: Promise<T>, timeoutMs = 10000): T {
    return host().settle(promise, timeoutMs);
}

// Waits a little, letting timers and I/O run.
export const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// The answer of a call that may answer later (Awaitable), when this process answers it at once (the GTK app's own core).
export function sync<T>(value: T | Promise<T>): T {
    if (value instanceof Promise) throw new Error('expected an answer at once, got a Promise');
    return value;
}

// Polls until cond() holds, letting timers and I/O run in between; fails after timeoutMs.
export async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const end = platform().monotonicMs() + timeoutMs;
    while (!cond()) {
        if (platform().monotonicMs() > end) throw new Error('timed out');
        await pause(1);
    }
}

// Test files through the platform port, so a test of the core touches the disk the same way on every runtime.
export const disk = {
    join: (...parts: string[]): string => platform().paths.join(...parts),
    dirname: (path: string): string => platform().paths.dirname(path),
    write: (path: string, text: string): void => platform().fs.writeText(path, text),
    read: (path: string): string => platform().fs.readText(path),
    mkdirs: (path: string): void => platform().fs.makeDirs(path, 0o755),
    exists: (path: string): boolean => platform().fs.exists(path),
    isDirectory: (path: string): boolean => platform().fs.isDirectory(path),
    remove: (path: string): void => platform().fs.remove(path),
};
