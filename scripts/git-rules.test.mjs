import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBranch, checkSubject } from './git-rules.mjs';

test('commit subjects require the repository type, module, and a nonempty description', () => {
    for (const type of ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf']) checkSubject(`${type}(editor): keep the selection\n\nDetails.`);
    checkSubject('fix(editor): handle CRLF\r\n\r\nDetails.');
    for (const value of ['Redesign horizontal rules', 'feat: add a rule', 'feat(editor): ', 'unknown(editor): change', 'feat(): change', 'fix(editor): change ', '', 'Merge something']) assert.throws(() => checkSubject(value));
});

test('branch names follow the existing type and kebab-case convention', () => {
    for (const name of ['feat/horizontal-rules', 'fix/table-selection', 'docs/git-rules', 'test/ci']) checkBranch(name);
    for (const name of ['codex/redesign-horizontal-rules', 'main', 'feat/Bad_Name', 'feat/', 'feat/extra/path', '-branch', undefined]) assert.throws(() => checkBranch(name));
});

test('installed hook rejects invalid commits, CI checks the PR range, and existing hooks are preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'markwork-git-rules-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const run = (args, env = {}) => spawnSync(process.execPath, ['scripts/git-rules.mjs', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    try {
        git('init', '-b', 'main');
        git('config', 'user.name', 'Git Rules Test');
        git('config', 'user.email', 'git-rules@example.test');
        mkdirSync(join(dir, 'scripts'));
        mkdirSync(join(dir, '.githooks'));
        copyFileSync(new URL('./git-rules.mjs', import.meta.url), join(dir, 'scripts/git-rules.mjs'));
        copyFileSync(new URL('../.githooks/commit-msg', import.meta.url), join(dir, '.githooks/commit-msg'));
        chmodSync(join(dir, '.githooks/commit-msg'), 0o755);
        assert.equal(run(['--install']).status, 0);
        assert.equal(git('config', '--get', 'core.hooksPath'), '.githooks');
        git('add', '.');
        assert.throws(() => git('commit', '-m', 'Redesign horizontal rules'), error => /Invalid commit subject/.test(String(error.stderr)));
        git('commit', '-m', 'chore(git): add the commit guard');
        const base = git('rev-parse', 'HEAD');
        git('switch', '-c', 'feat/git-rules');
        writeFileSync(join(dir, 'note.md'), 'A note.');
        git('add', 'note.md');
        git('commit', '-m', 'feat(editor): add a note');
        const env = { PR_BRANCH: 'feat/git-rules', PR_BASE_SHA: base, PR_HEAD_SHA: git('rev-parse', 'HEAD') };
        assert.equal(run(['--ci'], env).status, 0);
        assert.equal(run(['--ci'], { ...env, PR_BRANCH: 'codex/git-rules' }).status, 1);
        assert.equal(run(['--ci'], { ...env, PR_BASE_SHA: '' }).status, 1);
        git('switch', 'main');
        git('merge', '--no-ff', '--no-edit', 'feat/git-rules');
        assert.equal(run(['--ci'], { ...env, PR_HEAD_SHA: git('rev-parse', 'HEAD') }).status, 0, 'a real merge keeps its generated message and is excluded from CI subject checks');
        git('switch', 'feat/git-rules');
        // Simulate a contributor without the local hook: CI must still reject the commit.
        git('-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'Invalid subject');
        const rejected = run(['--ci'], { ...env, PR_HEAD_SHA: git('rev-parse', 'HEAD') });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /Invalid commit subject/);
        git('config', 'core.hooksPath', 'existing-hooks');
        assert.equal(run(['--install']).status, 1);
        assert.equal(git('config', '--get', 'core.hooksPath'), 'existing-hooks');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
