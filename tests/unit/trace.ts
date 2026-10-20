// Agent activity log: pure recording and real results from the agent loop with a fake provider.
import { AgentTrace } from '../../src/agent/trace.js';
import { TraceFeed, TraceReplica, type TraceUpdate } from '../../src/agent/tracefeed.js';
import { ChatSession } from '../../src/agent/session.js';
import type { ChatResult, Provider, ToolCall } from '../../src/agent/provider.js';
import { traceTree, descendants, traceStats, turnEvents, formatMs, formatSize } from '../../src/agent/tracetree.js';
import { settledNewest, visibleSteps } from '../../src/agent/logrows.js';
import { section, test, eq, ok, contains, within, pause, until } from '../framework.js';

const files = [{ name: 'a.md', text: '# A\nRelease November 15\n' }];
const input = { question: 'When is the release?', active: null, selection: '', files, mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 };
const handlers = { onContext: () => {}, onText: () => {}, onReasoning: () => {} };

export async function traceTests(): Promise<void> {
    section('Agent: activity log');
    await test('streaming reasoning and answers are joined; tools are completed with a result and duration', async () => {
        let t = 0;
        const trace = new AgentTrace(() => (t += 50), () => '2026-10-05T10:00:00');
        trace.append('reasoning', 1, 'Check ');
        trace.append('reasoning', 1, 'manuscript');
        eq(trace.events.length, 1);
        eq(trace.events[0].detail, 'Check manuscript');
        trace.begin('tool', '1:x', 'Tool: read', '', 1, { args: '{}' });
        eq(trace.events[1].status, 'running');
        trace.finish('tool', '1:x', 'ok', undefined, undefined, { result: 'content' });
        eq(trace.events[1].status, 'ok');
        eq(trace.events[1].ms, 50);
        eq([trace.events[1].args, trace.events[1].result, trace.events[1].detail], ['{}', 'content', '']);
        contains(AgentTrace.format(trace.events[1]), 'Arguments:\n{}');
        contains(AgentTrace.format(trace.events[1]), 'Result:\ncontent');
        trace.finish('tool', '1:x', 'failed', 'double');   // without a pair: ignored
        eq(trace.events[1].status, 'ok');
    });
    await test('a huge detail is truncated and the log is limited in count', async () => {
        const trace = new AgentTrace();
        trace.add('note', 'big', 'x'.repeat(50000));
        ok(trace.events[0].detail.length < 21000, 'not truncated');
        for (let i = 0; i < 2100; i++) trace.add('note', `n${i}`);
        eq(trace.events.length, 2000);
        eq(trace.jsonl().trim().split('\n').length, 2000);
    });
    await test('a turn with tools records rounds, reasoning, arguments, results, and tokens', async () => {
        const session = new ChatSession();
        let n = 0;
        const call: ToolCall = { id: 'c1', name: 'search_text', arguments: JSON.stringify({ query: 'release' }) };
        const provider: Provider = { chat: async req => {
            req.onReasoning?.('Need to look up the word release. ');
            if (n++ === 0) return { usage: { prompt: 100, cached: 0, completion: 5 }, cancelled: false, toolCalls: [call], reasoning: 'Need to look up' } as ChatResult;
            req.onText('November 15.');
            return { usage: { prompt: 150, cached: 100, completion: 8 }, cancelled: false, toolCalls: [], reasoning: '' } as ChatResult;
        } };
        await within(session.ask(input, provider, 'fake', handlers));
        const events = session.trace.events;
        const kinds = events.map(e => e.kind);
        for (const k of ['turn', 'round', 'reasoning', 'tool', 'text', 'note'] as const) ok(kinds.includes(k), `no event ${k}`);
        eq(events.filter(e => e.kind === 'round').length, 2);
        const tool = events.find(e => e.kind === 'tool')!;
        eq(tool.status, 'ok');
        contains(tool.args!, '"query": "release"');
        ok((tool.result ?? '').length > 0, 'the result was not recorded');
        contains(events.find(e => e.kind === 'round')!.detail, 'search_text');
        contains(events.filter(e => e.kind === 'round')[1].detail, '150 in (100 from cache)');
        eq(events.filter(e => e.kind === 'round')[1].usage, { prompt: 150, cached: 100, completion: 8 });
        ok(events.find(e => e.kind === 'turn')!.items !== undefined, 'the context sources of the turn were not recorded');
        contains(events.find(e => e.kind === 'reasoning')!.detail, 'look up the word release');
        session.clear();
        eq(session.trace.events.length, 0);
    });
    await test('a provider error is recorded as a failed event', async () => {
        const session = new ChatSession();
        const provider: Provider = { chat: async () => { throw Error('connection dropped'); } };
        let threw = false;
        try { await within(session.ask(input, provider, 'fake', handlers)); } catch { threw = true; }
        ok(threw, 'the error was not propagated');
        const last = session.trace.events[session.trace.events.length - 1];
        eq(last.kind, 'error');
        contains(last.detail, 'connection dropped');
        eq(session.trace.events.find(e => e.kind === 'round')?.status, 'failed');
    });
    await test('the tree: a turn holds rounds, a round holds its steps, loose notes stay under the turn', async () => {
        const t = new AgentTrace(() => 0, () => '2026-10-05T10:00:00');
        t.add('note', 'orphan');
        t.add('turn', 'New turn: q', '', { items: ['a.md'] });
        t.begin('round', '1', 'Calling', '', 1);
        t.append('reasoning', 1, 'think');
        t.begin('tool', '1:x', 'Tool: read', '', 1, { args: '{}' });
        t.finish('round', '1', 'ok', '', undefined, { usage: { prompt: 10, cached: 0, completion: 2 } });
        t.finish('tool', '1:x', 'failed', undefined, undefined, { result: 'no' });
        t.begin('round', '2', 'Calling', '', 2);
        t.append('text', 2, 'answer');
        t.add('note', 'Turn finished');
        t.add('turn', 'New turn: second');
        const nodes = traceTree(t.events);
        eq(nodes.map(n => n.depth), [0, 0, 1, 2, 2, 1, 2, 1, 0]);
        eq(nodes[3].parent, nodes[2].event.seq);
        eq(nodes[7].parent, nodes[1].event.seq);
        eq(descendants(nodes, nodes[1].event.seq).length, 6);
        eq(descendants(nodes, nodes[2].event.seq).map(e => e.kind), ['reasoning', 'tool']);
        eq(turnEvents(nodes, nodes[4].event.seq).length, 7);
        const stats = traceStats(turnEvents(nodes, nodes[4].event.seq));
        eq([stats.rounds, stats.tools, stats.failed, stats.prompt, stats.completion], [2, 1, 1, 10, 2]);
    });
    await test('a log viewer shows the steps the filter lets through, none under a folded step, and follows the newest settled one', async () => {
        const t = new AgentTrace(() => 0, () => '2026-10-05T10:00:00');
        t.add('turn', 'New turn: q');
        t.begin('round', '1', 'Calling', '', 1);
        t.append('reasoning', 1, 'think');
        t.begin('tool', '1:x', 'Tool: read', '', 1, { args: '{}' });
        t.finish('tool', '1:x', 'ok', undefined, undefined, { result: 'r' });
        t.finish('round', '1', 'ok');
        t.begin('round', '2', 'Calling', '', 2);
        t.append('text', 2, 'answer');
        t.finish('round', '2', 'ok');
        t.add('note', 'Turn finished');
        const nodes = traceTree(t.events);
        const seqs = (set: Set<number>) => nodes.filter(n => set.has(n.event.seq)).map(n => n.event.kind);
        eq(seqs(visibleSteps(nodes, [], new Set())), ['turn', 'round', 'reasoning', 'tool', 'round', 'text', 'note'], 'all');
        eq(seqs(visibleSteps(nodes, ['tool'], new Set())), ['turn', 'round', 'tool'], 'tools: the turn, the round that holds one, the tool');
        eq(seqs(visibleSteps(nodes, ['round', 'text'], new Set())), ['turn', 'round', 'text'], 'a round shows only when something in it matches');
        eq(seqs(visibleSteps(nodes, [], new Set([nodes[1].event.seq]))), ['turn', 'round', 'round', 'text', 'note'], 'a folded round hides what it holds');
        eq(seqs(visibleSteps(nodes, [], new Set([nodes[0].event.seq]))), ['turn'], 'a folded turn hides everything');
        // A finished turn ends with a note; the turn is the step to follow then.
        const shown = visibleSteps(nodes, [], new Set());
        eq(settledNewest(nodes, shown), nodes[0].event.seq);
        eq(settledNewest(nodes, visibleSteps(nodes, ['tool'], new Set())), nodes[3].event.seq, 'the newest shown step');
        eq(settledNewest([], new Set()), null);
    });
    await test('durations and sizes are shown short', async () => {
        eq([formatMs(7), formatMs(1800), formatMs(75000)], ['7 ms', '1.8 s', '1 min 15 s']);
        eq([formatSize(500), formatSize(3500)], ['500 B', '3.4 KB']);
    });
    await test('a saved log comes back as it was, damaged lines are skipped, and a running event is marked as unfinished', async () => {
        const t = new AgentTrace(() => 0, () => '2026-10-05T10:00:00');
        t.add('turn', 'New turn: q', 'Question', { items: ['a.md'] });
        t.begin('round', '1', 'Calling', '', 1);
        t.begin('tool', '1:x', 'Tool: read', '', 1, { args: '{}' });
        t.finish('tool', '1:x', 'ok', undefined, undefined, { result: 'content' });
        t.finish('round', '1', 'ok', 'Tokens', undefined, { usage: { prompt: 5, cached: 1, completion: 2 } });
        t.begin('round', '2', 'Calling', '', 2);   // never finished: the app was closed
        const text = t.jsonl() + 'not json\n{"seq":"x"}\n{"seq":99,"time":"t","kind":"bogus","title":"x"}\n';
        const back = AgentTrace.parse(text);
        eq(back.length, 4);
        const canon = (events: typeof back) => events.map(e => JSON.stringify(Object.fromEntries(Object.entries(e).sort())));
        eq(canon(back.slice(0, 3)), canon(t.events.slice(0, 3)));
        eq(back[3].status, 'failed');
        const fresh = new AgentTrace();
        let changes = 0;
        fresh.onChange = () => changes++;
        fresh.restore(back);
        eq(fresh.events.length, 4);
        eq(changes, 1);
        fresh.add('note', 'next');
        eq(fresh.events[4].seq, back[3].seq + 1, 'new events continue the numbering');
    });

    await test('a feed sends the log, then batched updates; a replica that applies them holds the same events', async () => {
        const trace = new AgentTrace(() => 0, () => '2026-10-05T10:00:00');
        trace.add('note', 'before');
        const updates: TraceUpdate[] = [];
        const replica = new TraceReplica();
        const feed = new TraceFeed(trace, u => { updates.push(u); replica.apply(u); });
        feed.start();
        eq([updates.length, updates[0].reset, updates[0].events.length], [1, true, 1], 'the log as it is');
        trace.begin('tool', 'k', 'Tool: read', '', 1, { args: '{}' });
        for (const word of ['a', 'b', 'c']) trace.append('text', 1, word);
        trace.finish('tool', 'k', 'ok', undefined, undefined, { result: 'done' });
        eq(updates.length, 1, 'nothing is sent until the interval is over');
        await until(() => updates.length === 2);
        eq(updates[1].reset, false);
        eq(updates[1].events.map(e => e.seq), [2, 3], 'each event that changed, once');
        eq(JSON.parse(JSON.stringify(updates[1])), updates[1], 'not plain data');
        eq(replica.events.map(e => [e.seq, e.status, e.detail]), trace.events.map(e => [e.seq, e.status, e.detail]));
        ok(replica.text() === trace.text(), 'the same text');
        feed.stop();
        trace.add('note', 'after');
        await pause(80);
        eq(updates.length, 2, 'a stopped feed sends nothing');
    });

    await test('clearing or restoring the log resets the replica; a clear asked for by the viewer reaches the core', async () => {
        const trace = new AgentTrace();
        const replica = new TraceReplica();
        const feed = new TraceFeed(trace, u => replica.apply(u));
        feed.start();
        trace.add('note', 'one');
        trace.add('note', 'two');
        feed.flush();
        eq(replica.events.length, 2);
        replica.onClear = () => trace.clear();
        replica.clear();
        feed.flush();
        eq([trace.events.length, replica.events.length], [0, 0], 'cleared on both sides');
        trace.restore([{ seq: 9, time: 't', kind: 'note', title: 'saved', detail: '' }]);
        feed.flush();
        eq(replica.events.map(e => e.title), ['saved']);
        feed.stop();
    });
}
