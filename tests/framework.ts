// A mini test framework used by all test modules: the result recorder and assertion functions.

import GLib from 'gi://GLib';
import System from 'system';

const argv = System.programArgs;
export const opt = (name: string) => argv.includes(`--${name}`);
export const optVal = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

// The project folder. This module lives in tests/ (source) or dist/chunks/ (build output),
// so it is computed from the entry location (run-tests) through setRoot.
export let ROOT = '';
export function setRoot(url: string): void {
    ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(url)[0]));
}

// Settings and test files are put in a temporary folder, not ~/.config. It is safe to set
// after the import because settings.ts only reads XDG_CONFIG_HOME when called.
export const tmp = GLib.dir_make_tmp('markwork-test-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', tmp, true);

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

export const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

let passed = 0, failed = 0;

export function section(name: string): void { print(`\n${name}`); }

export function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        print(`  ${GREEN}✓${RESET} ${name}`);
    } catch (e) {
        failed++;
        print(`  ${RED}✗ ${name}${RESET}\n    ${errorMessage(e).split('\n').join('\n    ')}`);
    }
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

// Waits for a Promise to finish while running the main loop (tests are synchronous). Throws on an error or a timeout.
export function settle<T>(promise: Promise<T>, timeoutMs = 10000): T {
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
