// Live test of the forge layer against a real Forgejo or Gitea (a local one is fine; see the README of the setup in the
// session notes: ~/forgejo-local). NOT part of npm test: it needs a running server with the repository seeded.
//
//   FORGEJO_TOKEN=<owner token> npm run test:live:forge                       read-only checks
//   FORGEJO_TOKEN=… FORGEJO_CONTRIBUTOR_TOKEN=… npm run test:live:forge -- --write
//
// --write also exercises what changes the server: a comment, a pull request sent through a fork and merged, one sent through
// AGit, and a pull request that is made to conflict and then resolved on this computer. Each run adds its own pull requests
// (all closed or merged at the end) and never touches the ones the seed script made.
// FORGEJO_URL (default http://localhost:3000) and FORGEJO_REPO (default eka/notes) select the server and the repository.
// Tokens are never printed.

import '../../src/platform/node/install.js';   // the core reaches the runtime through platform()
import '../core/host-node.js';   // the tests reach the runtime through host(), installed before framework.ts
import { CONTRIBUTOR_TOKEN, OWNER_TOKEN, REPO, SERVER_URL as URL, api, check, clone, contributor, git, owner, read, repo, stamp, waitFor, write } from './forgejo-support.js';
import { sendChanges, type SendContext } from '../../src/forge/contribute.js';
import { fileDiff } from '../../src/forge/diff.js';
import { publishBranch } from '../../src/forge/publish.js';
import { GiteaProvider } from '../../src/forge/gitea.js';
import { platform } from '../../src/platform/index.js';
import { host } from '../core/host.js';
import { base64 } from '../../src/forge/contribute.js';
import { confirmMerged, finishLocalMerge, preflight, startLocalMerge, unresolved, type LocalMerge } from '../../src/forge/resolve.js';
import type { PullRequest } from '../../src/forge/types.js';
import { runGit } from '../../src/base/git.js';
import { DIM, GREEN, RED, RESET, disk, errorMessage, opt, say } from '../core/framework.js';

let passed = 0, failed = 0;
async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
        const value = await run();
        passed++;
        say(`  ${GREEN}✓${RESET} ${name}`);
        return value;
    } catch (e) {
        failed++;
        say(`  ${RED}✗ ${name}${RESET}\n    ${errorMessage(e).split('\n').join('\n    ')}`);
        return undefined;
    }
}
async function readChecks(): Promise<PullRequest | undefined> {
    say('\nRead-only: the forge client against the real server');
    const me = await step('currentUser answers with the token\'s user', async () => { const u = await owner.currentUser(); check(u, 'empty login'); return u; });
    const info = await step('repoInfo: owner, default branch, clone URL, and whether the token may push', async () => {
        const r = await owner.repoInfo();
        check(r && r.defaultBranch && r.cloneUrl.startsWith(URL), `unexpected ${JSON.stringify(r)}`);
        check(r.canPush === true, `the owner token should be able to push (got ${r.canPush})`);
        return r;
    });
    await step('repoInfo of a repository that does not exist is null', async () => check(await owner.repoInfo(me ?? 'x', `no-such-${stamp}`) === null, 'expected null'));
    const pulls = await step('listPulls reads the open pull requests', async () => { const p = await owner.listPulls('open'); check(p.length >= 1, 'no open pull request: run the seed script'); return p; });
    const clean = pulls?.find(p => p.mergeable === true), conflicting = pulls?.find(p => p.mergeable === false);
    await step('mergeable is told apart: one pull request is clean, one conflicts (the seeded ones)', async () => check(clean && conflicting, `got ${JSON.stringify(pulls?.map(p => [p.number, p.mergeable]))}`));
    const pull = clean ?? pulls?.[0];
    if (!pull) return undefined;
    await step('getPull: head and base commits are real SHAs', async () => { const p = await owner.getPull(pull.number); check(/^[0-9a-f]{40}$/.test(p.headSha) && /^[0-9a-f]{40}$/.test(p.baseSha), `${p.headSha} ${p.baseSha}`); check(p.author, 'no author'); });
    const files = await step('getFiles lists the changed files with statuses', async () => { const f = await owner.getFiles(pull.number); check(f.length >= 1 && f.every(x => x.path && x.status), JSON.stringify(f)); return f; });
    const diff = await step('getDiff returns the unified diff, and fileDiff cuts one file out of it', async () => {
        const d = await owner.getDiff(pull.number);
        check(d.includes('diff --git'), 'no diff header');
        check(files?.every(f => fileDiff(d, f.path) !== ''), 'a changed file is missing from the diff');
        return d;
    });
    void diff;
    // Any open pull request that modifies a file will do for comparing the two versions of it (after repeated --write runs the
    // seeded one may be gone or have changed).
    let modified: { pull: PullRequest; path: string } | undefined;
    for (const candidate of pulls ?? []) {
        const path = (await owner.getFiles(candidate.number)).find(f => f.status === 'modified')?.path;
        if (path) { modified = { pull: candidate, path }; break; }
    }
    await step('getContent: the file at the base and at the head differ; a file that is not there is null', async () => {
        check(modified, 'no open pull request modifies a file: run the seed script');
        const [before, after, missing] = await Promise.all([owner.getContent(modified.path, modified.pull.baseSha), owner.getContent(modified.path, modified.pull.headSha), owner.getContent(`no-such-${stamp}.md`, modified.pull.headSha)]);
        check(before !== null && after !== null && before !== after, 'before and after should both exist and differ');
        check(missing === null, 'a missing file should be null');
    });
    await step('listComments reads the discussion', async () => { const c = await owner.listComments(pull.number); check(Array.isArray(c), 'not a list'); });
    await step('a bad token is told as an auth failure', async () => {
        try { await new GiteaProvider(repo, 'not-a-token', platform().http).listPulls('open'); } catch (e) { check((e as { failure?: string }).failure === 'auth', `got ${errorMessage(e)}`); return; }
        throw new Error('should have been refused');
    });
    void info;
    return pull;
}

async function writeChecks(): Promise<void> {
    say('\nWriting: comments, sending through a fork, AGit, merging, and resolving a conflict here');
    const comment = await step('addComment posts and listComments sees it', async () => {
        const target = (await owner.listPulls('open'))[0];
        const posted = await owner.addComment(target.number, `Live test ${stamp}`);
        check(posted.id && posted.body === `Live test ${stamp}`, JSON.stringify(posted));
        check((await owner.listComments(target.number)).some(c => c.id === posted.id), 'not listed');
        return posted;
    });
    void comment;

    const contrib = await clone(CONTRIBUTOR_TOKEN, `contrib-${stamp}`);
    const context = (): SendContext => ({ provider: contributor, repo, token: CONTRIBUTOR_TOKEN, git: runGit });

    // 1. A pull request through the contributor's fork, merged by the owner.
    const sent = await step('sendChanges through the fork: push over HTTP with the token as a Basic header, then the pull request', async () => {
        write(disk.join(contrib.folder, 'journal.md'), `# Journal\n\nlive test ${stamp}\n`);
        const result = await sendChanges(context(), { folder: contrib.folder, files: [disk.join(contrib.folder, 'journal.md')], title: `Live test ${stamp}`, body: 'Sent by tests/live/live-forge.ts', branch: `live-${stamp}`, via: 'fork' });
        check(result.ok && result.pull, `not sent: ${!result.ok && result.message}`);
        return result.pull;
    });
    if (sent) {
        await step('the pull request shows up for the owner, from the fork, with its file', async () => {
            const p = await owner.getPull(sent.number);
            check(p.state === 'open' && p.author === contrib.login && p.headRef === `live-${stamp}`, JSON.stringify(p));
            check((await owner.getFiles(sent.number)).some(f => f.path === 'journal.md'), 'journal.md is not among the files');
        });
        await step('merge (squash) merges it on the server', async () => {
            await waitFor('the pull request to become mergeable', async () => (await owner.getPull(sent.number)).mergeable === true);
            await owner.merge(sent.number, 'squash');
            check((await owner.getPull(sent.number)).state === 'merged', 'not merged');
        });
    }

    // 2. AGit: no fork, no branch.
    const agitFolder = await clone(CONTRIBUTOR_TOKEN, `agit-${stamp}`);
    const agit = await step('sendChanges through AGit: the server opens the pull request from the push', async () => {
        write(disk.join(agitFolder.folder, 'agit.md'), `# AGit ${stamp}\n`);
        const result = await sendChanges(context(), { folder: agitFolder.folder, files: [disk.join(agitFolder.folder, 'agit.md')], title: `AGit ${stamp}`, body: 'Through refs/for', branch: `agit-${stamp}`, via: 'agit' });
        check(result.ok, `not sent: ${!result.ok && result.message}`);
        return waitFor('the AGit pull request to appear', async () => (await owner.listPulls('open')).find(p => p.title === `AGit ${stamp}`) ?? null);
    });
    if (agit) await api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}/pulls/${agit.number}`, { state: 'closed' });

    // 3. A pull request that conflicts, resolved on this computer.
    const conflictFolder = await clone(CONTRIBUTOR_TOKEN, `conflict-${stamp}`);
    const conflicted = await step('a pull request is sent that edits the first line of agenda/rapat.md', async () => {
        const path = disk.join(conflictFolder.folder, 'agenda', 'rapat.md');
        write(path, read(path).replace('Bahas', `Bahas (contributor ${stamp})`));
        const result = await sendChanges(context(), { folder: conflictFolder.folder, files: [path], title: `Conflict ${stamp}`, body: '', branch: `conflict-${stamp}`, via: 'fork' });
        check(result.ok && result.pull, `not sent: ${!result.ok && result.message}`);
        return result.pull;
    });
    if (!conflicted) return;
    await step('meanwhile main changes the same line; the server then reports the conflict', async () => {
        const file = (await api(OWNER_TOKEN, 'GET', `/repos/${REPO}/contents/agenda/rapat.md?ref=main`)).json;
        const text = Buffer.from(file.content, 'base64').toString('utf8').replace('Bahas', `Bahas (owner ${stamp})`);
        const put = await api(OWNER_TOKEN, 'PUT', `/repos/${REPO}/contents/agenda/rapat.md`, { content: base64(new TextEncoder().encode(text)), sha: file.sha, message: `Owner edit ${stamp}`, branch: 'main' });
        check(put.status === 200, `edit failed: HTTP ${put.status}`);
        await waitFor('the conflict to be computed', async () => (await owner.getPull(conflicted.number)).mergeable === false);
    });
    const mine = await clone(OWNER_TOKEN, `owner-${stamp}`);
    const ownerLogin = mine.login;
    const merge: LocalMerge = { folder: mine.folder, base: 'main', cloneUrl: `${URL}/${REPO}.git`, pull: conflicted.number, title: conflicted.title, login: ownerLogin, token: OWNER_TOKEN };
    const started = await step('startLocalMerge fetches refs/pull/N/head from the server and merges it: the file conflicts', async () => {
        check(await preflight(runGit, mine.folder, 'main') === null, 'preflight refused');
        const result = await startLocalMerge(runGit, merge);
        check(result.ok && result.conflicts.length === 1 && result.conflicts[0].endsWith('agenda/rapat.md'), `got ${JSON.stringify(result)}`);
        check(unresolved(result.conflicts, read).length === 1, 'the markers should be in the file');
        return result;
    });
    if (!started?.ok) return;
    // A fresh repository allows no manual merges: the default is what a user meets first.
    await api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}`, { allow_manual_merge: false, autodetect_manual_merge: false });
    const pushed = await step('finishLocalMerge pushes the resolved merge to the base branch', async () => {
        write(started.conflicts[0], `---\ntitle: Rapat mingguan\n---\n# Rapat mingguan\n\nBahas (owner and contributor ${stamp}).\n`);
        const done = await finishLocalMerge(runGit, merge, started.conflicts);
        check(done.ok, `not finished: ${!done.ok && done.message}`);
        return git(mine.folder, ['rev-parse', 'HEAD']);
    });
    if (!pushed) return;
    await step('pushing does not by itself close the pull request, and the refusal is explained (manual merge not allowed)', async () => {
        const result = await confirmMerged(owner, conflicted.number, pushed);
        check(!result.ok && result.message.includes('Manually merged'), `got ${JSON.stringify(result)}`);
        check((await owner.getPull(conflicted.number)).state === 'open', 'it should still be open');
    });
    await api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}`, { allow_manual_merge: true, autodetect_manual_merge: true });
    await step('with manual merges allowed, confirmMerged records it and the server shows the pull request as merged', async () => {
        const result = await confirmMerged(owner, conflicted.number, pushed);
        check(result.ok, `got ${JSON.stringify(result)}`);
        await waitFor('the pull request to be merged', async () => (await owner.getPull(conflicted.number)).state === 'merged');
    });
}

// What "Create Pull Request" on a card's review does: a branch that already holds the commits is pushed as it is and the pull
// request opened, through the owner's own repository and through the contributor's fork.
async function publishChecks(): Promise<void> {
    say('\nPublishing a reviewed branch: push as it is, open the pull request');
    const branchIn = async (who: { folder: string }, name: string, file: string) => {
        await git(who.folder, ['checkout', '-q', '-b', name]);
        write(disk.join(who.folder, file), `# ${name}\n`);
        await git(who.folder, ['add', '-A']);
        await git(who.folder, ['commit', '-q', '-m', `Work on ${name}`]);
    };
    const mine = await clone(OWNER_TOKEN, `publish-owner-${stamp}`);
    const branch = `markwork/live-${stamp}`;
    await branchIn(mine, branch, 'publish.md');
    const context = (provider: GiteaProvider, token: string): SendContext => ({ provider, repo, token, git: runGit });
    const request = { cwd: mine.folder, branch, base: 'main', title: `Publish ${stamp}`, body: 'From tests/live/live-forge.ts', via: 'direct' as const };
    const opened = await step('publishBranch (direct): the branch is pushed over HTTP with the token as a Basic header, and the pull request opened', async () => {
        const result = await publishBranch(context(owner, OWNER_TOKEN), request);
        check(result.ok && result.pull, `not published: ${!result.ok && result.message}`);
        const pull = await owner.getPull(result.pull.number);
        check(pull.state === 'open' && pull.headRef === branch && pull.baseRef === 'main', JSON.stringify(pull));
        check(!read(disk.join(mine.folder, '.git', 'config')).includes(OWNER_TOKEN), 'the token was written to .git/config');
        return pull;
    });
    await step('publishing again says a pull request is already open, and pushes nothing', async () => {
        const result = await publishBranch(context(owner, OWNER_TOKEN), request);
        check(!result.ok && result.message.includes(`#${opened?.number} is already open`), `got ${JSON.stringify(result)}`);
    });
    if (opened) await api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}/pulls/${opened.number}`, { state: 'closed' });
    await step('a branch that exists on the server with other commits is not overwritten, and the refusal is readable', async () => {
        const again = await clone(OWNER_TOKEN, `publish-again-${stamp}`);
        await branchIn(again, branch, 'other.md');
        const result = await publishBranch(context(owner, OWNER_TOKEN), { ...request, cwd: again.folder });
        check(!result.ok && result.message.includes('already exists on the server'), `got ${JSON.stringify(result)}`);
    });
    const contrib = await clone(CONTRIBUTOR_TOKEN, `publish-contrib-${stamp}`);
    await branchIn(contrib, `markwork/fork-${stamp}`, 'fork.md');
    const forked = await step('publishBranch (fork): the branch goes to the contributor\'s fork and the pull request names it', async () => {
        const result = await publishBranch(context(contributor, CONTRIBUTOR_TOKEN), { ...request, cwd: contrib.folder, branch: `markwork/fork-${stamp}`, title: `Fork publish ${stamp}`, via: 'fork' });
        check(result.ok && result.pull, `not published: ${!result.ok && result.message}`);
        return result.pull;
    });
    if (forked) await api(OWNER_TOKEN, 'PATCH', `/repos/${REPO}/pulls/${forked.number}`, { state: 'closed' });
}

async function main(): Promise<boolean> {
    if (!OWNER_TOKEN) { say(`${RED}FORGEJO_TOKEN is not set${RESET}`); return false; }
    say(`${DIM}${URL} ${REPO}${RESET}`);
    await readChecks();
    if (opt('write')) {
        if (!CONTRIBUTOR_TOKEN) { say(`${RED}--write needs FORGEJO_CONTRIBUTOR_TOKEN${RESET}`); return false; }
        for (const [name, value] of Object.entries({ GIT_TERMINAL_PROMPT: '0' })) host().setenv(name, value);
        await writeChecks();
        await publishChecks();
    }
    say(`\n${failed ? RED : GREEN}${passed} passed, ${failed} failed${RESET}`);
    return failed === 0;
}

let ok = false;
try { ok = await main(); } catch (e) { say(`${RED}${errorMessage(e)}${RESET}`); }
process.exit(ok ? 0 : 1);
