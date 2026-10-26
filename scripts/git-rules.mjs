// Git naming rules shared by the local commit hook and PR CI. No third-party dependencies.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const types = '(?:feat|fix|refactor|docs|test|chore|perf)';
const subject = new RegExp(`^${types}\\([a-z][a-z0-9-]*\\): \\S[^\\r\\n]*$`);
const branch = new RegExp(`^${types}/[a-z0-9]+(?:-[a-z0-9]+)*$`);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function checkSubject(message) {
    const first = message.split(/\r?\n/)[0];
    if (!subject.test(first) || first !== first.trimEnd()) throw new Error(`Invalid commit subject: ${JSON.stringify(first)}. Use type(module): description, e.g. feat(editor): add a block removal button.`);
}

export function checkBranch(name) {
    if (!branch.test(name ?? '')) throw new Error(`Invalid branch: ${JSON.stringify(name)}. Use type/short-kebab-case-description, e.g. feat/horizontal-rules.`);
}

function checkRange(base, head) {
    if (!/^[a-f0-9]{40,64}$/.test(base ?? '') || !/^[a-f0-9]{40,64}$/.test(head ?? '')) throw new Error('CI requires base and head commit SHAs.');
    const commits = git('log', '--no-merges', '--format=%H%x00%s', `${base}..${head}`);
    for (const line of commits ? commits.split('\n') : []) {
        const [sha, message] = line.split('\0');
        try { checkSubject(message); } catch (error) { throw new Error(`${sha}: ${error.message}`); }
    }
}

export function run(args) {
    if (args.length === 2 && args[0] === '--branch') checkBranch(args[1]);
    else if (args.length === 2 && args[0] === '--message-file') {
        // Only a real merge is exempt; hand-written "Merge ..." subjects still fail.
        let merging = false;
        try { git('rev-parse', '--verify', 'MERGE_HEAD'); merging = true; } catch { /* ordinary commit */ }
        if (!merging) checkSubject(readFileSync(args[1], 'utf8'));
    } else if (args.length === 1 && args[0] === '--ci') {
        checkBranch(process.env.PR_BRANCH);
        checkRange(process.env.PR_BASE_SHA, process.env.PR_HEAD_SHA);
    } else if (args.length === 1 && args[0] === '--install') {
        let existing = '';
        try { existing = git('config', '--get', 'core.hooksPath'); } catch (error) { if (error.status !== 1) throw error; }
        if (existing && existing !== '.githooks') throw new Error(`core.hooksPath is already ${JSON.stringify(existing)}; refusing to replace existing hooks.`);
        git('config', '--local', 'core.hooksPath', '.githooks');
        console.log('Installed the tracked commit-message hook.');
    } else throw new Error('Use --branch <name>, --message-file <path>, --ci, or --install.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { run(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
