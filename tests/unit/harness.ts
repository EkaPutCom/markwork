// External harness orchestration tests (pure): card assignment, project, prompt, the pi JSON reader, and the queue.

import { assignCard, cardMeta, composeCard, parseBoard, splitCard } from '../../src/markdown/kanban.js';
import {
    boardProject, buildPrompt, cardProject, cardWikiLinks, CONTEXT_CHARS, MAX_LINKED_NOTES, NOTE_CHARS, checkProjectFolder, describeReply, endsWithQuestion, HARNESSES, locateCard, PiReader, resultNote,
    rpcPrompt, rpcSteer, rpcUiResponse, RunQueue, stageColumn, type HarnessAsk,
} from '../../src/agent/harness.js';
import { AgentTrace } from '../../src/agent/trace.js';
import { section, test, eq, ok, contains } from '../framework.js';

const BOARD = `---
kanban: true
project: web-ecommerce
---

## Plan

- [ ] Checkout with QRIS [agent:: pi] #feature
  Use the official SDK.
- [ ] Cart test [agent:: pi] #project/shop-admin [due:: 2026-10-20]

## In Progress

## Review

## Done
`;

const lines = (...events: object[]) => events.map(e => JSON.stringify(e));

export function harnessTests(): void {
    section('External harness (model)');

    test('cardMeta: [agent:: name] is an assignment; a bare @name or an email address is just text', () => {
        eq(cardMeta('Checkout QRIS [agent:: pi] #feature [due:: 2026-10-20]'), { title: 'Checkout QRIS', tags: ['feature'], due: '2026-10-20', agent: 'pi' });
        eq(cardMeta('Send to budi@example.com').agent, null, 'email address');
        eq(cardMeta('Send to budi@example.com').title, 'Send to budi@example.com');
        eq(cardMeta('Ask @pi about it').agent, null, 'a bare @name is not an assignment');
        eq(cardMeta('[agent:: pi]').title, '[agent:: pi]', 'text that is only a field is still shown');
        eq(cardMeta('A [agent:: pi] [agent:: claude]').agent, 'pi', 'the first one is used');
        eq(cardMeta('A [agent:: 9x]').agent, null, 'an invalid name is not an assignment');
    });

    test('assignCard and composeCard keep the other parts of the card', () => {
        eq(assignCard('Checkout #feature [due:: 2026-10-20]', 'pi'), 'Checkout #feature [due:: 2026-10-20] [agent:: pi]');
        eq(assignCard('Checkout [agent:: pi] #feature', 'pi'), 'Checkout [agent:: pi] #feature', 'already assigned');
        eq(assignCard('Checkout [agent:: claude] #feature', 'pi'), 'Checkout [agent:: pi] #feature', 'reassigned in place');
        eq(assignCard('Checkout [agent:: pi] #feature', null), 'Checkout #feature', 'remove the assignment');
        eq(composeCard({ title: 'Checkout', tags: ['feature'], due: '', agent: '@Pi' }), 'Checkout #feature [agent:: pi]');
        eq(composeCard({ title: 'Checkout', tags: [], due: '', agent: 'not a name!' }), 'Checkout', 'an invalid name is dropped');
        const parts = splitCard('Checkout #feature [due:: 2026-10-20 09:00] [agent:: pi]');
        eq(parts, { title: 'Checkout', tags: ['feature'], due: '2026-10-20 09:00', agent: 'pi' });
        eq(composeCard(parts), 'Checkout #feature [due:: 2026-10-20 09:00] [agent:: pi]', 'round trip through the edit dialog');
        eq(composeCard({ ...parts, title: 'Renamed' }, 'Checkout [owner:: Eka] [due:: 2026-10-20]'), 'Renamed #feature [owner:: Eka] [due:: 2026-10-20 09:00] [agent:: pi]', 'fields of other keys are kept');
    });

    test('project from the board frontmatter, a #project/… tag on the card wins', () => {
        const b = parseBoard(BOARD);
        eq(boardProject(b), 'web-ecommerce');
        eq(cardProject(b, b.columns[0].cards[0]), 'web-ecommerce');
        eq(cardProject(b, b.columns[0].cards[1]), 'shop-admin');
        eq(boardProject(parseBoard('---\nkanban: true\nproject: "shop"\n---\n\n## A\n')), 'shop', 'quoted value');
        eq(boardProject(parseBoard('---\nkanban: true\n---\n\nproject: outside\n\n## A\n')), null, 'outside the frontmatter is ignored');
    });

    test('the project folder must not be the Nyerat work folder, its contents, or its parent', () => {
        eq(checkProjectFolder('/home/eka/web', '/home/eka/nyerat'), null);
        eq(checkProjectFolder('/home/eka/nyerat-other', '/home/eka/nyerat'), null, 'the same name prefix does not mean inside');
        ok(checkProjectFolder('/home/eka/nyerat', '/home/eka/nyerat/'), 'the work folder itself');
        ok(checkProjectFolder('/home/eka/nyerat/code', '/home/eka/nyerat'), 'inside the work folder');
        ok(checkProjectFolder('/home/eka', '/home/eka/nyerat'), 'the parent of the work folder');
        ok(checkProjectFolder('relative/web', null), 'relative path');
        ok(checkProjectFolder('/', null), 'root');
    });

    test('the prompt contains the title, notes, tags (without the project tag), due date, and task boundaries', () => {
        const b = parseBoard(BOARD);
        const p1 = buildPrompt(b.columns[0].cards[0], 'web-ecommerce', 'board.md');
        contains(p1, '# Checkout with QRIS');
        contains(p1, 'Use the official SDK.');
        contains(p1, 'Tags: #feature');
        contains(p1, 'project "web-ecommerce"');
        contains(p1, 'Do not make commits');
        const p2 = buildPrompt(b.columns[0].cards[1], 'shop-admin', 'board.md');
        ok(!p2.includes('#project/'), 'the project tag is not in the prompt');
        contains(p2, 'Due: 2026-10-20');
        ok(!p2.includes('@pi'), 'the assignment is not part of the title');
    });

    test('[[note]] links in the card title and notes become a list of context links without duplicates', () => {
        const card = { done: false, text: 'Tidy up checkout [[Specification]] [agent:: pi]', notes: ['See [[specification]] and [[Design#Color|color]].', '`[[not]]`'] };
        eq(cardWikiLinks(card).map(l => [l.target, l.heading]), [['Specification', ''], ['Design', 'Color']]);
        const many = { done: false, text: 'x', notes: Array.from({ length: 15 }, (_, i) => `[[n${i}]]`) };
        eq(cardWikiLinks(many).length, MAX_LINKED_NOTES, 'link count limit');
    });

    test('the prompt copies the contents of related notes in a code block, marks missing ones, and truncates long ones', () => {
        const card = { done: false, text: 'Tidy up checkout [[Specification]] [agent:: pi]', notes: [] };
        const link = (target: string, heading = '') => ({ target, heading, alias: '' });
        const p = buildPrompt(card, 'web', 'board.md', [
            { link: link('Specification'), file: 'docs/Specification.md', text: '# Spec\n\nUse ```js``` in the example.' },
            { link: link('Missing'), file: null, text: null },
            { link: link('Design', 'Color'), file: 'Design.md', text: null },
            { link: link('Long'), file: 'Long.md', text: 'x'.repeat(NOTE_CHARS + 50) },
        ]);
        contains(p, '## Related notes from Nyerat');
        contains(p, '### [[Specification]] — docs/Specification.md');
        contains(p, '````markdown\n# Spec\n\nUse ```js``` in the example.\n````');
        contains(p, '### [[Missing]]\n\n(not found in the Nyerat work folder)');
        contains(p, '(the section "Color" was not found in this file)');
        contains(p, '…(truncated, 50 more characters)');
        ok(p.indexOf('## Related notes') < p.indexOf('Do this task'), 'context before the task boundary');
        ok(!buildPrompt(card, 'web', 'board.md').includes('Related notes'), 'without notes there is no context section');
    });

    test('the contents of related notes are limited in total', () => {
        const card = { done: false, text: 'x', notes: [] };
        const notes = Array.from({ length: 5 }, (_, i) => ({ link: { target: `n${i}`, heading: '', alias: '' }, file: `n${i}.md`, text: 'y'.repeat(NOTE_CHARS) }));
        const p = buildPrompt(card, 'web', 'board.md', notes);
        ok((p.match(/y{100,}/g) ?? []).reduce((n, m) => n + m.length, 0) <= CONTEXT_CHARS, 'exceeded the total limit');
        contains(p, '(skipped: the related notes context limit has been reached)');
    });

    test('stageColumn and locateCard', () => {
        const b = parseBoard(BOARD);
        eq([stageColumn(b, 'doing'), stageColumn(b, 'review')], [1, 2]);
        eq(stageColumn(parseBoard('---\nkanban: true\n---\n\n## A\n\n## B\n'), 'review'), -1);
        eq(locateCard(b, 'Checkout with QRIS [agent:: pi] #feature'), { column: 0, index: 0 });
        eq(locateCard(b, 'nonexistent'), null);
        const dup = parseBoard('---\nkanban: true\n---\n\n## A\n\n- [ ] X\n- [ ] X\n');
        eq(locateCard(dup, 'X'), null, 'duplicate cards are not picked arbitrarily');
    });

    test('PiReader: JSON that is not an event, a null message, and inherited names are ignored', () => {
        const r = new PiReader(new AgentTrace(() => 0, () => '2026-10-05T10:00:00'));
        for (const l of ['null', '5', '"text"', '[]', '{"type":"toString"}', '{"type":"constructor"}', '{"type":"message_end","message":null}']) eq(r.line(l), null, l);
        eq(r.finish(0, '').error, 'pi finished without an answer');
    });

    test('PiReader: tools, answers, cost, and session become the log and the result', () => {
        const trace = new AgentTrace(() => 0, () => '2026-10-05T10:00:00');
        const r = new PiReader(trace);
        for (const l of lines(
            { type: 'session', version: 3, id: 'session-1', cwd: '/x' },
            { type: 'agent_start' },
            { type: 'turn_start' },
            { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Check first.' } },
            { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
            { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.ts' }] }, isError: false },
            { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'toolUse', usage: { totalTokens: 100, cost: { total: 0.001 } } } },
            { type: 'turn_start' },
            { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done: ' } },
            { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: changed a.ts\nOther details' }], stopReason: 'stop', usage: { totalTokens: 50, cost: { total: 0.0005 } } } },
            { type: 'agent_end', messages: [], willRetry: false },
            { type: 'agent_settled' },
        )) r.line(l);
        r.line('not json');
        const result = r.finish(0, '');
        eq(result.ok, true);
        eq(result.summary, 'Done: changed a.ts\nOther details');
        eq(result.sessionId, 'session-1');
        eq(result.tokens, 150);
        ok(Math.abs(result.cost - 0.0015) < 1e-9, `cost ${result.cost}`);
        const tool = trace.events.find(e => e.kind === 'tool')!;
        eq([tool.title, tool.status], ['bash', 'ok']);
        contains(tool.args!, '"command": "ls"');
        contains(tool.result!, 'a.ts');
        eq(tool.detail, '', 'arguments and result are not mixed into the detail');
        ok(trace.events.some(e => e.kind === 'reasoning' && e.detail === 'Check first.'), 'reasoning recorded');
        ok(trace.events.some(e => e.kind === 'note' && e.detail === 'not json'), 'a non-JSON line is recorded');
        contains(trace.events.find(e => e.title === 'pi session')!.detail, 'pi --session session-1');
    });

    test('PiReader: model error, exit code, and stopped', () => {
        const fail = new PiReader(new AgentTrace());
        fail.line(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'invalid API key' } }));
        eq(fail.finish(1, '').error, 'invalid API key');
        eq(new PiReader(new AgentTrace()).finish(2, 'warning\nNo API key found\n').error, 'No API key found', 'the last stderr line');
        eq(new PiReader(new AgentTrace()).finish(0, '').error, 'pi finished without an answer');
        eq(new PiReader(new AgentTrace()).finish(143, '', true).error, 'stopped by the user');
    });

    test('RPC mode: arguments, stdin commands, and the session id from get_state', () => {
        eq(HARNESSES.pi.args('Checkout', null), ['--mode', 'rpc', '--name', 'Checkout']);
        eq(HARNESSES.pi.args('Checkout', 'session-1'), ['--mode', 'rpc', '--name', 'Checkout', '--session', 'session-1']);
        eq(JSON.parse(rpcPrompt('Hello\n"quote"', 'p1')), { id: 'p1', type: 'prompt', message: 'Hello\n"quote"' });
        ok(!rpcPrompt('a\nb', 'p').includes('\n'), 'one command = one line');
        eq(JSON.parse(rpcSteer('turn')).type, 'steer');
        eq(JSON.parse(rpcUiResponse('u1', { confirmed: false })), { type: 'extension_ui_response', id: 'u1', confirmed: false });
        eq(JSON.parse(rpcUiResponse('u2', { cancelled: true })), { type: 'extension_ui_response', id: 'u2', cancelled: true });
        const r = new PiReader(new AgentTrace());
        eq(r.line(JSON.stringify({ id: 'nyerat-state', type: 'response', command: 'get_state', success: true, data: { sessionId: 's-9' } })), null);
        eq(r.session, 's-9');
        eq(r.line(JSON.stringify({ id: 'p', type: 'response', command: 'prompt', success: false, error: 'no such model' })), { type: 'rejected', error: 'no such model' });
        eq(r.line(JSON.stringify({ type: 'agent_settled' })), { type: 'settled' });
    });

    test('an extension request becomes ask; notify and TUI status do not wait', () => {
        const trace = new AgentTrace();
        const r = new PiReader(trace);
        const sig = r.line(JSON.stringify({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Allow?', options: ['Yes', 'No'], timeout: 10000 }));
        eq(sig, { type: 'ask', ask: { kind: 'select', id: 'u1', title: 'Allow?', message: '', options: ['Yes', 'No'], prefill: '', timeout: 10000 } });
        const confirm = r.line(JSON.stringify({ type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'Delete?', message: 'rm -rf build' }));
        eq(confirm?.type === 'ask' && confirm.ask.message, 'rm -rf build');
        const input = r.line(JSON.stringify({ type: 'extension_ui_request', id: 'u3', method: 'input', title: 'Branch name', placeholder: 'feature/…' }));
        eq(input?.type === 'ask' && input.ask.message, 'feature/…', 'the placeholder becomes a hint');
        eq(r.line(JSON.stringify({ type: 'extension_ui_request', id: 'u4', method: 'notify', message: 'Blocked', notifyType: 'warning' })), null);
        eq(r.line(JSON.stringify({ type: 'extension_ui_request', id: 'u5', method: 'setStatus', statusKey: 'x', statusText: 'y' })), null);
        ok(trace.events.some(e => e.title === 'pi message' && e.detail === 'Blocked'), 'notify recorded');
        ok(trace.events.some(e => e.title === 'pi is waiting: Allow?' && e.detail.includes('Yes / No')), 'request recorded');
    });

    test('a question at the end of an answer and a summary of the answer given by the user', () => {
        eq(['Use SDK A or B?', 'Done.\n\nContinue to the tests? 🙂', 'Use **A** or **B?**', 'Already added.', 'What? All done.', ''].map(endsWithQuestion),
            [true, true, true, false, false, false]);
        const ask: HarnessAsk = { kind: 'confirm', id: 'u', title: 't', message: '', options: [], prefill: '', timeout: null };
        eq([describeReply(ask, { confirmed: true }), describeReply(ask, { confirmed: false }), describeReply(ask, { cancelled: true }),
            describeReply({ ...ask, kind: 'question' }, { cancelled: true }), describeReply(ask, { value: 'Yes' })],
        ['allowed', 'denied', 'skipped', 'ended without replying', 'Yes']);
    });

    test('PiReader.restart: the error and status of the old turn do not carry over to the next prompt', () => {
        const r = new PiReader(new AgentTrace());
        r.line(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Choose A?' }], stopReason: 'stop' } }));
        r.line(JSON.stringify({ type: 'agent_settled' }));
        r.restart();
        eq(r.settled, false);
        r.line(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done using A' }], stopReason: 'stop' } }));
        r.line(JSON.stringify({ type: 'agent_settled' }));
        const result = r.finish(0, '');
        eq([result.ok, result.summary], [true, 'Done using A']);
    });

    test('resultNote: one compact line', () => {
        const base = { cost: 0, tokens: 0, sessionId: null };
        eq(resultNote('pi', { ...base, ok: true, summary: '## Summary\n- Change a.ts', error: null }, '05/10 10:00'), '↳ pi done 05/10 10:00: Summary');
        eq(resultNote('pi', { ...base, ok: false, summary: '', error: 'error' }, '05/10 10:00'), '↳ pi failed 05/10 10:00: error');
        eq(resultNote('pi', { ...base, ok: true, summary: 'Done.\n\n**What changed:**\n- Created a new file `HELLO.txt`.', error: null }, 's'), '↳ pi done s: Created a new file `HELLO.txt`.', 'the opener and section heading are skipped');
        eq(resultNote('pi', { ...base, ok: true, summary: '1. 2 files changed', error: null }, 's'), '↳ pi done s: 2 files changed', 'numbers in the content are not dropped');
        ok(resultNote('pi', { ...base, ok: true, summary: 'x'.repeat(400), error: null }, 's').length < 200, 'truncated');
    });

    test('RunQueue: one run per folder, the rest queue in order', () => {
        const q = new RunQueue();
        const base = { board: '/p.md', title: 't', agent: 'pi', project: 'a', prompt: '', session: null };
        const a = q.add({ ...base, card: 'A', folder: '/a' });
        const b = q.add({ ...base, card: 'B', folder: '/a' });
        const c = q.add({ ...base, card: 'C', folder: '/b' });
        const d = q.add({ ...base, card: 'D', folder: '/a' });
        eq([a.status, b.status, c.status, d.status], ['working', 'queued', 'working', 'queued']);
        eq(q.end(d, 'stopped'), null, 'cancelling from the queue does not give a turn');
        eq(q.end(a, 'done'), b);
        eq(b.status, 'working');
        eq(q.end(b, 'failed'), null);
        eq(q.active('/p.md', 'B'), null);
        eq(q.find('/p.md', 'B')?.status, 'failed');
        const again = q.add({ ...base, card: 'B', folder: '/a' });
        eq(q.find('/p.md', 'B'), again, 'an active run takes precedence');
        q.wait(again, { kind: 'confirm', id: 'x', title: 'Allow?', message: '', options: [], prefill: '', timeout: null });
        eq(again.status, 'waiting');
        q.resume(again);
        eq([again.status, again.ask], ['working', null], 'resume clears the question');
        q.wait(again, { kind: 'confirm', id: 'y', title: 'Allow?', message: '', options: [], prefill: '', timeout: null });
        eq(q.add({ ...base, card: 'E', folder: '/a' }).status, 'queued', 'a run waiting for an answer still holds the folder');
        eq(q.active('/p.md', 'B'), again);
        eq(q.end(again, 'done')?.card, 'E', 'finishing the wait → the next turn');
        eq(again.ask, null);
    });
}
