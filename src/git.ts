// Reads a file's git history through the `git` command. The only changes to the repository
// are commitFile()/commitFiles(), and only at the user's request. Everything is async (Gio.Subprocess) so a long history does not block the editor.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { AGENT_LOG_FORMAT, LOG_FORMAT, parseLog, parseStatus, type Commit, type FileChange, type GitAnswer, type GitRequest } from './gitlog.js';

export type GitFailure = 'no-git' | 'no-repo' | 'failed';

export type LogResult =
    | { ok: true; commits: Commit[] }
    | { ok: false; reason: GitFailure; message: string };

export type TextResult =
    | { ok: true; text: string }
    | { ok: false; reason: GitFailure; message: string };

interface Run { status: number; out: string; err: string }

// GJS 1.80 can block an async callback that arrives while it is garbage collecting ("Attempting to run a JS
// callback during garbage collection"): communicate_utf8_async() then never calls back although git has finished,
// and whatever awaits it (the History tab, an agent Git tool) waits forever. A watchdog settles the run instead,
// as a failure: the output is gone, and a commit must not be repeated blindly. It also stops a git that hangs,
// e.g. on a signing passphrase prompt. Changeable by tests.
export const gitLimits = {
    lostMs: 5000,       // after git has exited without the callback arriving
    runMs: 120000,      // for git to finish at all
};

// null = git cannot be run (not installed, or the folder does not exist).
// extra = environment variables for this one run (a credential for a push stays out of the arguments, which `ps` shows).
export function runGit(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<Run | null> {
    return new Promise(resolve => {
        let done = false, watchdog = 0;
        const finish = (run: Run | null) => {
            if (done) return;
            done = true;
            if (watchdog) GLib.source_remove(watchdog);
            resolve(run);
        };
        try {
            const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
            launcher.set_cwd(cwd);
            // Do not compete for the index lock with another git the user is running.
            launcher.setenv('GIT_OPTIONAL_LOCKS', '0', true);
            // A fetch or pull that needs a password must fail, not wait for a terminal this process does not have.
            launcher.setenv('GIT_TERMINAL_PROMPT', '0', true);
            for (const [name, value] of Object.entries(extra)) launcher.setenv(name, value, true);
            const proc = launcher.spawnv(['git', '-c', 'core.quotePath=false', ...args]);
            const started = GLib.get_monotonic_time();
            let exitedAt = 0;
            watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                const now = GLib.get_monotonic_time();
                if (!exitedAt && proc.get_identifier() === null) exitedAt = now;   // reaped: git has exited
                const lost = exitedAt > 0 && now - exitedAt > gitLimits.lostMs * 1000;
                const hung = !exitedAt && now - started > gitLimits.runMs * 1000;
                if (!lost && !hung) return GLib.SOURCE_CONTINUE;
                watchdog = 0;
                if (hung) proc.force_exit();
                finish({ status: -1, out: '', err: lost ? 'git finished but its result was lost; try again' : `git did not finish within ${Math.round(gitLimits.runMs / 1000)} seconds and was stopped` });
                return GLib.SOURCE_REMOVE;
            });
            proc.communicate_utf8_async(null, null, (_proc, result) => {
                try {
                    const [, out, err] = proc.communicate_utf8_finish(result);
                    finish({ status: proc.get_if_exited() ? proc.get_exit_status() : -1, out: out ?? '', err: err ?? '' });
                } catch (e) {
                    finish(null);
                }
            });
        } catch (e) {
            finish(null);
        }
    });
}

function failure(run: Run | null): { ok: false; reason: GitFailure; message: string } {
    if (!run) return { ok: false, reason: 'no-git', message: 'git cannot be run' };
    // `git commit` reports problems (e.g. "nothing to commit", empty user.name) through stdout or stderr.
    const message = (run.err.trim() || run.out.trim());
    return { ok: false, reason: /not a git repository/i.test(message) ? 'no-repo' : 'failed', message };
}

const dirOf = (file: string) => GLib.path_get_dirname(file);
const nameOf = (file: string) => GLib.path_get_basename(file);

// Commits that touch the file, newest first, following renames. skip/limit for incremental loading.
export async function fileLog(file: string, skip: number, limit: number): Promise<LogResult> {
    const run = await runGit(dirOf(file), [
        'log', '--follow', '--name-only', `--format=${LOG_FORMAT}`, `--skip=${skip}`, '-n', String(limit),
        '--', `:(literal)${nameOf(file)}`,
    ]);
    if (run?.status === 0) return { ok: true, commits: parseLog(run.out) };
    // A new repo with no commits is not a failure; its history is simply empty.
    if (run && /does not have any commits/i.test(run.err)) return { ok: true, commits: [] };
    return failure(run);
}

// File changes in one commit (against its parent commit).
export async function commitDiff(file: string, commit: Commit): Promise<TextResult> {
    const run = await runGit(dirOf(file), [
        'show', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', commit.hash,
        '--', `:(top,literal)${commit.path ?? nameOf(file)}`,
    ]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Full contents of the file at that commit.
export async function commitContent(file: string, commit: Commit): Promise<TextResult> {
    // `./name` is relative to the file's folder; used if the commit path is unknown.
    const spec = commit.path ?? `./${nameOf(file)}`;
    const run = await runGit(dirOf(file), ['show', '--no-textconv', `${commit.hash}:${spec}`]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Commits in the repository of folder `dir` within the time range [since, until) (Unix seconds), newest first.
// For the journal's Activity section; a folder without git or without a repo yields an empty list.
export async function commitsBetween(dir: string, since: number, until: number): Promise<Commit[]> {
    const run = await runGit(dir, ['log', `--since=@${since}`, `--until=@${until - 1}`, `--format=${LOG_FORMAT}`]);
    return run?.status === 0 ? parseLog(run.out).filter(c => c.time >= since && c.time < until) : [];
}

export type WorkingState = 'clean' | 'modified' | 'untracked';

export type StateResult =
    | { ok: true; state: WorkingState }
    | { ok: false; reason: GitFailure; message: string };

// Whether the file differs from the last commit (including staged or untracked ones).
export async function workingState(file: string): Promise<StateResult> {
    const run = await runGit(dirOf(file), ['status', '--porcelain=v1', '--', `:(literal)${nameOf(file)}`]);
    if (run?.status !== 0) return failure(run);
    const line = run.out.split('\n')[0];
    if (!line.trim()) return { ok: true, state: 'clean' };
    return { ok: true, state: line.startsWith('??') ? 'untracked' : 'modified' };
}

export type ChangesResult =
    | { ok: true; changes: FileChange[] }
    | { ok: false; reason: GitFailure; message: string };

// All files in this folder's repository that differ from the last commit; paths are absolute.
export async function repoChanges(dir: string): Promise<ChangesResult> {
    const root = await runGit(dir, ['rev-parse', '--show-toplevel']);
    if (root?.status !== 0) return failure(root);
    const run = await runGit(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (run?.status !== 0) return failure(run);
    const top = root.out.trim();
    return { ok: true, changes: parseStatus(run.out).map(c => ({ ...c, path: GLib.build_filenamev([top, c.path]) })) };
}

// Subjects of the repository's latest commits, newest first; empty without git, a repo, or commits.
// For the assistant that writes a commit message in the same style.
export async function recentSubjects(file: string, limit: number): Promise<string[]> {
    const run = await runGit(dirOf(file), ['log', '--no-merges', '--format=%s', '-n', String(limit)]);
    return run?.status === 0 ? run.out.split('\n').filter(Boolean) : [];
}

// Uncommitted changes of the file, against HEAD. A new (untracked) file is shown
// entirely as additions; a repo with no commits is compared with the index.
export async function workingDiff(file: string): Promise<TextResult> {
    const state = await workingState(file);
    if (!state.ok) return state;
    if (state.state === 'clean') return { ok: true, text: '' };
    const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
    const spec = `:(literal)${nameOf(file)}`;
    if (state.state === 'untracked') {
        // --no-index exits with status 1 if there is a difference; that is a normal result.
        const run = await runGit(dirOf(file), ['diff', ...flags, '--no-index', '--', '/dev/null', nameOf(file)]);
        return run && run.status <= 1 ? { ok: true, text: run.out } : failure(run);
    }
    let run = await runGit(dirOf(file), ['diff', ...flags, 'HEAD', '--', spec]);
    if (run && run.status !== 0 && /unknown revision|bad revision|ambiguous argument 'HEAD'/i.test(run.err)) {
        run = await runGit(dirOf(file), ['diff', ...flags, '--cached', '--', spec]);
    }
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Commit only this file; changes to other staged files are not included. A new file is added
// first because `git commit -- path` rejects untracked paths.
export async function commitFile(file: string, message: string): Promise<TextResult> {
    const spec = `:(literal)${nameOf(file)}`;
    const add = await runGit(dirOf(file), ['add', '--', spec]);
    if (add?.status !== 0) return failure(add);
    const run = await runGit(dirOf(file), ['commit', '--only', '--no-verify', '-m', message, '--', spec]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Commit several files at once (absolute paths); other staged files are not included. Paths are computed from
// the repo root because the files' folders can differ.
export async function commitFiles(files: string[], message: string): Promise<TextResult> {
    if (!files.length) return { ok: false, reason: 'failed', message: 'No files selected' };
    const dir = dirOf(files[0]);
    const root = await runGit(dir, ['rev-parse', '--show-toplevel']);
    if (root?.status !== 0) return failure(root);
    const top = root.out.trim();
    const specs = files.map(f => `:(top,literal)${f.startsWith(top + '/') ? f.slice(top.length + 1) : f}`);
    const add = await runGit(dir, ['add', '--all', '--', ...specs]);
    if (add?.status !== 0) return failure(add);
    const run = await runGit(dir, ['commit', '--only', '--no-verify', '-m', message, '--', ...specs]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Agent Git tool pathspec: Markdown files only, no dot files/folders or node_modules, relative to the work folder.
const AGENT_SPECS = ['*.md', '*.markdown', '*.mdown', '*.mkd', ':(exclude,glob)**/.*', ':(exclude,glob)**/.*/**', ':(exclude,glob)**/node_modules/**'];
const AGENT_DATE = '--date=format:%Y-%m-%d %H:%M';

// Runs a request already validated by agent/gittools.ts (hash/HEAD~n and relative Markdown path) in the work folder.
export async function agentGit(root: string, request: GitRequest): Promise<GitAnswer> {
    const specs = request.file ? [`:(literal)${request.file}`] : AGENT_SPECS;
    let args: string[];
    if (request.kind === 'log') {
        args = ['log', '--relative', '--no-color', AGENT_DATE, '--name-status', `--format=${AGENT_LOG_FORMAT}`, '-n', String(request.limit),
            ...(request.file ? ['--follow'] : []), '--', ...specs];
    } else if (request.kind === 'show') {
        args = ['show', '--relative', '--no-color', '--no-ext-diff', '--no-textconv', AGENT_DATE, '--format=%h %ad · %an · %s', request.commit, '--', ...specs];
    } else {
        args = ['show', '--no-textconv', `${request.commit}:./${request.file}`];
    }
    const run = await runGit(root, args);
    if (run?.status === 0) return { ok: true, text: run.out };
    if (run && request.kind === 'log' && /does not have any commits/i.test(run.err)) return { ok: true, text: '' };
    return { ok: false, message: failure(run).message };
}
