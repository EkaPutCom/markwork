// Writes a commit message for the checked files with the model. It only reads: the files' diffs against the
// last commit and the repository's recent commit subjects. The message lands in the commit box, where the
// user reviews it; nothing is committed here. Git and the key come in through CommitSources.

import type { Cancellable } from '../base/cancel.js';
import type { KeyStore } from './apikey.js';
import type { ChatMessage, Provider } from './provider.js';

export interface FileDiff { name: string; diff: string }

// Characters of diff sent at most. A message needs the gist, not the whole book; this keeps a large change
// cheap and fast. Changeable by tests.
export const commitLimits = { diffChars: 30000, subjects: 10 };

// Shares the budget out fairly: small diffs are sent whole, and the largest ones are cut so the total fits.
// Order is kept. shortened = at least one diff was cut.
export function fitDiffs(diffs: FileDiff[], budget: number): { diffs: FileDiff[]; shortened: boolean } {
    const sizes = diffs.map(d => d.diff.length);
    const share = new Map<number, number>();
    let left = budget;
    const order = sizes.map((size, i) => i).sort((a, b) => sizes[a] - sizes[b]);
    order.forEach((i, n) => {
        const fair = Math.floor(left / (order.length - n));
        share.set(i, Math.min(sizes[i], fair));
        left -= share.get(i)!;
    });
    const fitted = diffs.map((d, i) => share.get(i)! >= sizes[i] ? d : { name: d.name, diff: cut(d.diff, share.get(i)!) });
    return { diffs: fitted, shortened: fitted.some((d, i) => d !== diffs[i]) };
}

// Whole lines up to the limit, then how many were left out.
function cut(diff: string, limit: number): string {
    const kept = diff.slice(0, limit);
    const end = kept.lastIndexOf('\n');
    const head = end > 0 ? kept.slice(0, end) : kept;
    const omitted = diff.slice(head.length).split('\n').filter(Boolean).length;
    return `${head}\n… (${omitted} more lines not shown)`;
}

const SYSTEM = [
    'You write git commit messages for a personal repository of notes and documents.',
    'Reply with the message only: one line, at most 72 characters, in the imperative mood, saying what changed in the content (for example "Move the public release to 22 November"), not "Update plan.md".',
    'Write in the language of the recent commit messages; if there are none, in the language of the changed text.',
    'Follow their style (capitalization, prefixes such as "docs:"). No quotes, no trailing period, no explanation.',
].join(' ');

export function commitPrompt(diffs: FileDiff[], subjects: string[], shortened: boolean): ChatMessage[] {
    const recent = subjects.length ? subjects.map(s => `- ${s}`).join('\n') : '(none yet)';
    const changes = diffs.map(d => `### ${d.name}\n${d.diff.trimEnd() || '(no text changes)'}`).join('\n\n');
    const note = shortened ? '\n\nSome diffs were shortened; describe the change from what is shown.' : '';
    return [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Recent commit messages:\n${recent}\n\nChanges to commit:\n\n${changes}${note}` },
    ];
}

// The model's answer as a commit subject: the first line with text, without code fences, a label, quotes, or a
// trailing period. Also used on the partial answer while it streams.
export function cleanMessage(text: string): string {
    const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('```')) ?? '';
    return line
        .replace(/^(commit message|message)\s*:\s*/i, '')
        .replace(/^["'`“”]+|["'`“”]+$/g, '')
        .replace(/(?<!\.)\.$/, '')
        .trim();
}

export interface CommitSources {
    keyStore: KeyStore;
    makeProvider: (key: string) => Provider;
    model: () => string;
    diff: (file: string) => Promise<{ ok: true; text: string } | { ok: false; message: string }>;
    subjects: (file: string, limit: number) => Promise<string[]>;
}

export type WriteResult =
    | { ok: true; message: string; shortened: boolean; cancelled: boolean }
    | { ok: false; reason: 'no-key' | 'failed'; message: string };

// onText gets the cleaned message so far each time more of it streams in.
export async function writeCommitMessage(sources: CommitSources, files: string[], onText: (message: string) => void,
    cancellable?: Cancellable): Promise<WriteResult> {
    const found = await sources.keyStore.get();
    if (!found) return { ok: false, reason: 'no-key', message: 'There is no DeepSeek API key yet' };
    // One unreadable diff (e.g. a file whose folder is gone) does not stop the rest; all of them failing does.
    const read = await Promise.all(files.map(f => sources.diff(f)));
    const failed = read.find(r => !r.ok);
    if (failed && !failed.ok && read.every(r => !r.ok)) return { ok: false, reason: 'failed', message: failed.message };
    const labels = names(files);
    const diffs = read.map((r, i) => ({ name: labels[i], diff: r.ok ? r.text : '(the changes could not be read)' }));
    const fitted = fitDiffs(diffs, commitLimits.diffChars);
    const subjects = await sources.subjects(files[0], commitLimits.subjects);
    let answer = '';
    try {
        const result = await sources.makeProvider(found.key).chat({
            model: sources.model(), thinking: false, cancellable,
            messages: commitPrompt(fitted.diffs, subjects, fitted.shortened),
            onText: delta => { answer += delta; onText(cleanMessage(answer)); },
        });
        return { ok: true, message: cleanMessage(answer), shortened: fitted.shortened, cancelled: result.cancelled };
    } catch (e) {
        return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
}

// Paths relative to the files' common folder, so two files with the same name in different folders stay apart.
export function names(files: string[]): string[] {
    const dirs = files.map(f => f.split('/').slice(0, -1));
    let common = dirs[0]?.length ?? 0;
    for (const dir of dirs) while (common > 0 && dir.slice(0, common).join('/') !== dirs[0].slice(0, common).join('/')) common--;
    return files.map(f => f.split('/').slice(common).join('/'));
}
