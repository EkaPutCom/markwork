import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = new URL('./line-length.mjs', import.meta.url);
const run = (...args) => spawnSync(
    process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8' }
);

test('counts Unicode, blank lines, CRLF and an unterminated last line', () => {
    const folder = mkdtempSync(join(tmpdir(), 'line-length-'));
    try {
        const file = join(folder, 'sample.txt');
        writeFileSync(file, 'abc\r\n\r\n😀é\r\nx');
        const result = run(file);
        assert.equal(result.status, 0);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout,
            `${file}:1: 3\n${file}:2: 0\n${file}:3: 2\n${file}:4: 1\n`);
        const filtered = run('--max', '2', file);
        assert.equal(filtered.status, 1);
        assert.equal(filtered.stdout, `${file}:1: 3\n`);
        assert.equal(run('--max', '3', file).status, 0);
        writeFileSync(file, '');
        assert.equal(run(file).stdout, '');
        writeFileSync(file, 'a\n');
        assert.equal(run(file).stdout, `${file}:1: 1\n`);
        assert.equal(run(file, file).stdout, `${file}:1: 1\n${file}:1: 1\n`);
        assert.equal(run('--', file).status, 0);
        assert.equal(run(join(folder, 'missing')).status, 2);
        writeFileSync(file, `${'x'.repeat(80)}\n${'😀'.repeat(81)}\n`);
        const summary = run('--summary', '--max', '80', file);
        assert.equal(summary.status, 1);
        assert.equal(summary.stdout, `${file}:2: 81\n`);
        assert.match(summary.stderr, /Violations: 1; files: 1\/1/);
        assert.ok(summary.stderr.includes(`${file}: 1`));
        const missing = join(folder, 'missing');
        assert.equal(run('--max', '80', file, missing).status, 2);
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test('validates arguments and offers help', () => {
    const invalid = [
        [], ['--max'], ['--max', '-1'], ['--max', '1.5'],
        ['--max', '9007199254740992'], ['--unknown'], ['--summary', 'x'],
        ['--tracked', 'x'],
    ];
    for (const args of invalid) {
        assert.equal(run(...args).status, 2);
    }
    assert.equal(run('--help').status, 0);
});

test('audits tracked source files and summarizes violations', () => {
    const result = spawnSync(process.execPath, [
        fileURLToPath(script), '--tracked', '--summary', '--max', '0',
    ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /src\/.*\.ts:\d+: \d+/);
    assert.match(result.stderr, /Violations: \d+; files: \d+\/\d+/);
    assert.match(result.stderr, /By directory:/);
    assert.match(result.stderr, /By file:/);
});
