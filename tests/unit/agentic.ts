// A complete-work evaluation with a deterministic provider, a virtual disk, and real checkpoints.
import { WorkspaceRepository } from '../../src/workspace.js';
import { projectPath } from '../../src/agent/path.js';
import { ChatSession, type TurnHandlers } from '../../src/agent/session.js';
import { applyBatch } from '../../src/agent/batch.js';
import { parseChat, serializeChat } from '../../src/agent/transcript.js';
import type { ToolCall, Provider, ChatResult } from '../../src/agent/provider.js';
import type { SourceFile } from '../../src/agent/context.js';
import type { Change } from '../../src/agent/changes.js';
import { platform } from '../../src/platform/index.js';
import { section, test, eq, ok, contains, within, disk } from '../core/framework.js';
import { host } from '../core/host.js';

const call = (name: string, args: unknown): ToolCall => ({ id: name, name, arguments: JSON.stringify(args) });
const result = (toolCalls: ToolCall[] = []): ChatResult => ({ usage: null, cancelled: false, toolCalls, reasoning: '' });
const goal = 'Sync the release date and the board';
const plan = (done: boolean) => call('set_work', { goal, steps: [{ text: 'Sync the plan and the board', status: done ? 'done' : 'pending' }], note: '' });
const batch = call('propose_batch', { actions: [
    { tool: 'edit_file', arguments: JSON.stringify({ name: 'plan.md', old_text: 'November 15', new_text: 'November 22', reason: 'Meeting decision' }) },
    { tool: 'edit_note', arguments: JSON.stringify({ name: 'board.md', action: 'move', note: 'Release material', group: 'In Progress', reason: 'Start working' }) },
] });
const verify = call('verify_work', { checks: [
    { file: 'plan.md', kind: 'present', text: 'November 22' },
    { file: 'plan.md', kind: 'absent', text: 'November 15' },
    { file: 'board.md', kind: 'note', text: 'Release material', group: 'In Progress', done: false },
] });

const initial = (): SourceFile[] => [{ name: 'plan.md', text: '# Plan\nRelease November 15\n' },
    { name: 'board.md', text: '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Release material\n\n## In Progress\n\n' }];

function harness() {
    const disk = new Map(initial().map(f => [f.name, f.text]));
    const session = new ChatSession();
    const files = () => [...disk].map(([name, text]) => ({ name, text }));
    let checkpoint = '', proposals = 0;
    const handlers: TurnHandlers = {
        onContext: () => {}, onText: () => {}, onReasoning: () => {}, currentFiles: files,
        onState: () => { checkpoint = serializeChat({ title: goal, model: 'fake', created: '2026-10-05', turns: session.history, work: session.work, events: session.events }); },
        onProposal: async (c: Change) => { proposals++; disk.set(c.file, c.after); return { applied: true }; },
        onBatchProposal: async changes => {
            proposals++;
            const error = applyBatch(changes, { read: f => disk.get(f) ?? null, write: c => { disk.set(c.file, c.after); }, rollback: c => { if (c.kind === 'create') disk.delete(c.file); else disk.set(c.file, c.before); } });
            return { applied: !error, ...(error ? { error } : {}) };
        },
    };
    const input = () => ({ question: goal, active: null, selection: '', files: files(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 });
    const run = (steps: ToolCall[][], failAtEnd = false) => {
        let n = 0;
        const provider: Provider = { chat: async req => {
            if (n < steps.length) return result(steps[n++]);
            if (failAtEnd) throw Error('connection dropped');
            req.onText('The result has been checked.'); return result();
        } };
        return within(session.ask(input(), provider, 'fake', handlers));
    };
    return { session, disk, handlers, input, run, checkpoint: () => checkpoint, proposals: () => proposals };
}

export async function agenticTests(): Promise<void> {
    section('Agent evaluation: work through to a verified result');
    await test('the folder boundary rejects creating files through a symlink', async () => {
        const root = host().makeTempDir();
        const outside = host().makeTempDir();
        const link = disk.join(root, 'link');
        try {
            host().symlink(outside, link);
            let rejected = false;
            try { projectPath(root, 'link/new.md'); } catch { rejected = true; }
            eq(rejected, true);
            eq(projectPath(root, 'notes/new.md'), disk.join(root, 'notes', 'new.md'));
        } finally { disk.remove(link); disk.remove(root); disk.remove(outside); }
    });
    await test('verification re-reads a same-size change and skips source symlinks', async () => {
        const root = host().makeTempDir();
        const file = disk.join(root, 'a.md');
        const link = disk.join(root, 'alias.md');
        const workspace = new WorkspaceRepository();
        try {
            disk.write(file, 'old');
            eq(workspace.files(root)[0].text, 'old');
            const modified = host().modified(file);
            disk.write(file, 'new');
            host().setModified(file, modified);
            host().symlink(file, link);
            const fresh = workspace.files(root, { freshness: 'fresh' });
            eq(fresh.map(f => f.name), ['a.md']); eq(fresh[0].text, 'new');
        } finally { workspace.close(); if (platform().fs.kind(link) !== 'missing') disk.remove(link); disk.remove(file); disk.remove(root); }
    });
    await test('plan → batch approval → verification of the actual result → finished; the checkpoint can be opened', async () => {
        const h = harness();
        const r = await h.run([[plan(false)], [batch], [plan(true)], [verify]]);
        eq(r.applied, 2); eq(h.proposals(), 1);
        eq(h.session.work?.status, 'complete');
        const saved = parseChat(h.checkpoint());
        eq(saved?.work?.status, 'complete'); eq(saved?.events?.find(e => e.tool === 'propose_batch')?.status, 'applied');
        contains(h.disk.get('plan.md')!, 'November 22');
    });
    await test('a new conversation while a response is pending is not mixed with the old work result', async () => {
        const h = harness();
        let finish: (() => void) | null = null;
        const pending = h.session.ask(h.input(), { chat: req => new Promise(resolve => { finish = () => { req.onText('old answer'); resolve(result()); }; }) }, 'fake', h.handlers);
        h.session.clear();
        ok(finish, 'the provider was not called');
        (finish as () => void)();
        const r = await within(pending);
        eq(r.cancelled, true); eq(h.session.history, []); eq(h.session.events, []); eq(h.session.work, null);
    });
    await test('all steps done without verification are not yet considered finished', async () => {
        const h = harness(); await h.run([[plan(true)]]);
        eq(h.session.work?.status, 'paused');
    });
    await test('verification must cover all changed files and read external changes', async () => {
        const h = harness();
        h.handlers.currentFiles = () => [{ name: 'plan.md', text: 'Release November 15' }];
        await h.run([[plan(false)], [batch], [plan(true)], [verify]]);
        eq(h.session.work?.verification?.passed, false); eq(h.session.work?.status, 'paused');
        const omitted = harness();
        await omitted.run([[plan(false)], [batch], [plan(true)], [call('verify_work', { checks: [{ file: 'plan.md', kind: 'present', text: 'November 22' }] })]]);
        eq(omitted.session.work?.verification?.passed, false);
    });
    await test('a rejected batch does not change the disk; the decision is kept after recovery', async () => {
        const h = harness(), before = [...h.disk];
        h.handlers.onBatchProposal = async () => ({ applied: false });
        const r = await h.run([[plan(false)], [batch]]);
        eq(r.applied, 0); eq([...h.disk], before);
        eq(parseChat(h.checkpoint())?.events?.[0].status, 'rejected');
    });
    await test('a conflict on one file cancels the whole batch and is recorded as failed', async () => {
        const h = harness(), apply = h.handlers.onBatchProposal!;
        h.handlers.onBatchProposal = async changes => { h.disk.set('board.md', 'Edited by the user'); return apply(changes); };
        await h.run([[plan(false)], [batch]]);
        contains(h.disk.get('plan.md')!, 'November 15');
        eq(h.session.events[0].status, 'failed');
    });
    await test('the connection fails after applying: the checkpoint still keeps the result and the next turn does not need to repeat it', async () => {
        const h = harness();
        let failed = false;
        try { await h.run([[plan(false)], [batch]], true); } catch { failed = true; }
        eq(failed, true); eq(h.session.work?.status, 'failed');
        const saved = parseChat(h.checkpoint())!;
        const restored = new ChatSession(); restored.restore(saved.turns); restored.work = saved.work!; restored.events.push(...saved.events!);
        let proposed = 0;
        const handlers = { ...h.handlers, onState: () => {}, onBatchProposal: async () => { proposed++; return { applied: false }; } };
        let n = 0;
        await within(restored.ask(h.input(), { chat: async req => {
            if (n++ === 0) {
                ok(req.messages.some(m => m.content?.includes('Applied: propose_batch')), 'the earlier result is not in the context');
                eq(req.messages[req.messages.length - 1].content.includes(goal), true);
                return result([plan(true), verify]);
            }
            req.onText('Checked.'); return result();
        } }, 'fake', handlers));
        eq(proposed, 0); eq(restored.work?.status, 'complete');
    });
}
