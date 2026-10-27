// A mini test framework used by all test modules: the result recorder and assertion functions. It reaches the runtime
// only through the test host (host.ts) and the platform port, so the core's tests run on Node and on a fake platform.

import { platform } from '../../src/platform/index';
import { host } from './host';

export const opt = (name: string) => host().args.includes(`--${name}`);
export const optVal = (name: string) => host().args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

// The project folder. This module lives in tests/core/ (source) or dist/chunks/ (build output),
// so it is computed from the entry location (run-tests) through setRoot.
export let ROOT = '';
export function setRoot(url: string): void {
    const { dirname } = platform().paths;
    ROOT = dirname(dirname(host().pathOfUrl(url)));
}

// Settings and test files are put in a temporary folder, not ~/.config. It is safe to set
// after the import because base/settings.ts only reads XDG_CONFIG_HOME when called.
export const tmp = host().makeTempDir();
host().setenv('XDG_CONFIG_HOME', tmp);
host().setenv('XDG_DATA_HOME', platform().paths.join(tmp, 'data'));   // the Trash a test moves files to is its own, not the user's
// The test repositories compare file bytes: git on Windows must not turn LF into CRLF on checkout, whatever the machine's config.
host().setenv('GIT_CONFIG_COUNT', '1');
host().setenv('GIT_CONFIG_KEY_0', 'core.autocrlf');
host().setenv('GIT_CONFIG_VALUE_0', 'false');

// A path with / for every separator, to compare a path git wrote (C:/Users/…) with one the system built.
export const slash = (path: string): string => path.replace(/\\/g, '/');

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

export const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

let passed = 0, failed = 0;

export const say = (text: string): void => host().print(text);

export function section(name: string): void { say(`\n${name}`); }

const pass = (name: string) => { passed++; say(`  ${GREEN}✓${RESET} ${name}`); };
const fail = (name: string, e: unknown) => { failed++; say(`  ${RED}✗ ${name}${RESET}\n    ${errorMessage(e).split('\n').join('\n    ')}`); };

// A synchronous test is recorded before test() returns; an async one when the returned Promise settles, so a module
// whose tests wait awaits each test() in turn.
// A step inside a test, printed when MARKWORK_TRACE is set.
export function trace(step: string): void { if (platform().env('MARKWORK_TRACE')) host().print(`      · ${step}`); }

export function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    let result: void | Promise<void>;
    if (platform().env('MARKWORK_TRACE')) host().print(`  … ${name}`);   // which test a stalled run is in (CI sets it)
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

// A Promise that rejects when the one given has not finished within timeoutMs; await it in a test.
export function within<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The Promise did not finish before the timeout')), timeoutMs);
    });
    return Promise.race([promise, late]).finally(() => { if (timer) clearTimeout(timer); });
}


// Waits a little, letting timers and I/O run.
export const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Polls until cond() holds, letting timers and I/O run in between; fails after timeoutMs.
// Wait for what a test expects to happen, never a fixed time: a fixed pause is too short on a slow runner and too long
// everywhere else. A fixed pause is right only to show that something does NOT happen (nothing is sent, the file stays).
export async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const end = platform().monotonicMs() + timeoutMs;
    while (!cond()) {
        if (platform().monotonicMs() > end) throw new Error('timed out');
        await pause(1);
    }
}

// Until an editor holds `expected`. A lagging editor (tests/unit/appsession.ts) throws while a write is on its way; that
// counts as not yet.
export async function untilText(editor: { getText(): string }, expected: string, timeoutMs = 5000): Promise<void> {
    const text = () => { try { return editor.getText(); } catch { return null; } };
    await until(() => text() === expected, timeoutMs);
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
