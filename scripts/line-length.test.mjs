import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = new URL('./line-length.mjs', import.meta.url);
const run = (...args) => spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8' });

test('counts Unicode, blank lines, CRLF and an unterminated last line', () => {
    const folder = mkdtempSync(join(tmpdir(), 'line-length-'));
    try {
        const file = join(folder, 'sample.txt');
        writeFileSync(file, 'abc\r\n\r\n😀é\r\nx');
        const result = run(file);
        assert.equal(result.status, 0);
        assert.equal(result.stderr, '');
        assert.equal(result.stdout, `${file}:1: 3\n${file}:2: 0\n${file}:3: 2\n${file}:4: 1\n`);
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
    } finally {
        rmSync(folder, { recursive: true, force: true });
    }
});

test('validates arguments and offers help', () => {
    for (const args of [[], ['--max'], ['--max', '-1'], ['--max', '1.5'], ['--max', '9007199254740992'], ['--unknown']]) {
        assert.equal(run(...args).status, 2);
    }
    assert.equal(run('--help').status, 0);
});
