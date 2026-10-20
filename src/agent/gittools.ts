// Read-only Git history tools for the model: list commits, the changes of one commit, and the contents of a file at an old commit.
// This module is pure: it validates arguments into a GitRequest and tidies git output. Running git is done by the
// caller (src/base/git.ts through ChatHost), which restricts the pathspec to non-hidden Markdown files in the work folder.

import { cleanNewName } from './changes.js';
import { estimateTokens } from './context.js';
import type { ToolSpec } from './provider.js';
import { plural, type ToolOutcome } from './tools.js';
import type { GitAnswer, GitRequest } from '../base/gitlog.js';

export type { GitAnswer, GitRequest };

export const MAX_GIT_TOKENS = 6000;
const MAX_LOG = 50;

export const GIT_TOOLS: ToolSpec[] = [
    {
        name: 'git_log',
        description: 'List the latest Git commits in the work folder (or for a single file, following renames): hash, date, author, message, and the Markdown files that changed. Use it for questions like "what changed this week" or "when was this date changed". Uncommitted changes are not shown.',
        parameters: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'Limit to one file (optional)' },
                max: { type: 'integer', description: `Number of commits (1–${MAX_LOG}, default 15)` },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'show_commit',
        description: 'Show the changes (diff) to Markdown files in one commit, from a hash in git_log. Can be limited to one file.',
        parameters: {
            type: 'object',
            properties: {
                commit: { type: 'string', description: 'Commit hash (at least 4 characters) or HEAD, HEAD~1, …' },
                file: { type: 'string', description: 'Limit to one file (optional)' },
            },
            required: ['commit'],
            additionalProperties: false,
        },
    },
    {
        name: 'file_at_commit',
        description: 'Read the full contents of a file as it was at a given commit (including files that have since been deleted or moved). The result includes line numbers.',
        parameters: {
            type: 'object',
            properties: {
                commit: { type: 'string', description: 'Commit hash or HEAD, HEAD~1, …' },
                file: { type: 'string', description: 'File path at that commit' },
            },
            required: ['commit', 'file'],
            additionalProperties: false,
        },
    },
];

export const isGitTool = (name: string): boolean => GIT_TOOLS.some(t => t.name === name);

const asString = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

// Hashes and HEAD~n only: nothing starts with "-" so it cannot become a git option.
const COMMIT = /^(?:[0-9a-f]{4,40}|HEAD(?:~\d{1,4}|\^{1,4})?)$/i;

// Errors are returned as strings so the model can fix its arguments.
export function parseGitCall(name: string, rawArguments: string): GitRequest | string {
    const a = parseObject(rawArguments);
    if (!a) return 'The arguments are not a valid JSON object.';
    const rawFile = asString(a.file);
    const file = rawFile ? cleanNewName(rawFile) : null;
    if (rawFile && file !== rawFile) return `File "${rawFile}" is not valid: use a relative Markdown path as in list_files.`;
    if (name === 'git_log') {
        const limit = typeof a.max === 'number' && Number.isFinite(a.max) ? Math.min(Math.max(Math.trunc(a.max), 1), MAX_LOG) : 15;
        return { kind: 'log', file, limit };
    }
    return commitRequest(name, asString(a.commit), file);
}

function parseObject(raw: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
}

// show_commit and file_at_commit: a valid commit reference, and a file for file_at_commit.
function commitRequest(name: string, commit: string, file: string | null): GitRequest | string {
    if (!COMMIT.test(commit)) return `Commit "${commit}" is not valid. Use a hash from git_log or HEAD, HEAD~1, …`;
    if (name === 'show_commit') return { kind: 'show', commit, file };
    if (name === 'file_at_commit') return file ? { kind: 'file', commit, file } : 'The "file" argument is required.';
    return `Tool "${name}" is not recognized.`;
}

const clip = (text: string, hint: string): string =>
    estimateTokens(text) <= MAX_GIT_TOKENS ? text : `${text.slice(0, MAX_GIT_TOKENS * 3)}\n[… truncated; ${hint} …]`;

const STATUS: Record<string, string> = { A: 'new', M: 'edit', D: 'delete', R: 'move', C: 'copy', T: 'edit' };

// Runner output → text for the model and a summary for the interface.
export function formatGit(request: GitRequest, answer: GitAnswer): ToolOutcome {
    if (!answer.ok) {
        const message = /not a git repository/i.test(answer.message) ? 'The work folder is not a Git repository.'
            : /does not have any commits/i.test(answer.message) ? 'The repository has no commits yet.'
            : `git failed: ${answer.message.split('\n')[0].slice(0, 300)}`;
        return { content: message, summary: 'failed' };
    }
    if (request.kind === 'log') {
        const commits = answer.text.split('\x1e').filter(r => r.trim()).map(record => {
            const [head, ...rest] = record.split('\n');
            const [hash, date, author, ...subject] = head.split('\x1f');
            const files = rest.filter(l => l.trim()).map(l => {
                const [code, ...paths] = l.split('\t');
                return `  ${STATUS[code[0]] ?? code} ${paths.join(' → ')}`;
            });
            return [`${hash} ${date} · ${author} · ${subject.join(' ')}`, ...files].join('\n');
        });
        if (!commits.length) return { content: request.file ? `There are no commits for ${request.file} yet.` : 'There are no commits that touch Markdown files in this folder yet.', summary: '0 commits' };
        return { content: clip(commits.join('\n'), 'reduce max or limit to one file'), summary: plural(commits.length, 'commit', 'commits') };
    }
    if (request.kind === 'show') {
        if (!/^diff --git /m.test(answer.text)) return { content: `Commit ${request.commit} does not change Markdown files${request.file ? ` ${request.file}` : ''} in this folder.`, summary: 'no changes' };
        const lines = answer.text.split('\n').filter(l => !/^(index |diff --git |similarity index|dissimilarity index)/.test(l));
        return { content: clip(lines.join('\n'), 'limit to one file'), summary: `${plural(lines.filter(l => /^[+-](?![+-])/.test(l)).length, 'line', 'lines')} changed` };
    }
    const lines = answer.text.replace(/\n$/, '').split('\n');
    const body = lines.map((l, i) => `${i + 1}│ ${l}`).join('\n');
    return { content: clip(`[${request.file} at ${request.commit}, ${lines.length} lines]\n${body}`, 'only the beginning is shown'), summary: plural(lines.length, 'line', 'lines') };
}

export function describeGitCall(request: GitRequest | string, name: string): string {
    if (typeof request === 'string') return name;
    if (request.kind === 'log') return `Viewing Git history${request.file ? ` ${request.file}` : ''}`;
    if (request.kind === 'show') return `Viewing commit ${request.commit}${request.file ? ` (${request.file})` : ''}`;
    return `Reading ${request.file} at ${request.commit}`;
}
