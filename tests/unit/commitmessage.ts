// Commit message writer tests (agent/commitmessage.ts): pure, with a fake provider and key store.

import { cleanMessage, commitLimits, commitPrompt, fitDiffs, names, writeCommitMessage, type CommitSources } from '../../src/agent/commitmessage.js';
import type { ChatRequest } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, within } from '../framework.js';

export async function commitMessageTests(): Promise<void> {
    section('Commit message writer');

    await test('small diffs are sent whole', async () => {
        const diffs = [{ name: 'a.md', diff: '+one\n' }, { name: 'b.md', diff: '-two\n+2\n' }];
        const fitted = fitDiffs(diffs, 1000);
        eq(fitted.diffs, diffs);
        ok(!fitted.shortened, 'shortened');
    });

    await test('the largest diff is cut to whole lines and the total fits the budget', async () => {
        const big = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n');
        const fitted = fitDiffs([{ name: 'small.md', diff: '+x\n' }, { name: 'big.md', diff: big }], 300);
        ok(fitted.shortened, 'not shortened');
        eq(fitted.diffs[0].diff, '+x\n', 'the small diff was cut');
        const cutText = fitted.diffs[1].diff;
        ok(cutText.length < 360, `length ${cutText.length}`);
        ok(/\n… \(\d+ more lines not shown\)$/.test(cutText), cutText.slice(-60));
        ok(cutText.split('\n').slice(0, -1).every(l => /^\+line \d+$/.test(l)), 'a line was cut in half');
        eq(fitted.diffs.map(d => d.name), ['small.md', 'big.md'], 'order');
    });

    await test('the answer becomes a one-line subject', async () => {
        eq(cleanMessage('Move the release to 22 November.\n\nMore detail'), 'Move the release to 22 November');
        eq(cleanMessage('```\n"Add ideas"\n```'), 'Add ideas');
        eq(cleanMessage('Commit message: `Fix typos`'), 'Fix typos');
        eq(cleanMessage('Wait...'), 'Wait...');
        eq(cleanMessage('  '), '');
    });

    await test('files are named relative to their common folder', async () => {
        eq(names(['/r/notes/plan.md', '/r/notes/ideas.md']), ['plan.md', 'ideas.md']);
        eq(names(['/r/a/x.md', '/r/b/x.md']), ['a/x.md', 'b/x.md']);
        eq(names(['/r/notes/plan.md']), ['plan.md']);
    });

    await test('the prompt holds the diffs and the recent subjects, not other files', async () => {
        const [system, user] = commitPrompt([{ name: 'plan.md', diff: '-15 November\n+22 November\n' }], ['Add a schedule section'], false);
        eq(system.role, 'system');
        contains(system.content, 'one line');
        contains(user.content, '- Add a schedule section');
        contains(user.content, '### plan.md\n-15 November\n+22 November');
        ok(!user.content.includes('shortened'), 'mentions shortening');
        contains(commitPrompt([], [], true)[1].content, '(none yet)');
    });

    const sources = (answer: string[], over: Partial<CommitSources> = {}) => {
        const requests: ChatRequest[] = [];
        const s: CommitSources = {
            keyStore: { get: async () => ({ key: 'k', source: 'env' }), set: async () => 'env', clear: async () => {} },
            makeProvider: () => ({
                async chat(request) {
                    requests.push(request);
                    for (const part of answer) request.onText(part);
                    return { usage: null, cancelled: false, toolCalls: [], reasoning: '' };
                },
            }),
            model: () => 'deepseek-flash',
            diff: async file => ({ ok: true, text: `+change in ${file}\n` }),
            subjects: async () => ['Earlier commit'],
            ...over,
        };
        return { s, requests };
    };

    await test('writing streams the cleaned message and uses the model without thinking or tools', async () => {
        const { s, requests } = sources(['"Move the ', 'release', '"\nextra']);
        const seen: string[] = [];
        const result = await within(writeCommitMessage(s, ['/r/plan.md', '/r/ideas.md'], m => seen.push(m)));
        eq(result, { ok: true, message: 'Move the release', shortened: false, cancelled: false });
        eq(seen, ['Move the', 'Move the release', 'Move the release']);
        eq(requests.length, 1);
        eq(requests[0].model, 'deepseek-flash');
        eq(requests[0].thinking, false);
        ok(!requests[0].tools, 'tools were sent');
        contains(requests[0].messages[1].content, '+change in /r/ideas.md');
    });

    await test('a large change is shortened and reported', async () => {
        const limit = commitLimits.diffChars;
        commitLimits.diffChars = 100;
        try {
            const { s } = sources(['Rewrite'], { diff: async () => ({ ok: true, text: '+x\n'.repeat(200) }) });
            const result = await within(writeCommitMessage(s, ['/r/a.md'], () => {}));
            ok(result.ok && result.shortened, JSON.stringify(result));
        } finally {
            commitLimits.diffChars = limit;
        }
    });

    await test('without a key nothing is sent', async () => {
        const { s, requests } = sources(['x'], { keyStore: { get: async () => null, set: async () => 'env', clear: async () => {} } });
        const result = await within(writeCommitMessage(s, ['/r/a.md'], () => {}));
        eq(result.ok ? '' : result.reason, 'no-key');
        eq(requests.length, 0);
    });

    await test('one unreadable diff does not stop the rest; all of them failing does', async () => {
        const { s, requests } = sources(['Ok'], { diff: async f => f.endsWith('gone.md') ? { ok: false, message: 'no folder' } : { ok: true, text: '+a\n' } });
        ok((await within(writeCommitMessage(s, ['/r/a.md', '/r/gone.md'], () => {}))).ok, 'failed');
        contains(requests[0].messages[1].content, '### gone.md\n(the changes could not be read)');
        const result = await within(writeCommitMessage(s, ['/r/gone.md'], () => {}));
        eq(result.ok ? '' : result.message, 'no folder');
    });

    await test('a provider error becomes a failure with its message', async () => {
        const { s } = sources([], { makeProvider: () => ({ chat: async () => { throw new Error('Cannot connect to DeepSeek'); } }) });
        const result = await within(writeCommitMessage(s, ['/r/a.md'], () => {}));
        eq(result, { ok: false, reason: 'failed', message: 'Cannot connect to DeepSeek' });
    });
}
