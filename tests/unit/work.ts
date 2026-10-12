import { TemporaryProviderError, requestWithRetry, compactHistory } from '../../src/agent/recovery.js';
import { reconcileEvents, type ActionEvent } from '../../src/agent/journal.js';
import { verifyWork } from '../../src/agent/verification.js';
import { planBatch, applyBatch } from '../../src/agent/batch.js';
import { parseWork, workText } from '../../src/agent/work.js';
import { parseChat, serializeChat } from '../../src/agent/transcript.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

export function workTests(): void {
    section('Agent: saved work');
    test('a plan checkpoint is restored as paused after the process stops', () => {
        const work = parseWork(JSON.stringify({ goal: 'Sync the schedule', steps: [{ text: 'Read the meeting', status: 'done' }, { text: 'Change the plan', status: 'pending' }], note: 'New date is November 22' }));
        ok(work, 'plan rejected');
        if (!work) return;
        const chat = parseChat(serializeChat({ title: 'Schedule', model: 'm', created: '2026-10-05', turns: [], work }));
        eq(chat?.work?.status, 'paused');
        eq(chat?.work?.steps, work.steps);
        contains(workText(work), '[x] Read the meeting');
    });
    test('a batch merges chained changes and rejects a single broken action without a partial result', () => {
        const actions = [{ tool: 'edit_file', arguments: JSON.stringify({ name: 'a.md', old_text: 'old', new_text: 'new', reason: 'schedule' }) },
            { tool: 'edit_file', arguments: JSON.stringify({ name: 'a.md', old_text: 'new', new_text: 'final', reason: 'tidy up' }) }];
        const p = planBatch(JSON.stringify({ actions }), [{ name: 'a.md', text: 'old' }]);
        eq(p.changes.map(c => [c.before, c.after]), [['old', 'final']]);
        actions[1].arguments = '{}';
        eq(planBatch(JSON.stringify({ actions }), [{ name: 'a.md', text: 'old' }]).changes, []);
    });
    test('batch preflight rejects conflicts before writing and restores when a write fails', () => {
        const p = planBatch(JSON.stringify({ actions: ['a', 'b'].map(n => ({ tool: 'edit_file', arguments: JSON.stringify({ name: n + '.md', old_text: 'old', new_text: 'new', reason: 'x' }) })) }), ['a', 'b'].map(n => ({ name: n + '.md', text: 'old' })));
        const disk = new Map([['a.md', 'old'], ['b.md', 'conflict']]);
        let writes = 0;
        const host = { read: (f: string) => disk.get(f) ?? null, write: (c: any) => { writes++; if (c.file === 'b.md') throw Error('disk full'); disk.set(c.file, c.after); }, rollback: (c: any) => { disk.set(c.file, c.before); } };
        contains(applyBatch(p.changes, host) ?? '', 'cancelled');
        eq(writes, 0);
        disk.set('b.md', 'old');
        contains(applyBatch(p.changes, host) ?? '', 'restored');
        eq([...disk.values()], ['old', 'old']);
    });
    test('verification checks the actual contents, missing files, and note group/status', () => {
        const files = [{ name: 'plan.md', text: 'Release November 22' }, { name: 'board.md', text: '---\nlayout: board\n---\n\n## Done\n\n- [x] Release material\n' }];
        const checks = [{ file: 'plan.md', text: 'November 22', kind: 'present' }, { file: 'plan.md', text: 'November 15', kind: 'absent' }, { file: 'board.md', text: 'Release material', kind: 'note', group: 'Done', done: true }];
        eq(verifyWork(JSON.stringify({ checks }), files).passed, true);
        eq(verifyWork(JSON.stringify({ checks }), files.slice(1)).passed, false);
        checks[2].group = 'Plan';
        eq(verifyWork(JSON.stringify({ checks }), files).passed, false);
        eq(verifyWork('{', files).passed, false);
    });
    test('the journal stores the diff and decisions; an interruption is recovered from the actual contents without writing', () => {
        const event: ActionEvent = { id: '1', question: 'Change the schedule', tool: 'edit_file', status: 'proposed', changes: [{ kind: 'edit', file: 'a.md', before: 'old', after: 'new', reason: 'meeting' }], summary: '', time: '2026-10-05' };
        const saved = parseChat(serializeChat({ title: 'Schedule', model: 'm', created: '2026-10-05', turns: [], events: [event] }));
        eq(saved?.events, [event]);
        reconcileEvents(saved!.events!, [{ name: 'a.md', text: 'new' }]);
        eq(saved?.events?.[0].status, 'applied');
        event.status = 'proposed';
        reconcileEvents([event], [{ name: 'a.md', text: 'old' }]);
        eq(event.status, 'interrupted');
        event.status = 'proposed';
        reconcileEvents([event], [{ name: 'a.md', text: 'conflict' }]);
        eq(event.status, 'failed');
    });
    test('retry is limited and does not repeat output that was already shown', () => {
        let calls = 0;
        const request = { model: 'm', messages: [], onText: (_d: string) => {} };
        const result = { usage: null, cancelled: false, toolCalls: [], reasoning: '' };
        settle(requestWithRetry({ chat: async () => { calls++; if (calls < 3) throw new TemporaryProviderError('temporary'); return result; } }, request, async () => {}));
        eq(calls, 3);
        calls = 0;
        let failed = false;
        try { settle(requestWithRetry({ chat: async r => { calls++; r.onText('partial'); throw new TemporaryProviderError('dropped'); } }, request, async () => {})); } catch { failed = true; }
        eq(calls, 1); eq(failed, true);
        calls = 0;
        try { settle(requestWithRetry({ chat: async () => { calls++; throw Error('key rejected'); } }, request, async () => {})); } catch { /* expected */ }
        eq(calls, 1);
    });
    test('old context is summarized without deleting the source history', () => {
        const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `Turn ${i} ` + 'x'.repeat(500) }));
        const compact = compactHistory(history, 800);
        ok(compact.recent.length < history.length, 'not trimmed');
        contains(compact.summary, 'Turn');
        eq(history.length, 20);
        eq(compact.recent[compact.recent.length - 1], history[19]);
    });
    test('a broken plan and an unknown step status are rejected', () => {
        eq(parseWork('{'), null);
        eq(parseWork(JSON.stringify({ goal: 'x', steps: [{ text: 'x', status: 'complete' }], note: '' })), null);
    });
}
