// Tests for changes proposed by the agent: proposal validation, diff preview, and the approval flow in a session.
// Without a GUI and without a network.

import { buildContext, type ContextInput, type SourceFile } from '../../src/agent/context.js';
import { cleanNewName, CHANGE_TOOLS, diffPreview, planChange, unifiedDiff, type Change } from '../../src/agent/changes.js';
import { ChatSession, type ProposalResult, type ToolStep } from '../../src/agent/session.js';
import { describeCall } from '../../src/agent/tools.js';
import type { ChatRequest, ChatResult, Provider } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

const PLAN = '# Plan\n\n- First draft: October\n- Revision: November\n\n## Notes\n\nNone yet.\n';
const files: SourceFile[] = [{ name: 'plan.md', text: PLAN }, { name: 'research/harbor.md', text: '# Harbor\n\nThere are two piers.\n' }];

const BOARD = '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Write report #important\n  report note\n- [ ] Send invitations [due:: 2026-10-20]\n\n## In Progress\n\n- [ ] Harbor research\n\n## Done\n\n- [x] Book venue\n';
const kfiles: SourceFile[] = [...files, { name: 'board.md', text: BOARD }];
const kanban = (args: object) => planChange('edit_kanban', JSON.stringify({ name: 'board', reason: 'x', ...args }), kfiles);
const kanbanAfter = (args: object): string => { const r = kanban(args); if (!r.ok) throw new Error(r.message); return r.change.after; };

const plan = (name: string, args: object, over: SourceFile[] = files) => planChange(name, JSON.stringify(args), over);

export function changeTests(): void {
    section('Agent: change proposals');

    test('tool and kanban action names never reach inherited object properties', () => {
        for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
            const r = plan(name, { name: 'plan', reason: 'x' });
            ok(!r.ok && r.summary === 'unknown tool', `${name}: ${JSON.stringify(r)}`);
            const k = kanban({ action: name });
            ok(!k.ok && k.summary === 'invalid action', `action ${name}: ${JSON.stringify(k)}`);
        }
    });

    test('edit_file: replaces one exact piece and produces the new contents', () => {
        const r = plan('edit_file', { name: 'plan', old_text: '- Revision: November', new_text: '- Revision: December', reason: 'schedule shifted' });
        ok(r.ok, 'rejected');
        if (!r.ok) return;
        eq(r.change.kind, 'edit');
        eq(r.change.file, 'plan.md');
        eq(r.change.before, PLAN);
        eq(r.change.after, PLAN.replace('November', 'December'));
        eq(r.change.reason, 'schedule shifted');
    });

    test('edit_file: text does not match, is not unique, is the same, or the file does not exist → message for the model', () => {
        const bad = (args: object) => { const r = plan('edit_file', { reason: 'x', new_text: 'y', ...args }); ok(!r.ok, 'should have failed'); return r.ok ? '' : r.message; };
        contains(bad({ name: 'plan.md', old_text: 'not in the file' }), 'not found');
        contains(bad({ name: 'plan.md', old_text: 'a' }), 'times');
        contains(bad({ name: 'plan.md', old_text: 'October', new_text: 'October' }), 'same');
        contains(bad({ name: 'chapter-9.md', old_text: 'x' }), 'not found');
        contains(bad({ name: 'plan.md', old_text: '' }), 'required');
        contains(planChange('edit_file', '{broken', files).ok ? '' : (planChange('edit_file', '{broken', files) as { message: string }).message, 'not a valid JSON');
    });

    test('edit_file: an empty new_text deletes the piece', () => {
        const r = plan('edit_file', { name: 'plan.md', old_text: '\n## Notes\n\nNone yet.\n', new_text: '', reason: 'clean' });
        ok(r.ok, "proposal rejected");
        if (r.ok) eq(r.change.after, '# Plan\n\n- First draft: October\n- Revision: November\n');
    });

    test('create_file: a new file with .md and a trailing newline; a taken or unsafe name is rejected', () => {
        const r = plan('create_file', { name: 'tasks/week-1', content: '# Week 1', reason: 'task list' });
        ok(r.ok, "proposal rejected");
        if (r.ok) { eq(r.change.kind, 'create'); eq(r.change.file, 'tasks/week-1.md'); eq(r.change.after, '# Week 1\n'); eq(r.change.before, ''); }
        for (const name of ['plan.md', 'PLAN', '../outside.md', '/etc/x.md', '.markwork/x.md', 'a//b.md', 'a\\b.md', '']) {
            ok(!plan('create_file', { name, content: 'x', reason: 'x' }).ok, `accepted: "${name}"`);
        }
        ok(!plan('create_file', { name: 'empty.md', content: '  ', reason: 'x' }).ok, 'empty content accepted');
        eq(cleanNewName('./notes.markdown'), 'notes.markdown');
    });

    test('diffPreview: context, removal, addition, and truncation', () => {
        const r = plan('edit_file', { name: 'plan.md', old_text: '- Revision: November', new_text: '- Revision: December', reason: 'x' });
        if (!r.ok) throw new Error('proposal failed');
        const d = diffPreview(r.change.before, r.change.after);
        eq([d.added, d.removed], [1, 1]);
        eq(d.lines.filter(l => l.sign === '-').map(l => l.text), ['- Revision: November']);
        eq(d.lines.filter(l => l.sign === '+').map(l => l.text), ['- Revision: December']);
        ok(d.lines.some(l => l.sign === ' ' && l.text === '- First draft: October'), 'no context');
        const created = diffPreview('', 'a\nb\n');
        eq([created.added, created.removed], [2, 0]);
        const big = diffPreview('', Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
        eq(big.added, 200);
        ok(big.lines.length <= 61, `too long: ${big.lines.length}`);
        eq(big.lines[big.lines.length - 1].sign, '…');
    });

    test('unifiedDiff: git-style hunks with three context lines and the right line numbers', () => {
        const r = plan('edit_file', { name: 'plan.md', old_text: '- Revision: November', new_text: '- Revision: December', reason: 'x' });
        if (!r.ok) throw new Error('proposal failed');
        eq(unifiedDiff(r.change.before, r.change.after), [
            '@@ -1,6 +1,6 @@', ' # Plan', ' ', ' - First draft: October', '-- Revision: November', '+- Revision: December', ' ', ' ## Notes', ' ',
        ].join('\n').replace('@@ -1,6 +1,6 @@', '@@ -1,7 +1,7 @@'));
        eq(unifiedDiff('', 'a\nb\n'), '@@ -0,0 +1,2 @@\n+a\n+b');
        eq(unifiedDiff('x\n', 'x\n'), '');
    });

    test('edit_kanban: add a card at the end of a list, only that line changes', () => {
        const after = kanbanAfter({ action: 'add', card: 'Arrange schedule #plan', list: 'in progress' });
        eq(after, BOARD.replace('- [ ] Harbor research\n', '- [ ] Harbor research\n- [ ] Arrange schedule #plan\n'));
        const r = kanban({ action: 'add', card: 'Arrange schedule', list: 'In Progress' });
        ok(r.ok && r.change.kind === 'edit' && r.change.file === 'board.md', 'wrong proposal shape');
    });

    test('edit_kanban: move a card to the end of another list and mark done/not done', () => {
        const moved = kanbanAfter({ action: 'move', card: 'harbor research', list: 'Done' });
        eq(moved, BOARD.replace('## In Progress\n\n- [ ] Harbor research\n\n', '## In Progress\n\n').replace('- [x] Book venue\n', '- [x] Book venue\n- [ ] Harbor research\n'));
        const done = kanbanAfter({ action: 'mark', card: 'invitations', done: true });
        contains(done, '- [x] Send invitations [due:: 2026-10-20]');
        contains(kanbanAfter({ action: 'mark', card: 'Book venue', done: false }), '- [ ] Book venue');
        contains(kanbanAfter({ action: 'mark', card: 'report', done: true }), '  report note');   // card notes stay
    });

    test('the diff separates distant changes: moving a card does not mark other lists as changed', () => {
        const after = kanbanAfter({ action: 'move', card: 'Send invitations', list: 'Done' });
        const d = diffPreview(BOARD, after);
        eq([d.added, d.removed], [1, 1]);
        const u = unifiedDiff(BOARD, after);
        eq(u.split('\n').filter(l => l.startsWith('@@')).length, 2);
        eq(u.split('\n').filter(l => /^[-+]/.test(l)), ['-- [ ] Send invitations [due:: 2026-10-20]', '+- [ ] Send invitations [due:: 2026-10-20]']);
        ok(!u.includes('-## In Progress') && !u.includes('-- [ ] Harbor'), 'an unchanged part was marked too');
        eq(unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n').split('\n').filter(l => l.startsWith('@@')), ['@@ -1,5 +1,5 @@', '@@ -8,5 +8,5 @@']);
    });

    test('edit_kanban: clear errors for the model (not a board, list/card does not match, no change)', () => {
        const bad = (args: object, base = kanban): string => { const r = base(args); ok(!r.ok, 'should have failed'); return r.ok ? '' : r.message; };
        contains(bad({ action: 'add', card: 'x', list: 'Plan', name: 'plan.md' }), 'not a board');
        contains(bad({ action: 'add', card: 'x', list: 'Postponed' }), 'Lists on the board: Plan, In Progress, Done');
        contains(bad({ action: 'add', card: 'x', list: '' }), '"list" argument is required');
        contains(bad({ action: 'move', card: 'nonexistent', list: 'Done' }), 'No card contains');
        contains(bad({ action: 'move', card: 'a', list: 'Done' }), 'matches');   // many cards contain "a"
        contains(bad({ action: 'move', card: 'Book venue', list: 'Done' }), 'already in that list');
        contains(bad({ action: 'mark', card: 'Book venue', done: true }), 'already has that status');
        contains(bad({ action: 'mark', card: 'Book venue' }), '"done"');
        contains(bad({ action: 'archive', card: 'Book venue' }), 'must be one of');
        contains(bad({ action: 'add', card: 'line\nbreak', list: 'Plan' }), 'single line');
        contains(bad({ action: 'add', card: '', list: 'Plan' }), 'required');
    });

    test('describeCall for change tools', () => {
        eq(describeCall('create_file', '{"name":"a.md"}'), 'Proposing new file a.md');
        eq(describeCall('edit_file', '{"name":"a.md"}'), 'Proposing changes to a.md');
        eq(describeCall('edit_kanban', '{"name":"board.md"}'), 'Proposing changes to board board.md');
    });

    section('Agent: change approval in a session');

    const input = (over: Partial<ContextInput> = {}): Omit<ContextInput, 'recent'> => ({
        question: 'Move the revision to December', active: null, selection: '', files, mentions: [],
        options: { activeDocument: true, selection: true, project: true }, budget: 48_000, ...over,
    });
    const base = { onContext: () => {}, onText: () => {}, onReasoning: () => {} };
    const result = (over: Partial<ChatResult> = {}): ChatResult => ({ usage: { prompt: 10, cached: 0, completion: 2 }, cancelled: false, toolCalls: [], reasoning: '', ...over });
    const EDIT = JSON.stringify({ name: 'plan.md', old_text: '- Revision: November', new_text: '- Revision: December', reason: 'user request' });

    // A provider that proposes one change and then answers; it stores the tool results it saw.
    const proposing = (calls: ChatRequest[], toolResults: string[], args = EDIT, name = 'edit_file'): Provider => ({
        async chat(req) {
            calls.push(req);
            const last = req.messages[req.messages.length - 1];
            if (last.role === 'tool') toolResults.push(last.content);
            if (calls.length === 1) return result({ toolCalls: [{ id: 'p1', name, arguments: args }] });
            req.onText('Done.');
            return result();
        },
    });

    test('without onProposal the agent is not given change tools and the prompt stays read-only', () => {
        const calls: ChatRequest[] = [];
        settle(new ChatSession().ask(input(), proposing(calls, []), 'm', base));
        const names = calls[0].tools!.map(t => t.name);
        ok(!names.includes('edit_file') && !names.includes('create_file'), names.join(','));
        contains(calls[0].messages[0].content as string, 'You cannot change files');
        // The model still tries to call it: rejected as an unknown tool, nothing is written.
        const results: string[] = [];
        settle(new ChatSession().ask(input(), proposing([], results), 'm', base));
        contains(results[0], 'not recognized');
    });

    test('approved: the handler receives the diff, the result goes back to the model, the new contents are visible in the next round', () => {
        const calls: ChatRequest[] = [];
        const results: string[] = [];
        const seen: Change[] = [];
        const steps: ToolStep[] = [];
        const r = settle(new ChatSession().ask(input(), proposing(calls, results), 'm', {
            ...base,
            onTool: s => steps.push({ ...s }),
            onProposal: async change => { seen.push(change); return { applied: true }; },
        }));
        eq(seen.length, 1);
        eq(seen[0].after, PLAN.replace('November', 'December'));
        contains(results[0], 'approved by the user and has been applied');
        eq(r.applied, 1);
        eq(r.toolCalls, 0);   // the "lookups" count does not include it
        eq(steps.map(s => s.summary), ['', 'applied']);
        contains(steps[0].label, 'Edit plan.md');
        const names = calls[0].tools!.map(t => t.name);
        ok(names.includes('edit_file') && names.includes('create_file'), names.join(','));
        const system = calls[0].messages[0].content as string;
        contains(system, 'create_file');
        ok(!system.includes('You cannot change files'), 'the read-only rule is still there');
    });

    test('rejected or failed to apply: the model is told and no change is counted', () => {
        for (const [answer, expected, summary] of [
            [{ applied: false }, 'rejected', 'rejected'],
            [{ applied: false, error: 'file changed' }, 'failed to apply: file changed', 'failed to apply'],
        ] as [ProposalResult, string, string][]) {
            const results: string[] = [];
            const steps: ToolStep[] = [];
            const r = settle(new ChatSession().ask(input(), proposing([], results), 'm', { ...base, onTool: s => steps.push({ ...s }), onProposal: async () => answer }));
            contains(results[0], expected);
            eq(r.applied, 0);
            eq(steps[steps.length - 1].summary, summary);
        }
    });

    test('an invalid proposal does not reach the handler; the model gets the reason', () => {
        const results: string[] = [];
        let asked = 0;
        const bad = JSON.stringify({ name: 'plan.md', old_text: 'nonexistent', new_text: 'x', reason: 'x' });
        settle(new ChatSession().ask(input(), proposing([], results, bad), 'm', { ...base, onProposal: async () => { asked++; return { applied: true }; } }));
        eq(asked, 0);
        contains(results[0], 'not found');
    });

    test('create_file followed by edit_file on that file in one turn uses the new contents', () => {
        const results: string[] = [];
        let round = 0;
        const provider: Provider = {
            async chat(req) {
                const last = req.messages[req.messages.length - 1];
                if (last.role === 'tool') results.push(last.content);
                round++;
                if (round === 1) return result({ toolCalls: [{ id: 'a', name: 'create_file', arguments: JSON.stringify({ name: 'new.md', content: '# New\n\nOne.', reason: 'x' }) }] });
                if (round === 2) return result({ toolCalls: [{ id: 'b', name: 'edit_file', arguments: JSON.stringify({ name: 'new.md', old_text: 'One.', new_text: 'Two.', reason: 'x' }) }] });
                req.onText('ok');
                return result();
            },
        };
        const edits: Change[] = [];
        const r = settle(new ChatSession().ask(input(), provider, 'm', { ...base, onProposal: async c => { edits.push(c); return { applied: true }; } }));
        eq(r.applied, 2);
        eq(edits[1].before, '# New\n\nOne.\n');
        eq(edits[1].after, '# New\n\nTwo.\n');
    });

    test('the project option is off: no tools, even though a handler exists', () => {
        const calls: ChatRequest[] = [];
        settle(new ChatSession().ask(input({ options: { activeDocument: true, selection: true, project: false } }), proposing(calls, []), 'm', { ...base, onProposal: async () => ({ applied: true }) }));
        eq(calls[0].tools, undefined);
    });

    test('instructions: the proposal section only exists if allowed', () => {
        const on = buildContext({ ...input(), recent: [], canPropose: true }).system;
        const off = buildContext({ ...input(), recent: [] }).system;
        contains(on, 'edit_file');
        ok(!off.includes('edit_file'), 'proposal instructions present without permission');
        eq(CHANGE_TOOLS.map(t => t.name), ['create_file', 'edit_file', 'insert_text', 'delete_file', 'move_file', 'edit_kanban']);
    });
}
