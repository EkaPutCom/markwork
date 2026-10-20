// Parses git output (history and diffs) into data. Pure, no calls to git, so it is easy to test; the caller is in git.ts.

export interface Commit {
    hash: string;
    short: string;
    author: string;
    time: number;          // seconds since the epoch
    subject: string;
    path: string | null;   // file path in this commit relative to the repo root (changes if the file was ever renamed)
}

// Record and field separators that cannot appear in a commit message.
export const LOG_FORMAT = '%x1e%H%x1f%h%x1f%an%x1f%at%x1f%s';

// Output of `git log --name-only --format=LOG_FORMAT`: each commit starts with \x1e,
// its first line is the commit fields, the rest are file names.
export function parseLog(output: string): Commit[] {
    const commits: Commit[] = [];
    for (const record of output.split('\x1e')) {
        if (!record.trim()) continue;
        const [head, ...rest] = record.split('\n');
        const [hash, short, author, time, ...subject] = head.split('\x1f');
        if (!hash || !short) continue;
        const path = rest.find(line => line.trim() !== '') ?? null;
        // Paths with special characters are quoted by git (start with "); do not use them raw.
        commits.push({
            hash, short, author, time: Number(time) || 0, subject: subject.join('\x1f'),
            path: path && !path.startsWith('"') ? path : null,
        });
    }
    return commits;
}

const MINUTE = 60, HOUR = 3600, DAY = 86400;

// "3 days ago", "2 months ago", ...
export function relativeTime(time: number, now: number): string {
    const diff = Math.max(0, now - time);
    if (diff < MINUTE) return 'just now';
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
    if (diff < DAY) return `${Math.floor(diff / HOUR)} hr ago`;
    if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
    if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))} wk ago`;
    if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} mo ago`;
    return `${Math.floor(diff / (365 * DAY))} yr ago`;
}

export type DiffKind = 'add' | 'del' | 'hunk' | 'context';

export interface DiffLine { kind: DiffKind; text: string }

// Output of `git show` for one file → typed lines. The diff header (diff --git, index,
// ---, +++) is dropped; its content is already in the window title, so it only gets in the way of reading.
export function parseDiff(output: string): DiffLine[] {
    const lines = output.replace(/\n$/, '').split('\n');
    const firstHunk = lines.findIndex(line => line.startsWith('@@'));
    const body = firstHunk < 0 ? [] : lines.slice(firstHunk);
    return body.map(text => {
        if (text.startsWith('@@')) return { kind: 'hunk', text };
        if (text.startsWith('+')) return { kind: 'add', text };
        if (text.startsWith('-')) return { kind: 'del', text };
        return { kind: 'context', text };
    });
}

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface FileChange { path: string; kind: ChangeKind }   // path relative to the repo root

// Paths containing a tab, quote, or backslash are quoted by git ("..." with C escapes).
function unquote(path: string): string {
    if (!path.startsWith('"') || !path.endsWith('"')) return path;
    return path.slice(1, -1).replace(/\\([tn"\\])/g, (_m, c: string) => ({ t: '\t', n: '\n' })[c] ?? c);
}

// Output of `git status --porcelain=v1` (without -z: process output is read as a UTF-8 string):
// "XY path", and for rename/copy "XY old -> new".
export function parseStatus(output: string): FileChange[] {
    const changes: FileChange[] = [];
    for (const line of output.split('\n')) {
        if (line.length < 4) continue;
        const code = line.slice(0, 2);
        let path = line.slice(3);
        let kind: ChangeKind = 'modified';
        if (code === '??') kind = 'untracked';
        else if (code.includes('R') || code.includes('C')) {
            kind = 'renamed';
            const arrow = path.lastIndexOf(' -> ');
            if (arrow >= 0) path = path.slice(arrow + 4);
        } else if (code.includes('D')) kind = 'deleted';
        else if (code.includes('A')) kind = 'added';
        changes.push({ path: unquote(path), kind });
    }
    return changes;
}

// The agent's read-only Git requests (validated in agent/gittools.ts, run by git.ts) and their answers.
export type GitRequest =
    | { kind: 'log'; file: string | null; limit: number }
    | { kind: 'show'; commit: string; file: string | null }
    | { kind: 'file'; commit: string; file: string };

export type GitAnswer = { ok: true; text: string } | { ok: false; message: string };

// The `git log` record format for the agent: record separator \x1e and field separator \x1f, then --name-status lines.
// agent/gittools.ts parses it back in formatGit().
export const AGENT_LOG_FORMAT = '%x1e%h%x1f%ad%x1f%an%x1f%s';
