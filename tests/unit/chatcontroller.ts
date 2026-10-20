// Conversation life cycle without widgets: ChatController with a recording view and fake providers.

import { ChatController, FOLDER_CHANGED, type ChatControllerHost, type ChatView, type TurnOutcome } from '../../src/agent/chatcontroller.js';
import type { KeyStore } from '../../src/agent/apikey.js';
import type { Change } from '../../src/agent/changes.js';
import type { ChatResult, Provider } from '../../src/agent/provider.js';
import type { ProposalResult } from '../../src/agent/session.js';
import { chatLogPath } from '../../src/agent/chatstore.js';
import { section, test, eq, ok, within, tmp, disk } from '../framework.js';
import type { Cancellable } from '../../src/cancel.js';

const KEY: KeyStore = { get: async () => ({ key: 'test', source: 'env' }), set: async () => 'env', clear: async () => {} };
const answer = (text: string): Provider => ({
    async chat(req) { req.onText(text); return { usage: { prompt: 10, cached: 0, completion: 2 }, cancelled: false, toolCalls: [], reasoning: '' }; },
});

// Records what the controller asks the view to show.
function recordingView() {
    const log: string[] = [];
    const outcomes: TurnOutcome[] = [];
    let decide: (change: Change | Change[], apply: (c: Change | Change[]) => string | null) => ProposalResult = () => ({ applied: false });
    const view: ChatView = {
        noKey: () => log.push('noKey'),
        saveFailed: error => log.push(`saveFailed ${error}`),
        busyChanged: busy => log.push(`busy ${busy}`),
        startTurn: question => {
            log.push(`turn ${question}`);
            let text = '';
            return {
                context: () => {}, reasoning: () => {}, step: () => {}, work: () => {},
                text: delta => { text += delta; },
                end: outcome => { outcomes.push(outcome); log.push(`end ${'error' in outcome ? `error ${outcome.error}` : outcome.cancelled ? 'cancelled' : text}`); },
            };
        },
        review: async (change, apply, _cancelled: Cancellable) => { log.push('review'); return decide(change, apply); },
    };
    return { view, log, outcomes, decideWith: (fn: typeof decide) => { decide = fn; } };
}

export async function chatControllerTests(): Promise<void> {
    section('Chat controller');
    let n = 0;
    const folder = () => {
        const root = disk.join(tmp, `chatctl-${++n}`);
        disk.mkdirs(root);
        return root;
    };
    const setup = (root: string | null) => {
        const rec = recordingView();
        const c = new ChatController(rec.view);
        const state = { root };
        const disk = new Map([['notes.md', 'Release 15 November\n']]);
        const host: ChatControllerHost = {
            active: () => null, selection: () => '', root: () => state.root,
            files: () => [...disk].map(([name, text]) => ({ name, text })),
            applyBatch: changes => { for (const ch of changes) disk.set(ch.file, ch.after); return null; },
            applyChange: ch => { disk.set(ch.file, ch.after); return null; },
        };
        c.host = host;
        c.keyStore = KEY;
        return { c, ...rec, state, disk };
    };

    await test('without a key nothing is sent and the view asks for one', async () => {
        const { c, log } = setup(null);
        c.keyStore = { ...KEY, get: async () => null };
        await within(c.send('hello'));
        eq(log, ['noKey']);
    });

    await test('a turn is shown, saved to the folder, and can be reopened and deleted', async () => {
        const root = folder();
        const { c, log } = setup(root);
        c.makeProvider = () => answer('Hi.');
        await within(c.send('  hello  '));
        eq(log, ['turn hello', 'busy true', 'end Hi.', 'busy false']);
        const chats = c.chats()!;
        eq(chats.length, 1, 'saved conversations');
        eq(chats[0].title, 'hello');

        const logFile = chatLogPath(chats[0].path);
        ok(disk.exists(logFile), 'the agent log was not saved next to the conversation');
        eq(chats.length, 1, 'the log file is not listed as a conversation');

        const other = setup(root).c;
        const chat = other.open(chats[0].path);
        ok(chat, 'the conversation did not open');
        eq(other.session.history.map(t => t.content), ['hello', 'Hi.']);
        eq(other.session.trace.events.map(e => e.kind), c.session.trace.events.map(e => e.kind), 'the agent log came back with the conversation');
        ok(other.session.trace.events.some(e => e.kind === 'turn' && e.title.includes('hello')), 'the turn is missing from the restored log');
        other.makeProvider = () => answer('Again.');
        await within(other.send('more'));
        eq(other.chats()!.length, 1, 'the continuation is appended to the same file');
        other.deleteChat(chats[0].path);
        eq(other.chats()!.length, 0, 'deleted');
        ok(!disk.exists(logFile), 'the log stayed behind after deleting the conversation');
    });

    await test('a proposal after the work folder changed is refused without asking the user', async () => {
        const { c, log, state, decideWith } = setup(folder());
        decideWith(() => { throw new Error('the user must not be asked'); });
        const replies: string[] = [];
        let round = 0;
        c.makeProvider = () => ({
            async chat(req): Promise<ChatResult> {
                for (const m of req.messages) if (m.role === 'tool') replies.push(m.content);
                if (++round === 1) {
                    state.root = folder();   // the user opened another folder while the model was thinking
                    return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 't1', name: 'edit_file', arguments: JSON.stringify({ name: 'notes.md', old_text: '15 November', new_text: '22 November', reason: 'x' }) }] };
                }
                req.onText('ok');
                return { usage: null, cancelled: false, reasoning: '', toolCalls: [] };
            },
        });
        await within(c.send('change the date'));
        ok(!log.includes('review'), 'the review was shown');
        ok(replies.some(r => r.includes(FOLDER_CHANGED)), replies.join('\n'));
    });

    await test('an approved proposal is applied through the host and can be undone', async () => {
        const { c, disk, decideWith } = setup(folder());
        let applied: Change | Change[] | null = null;
        decideWith((change, apply) => { applied = change; const error = apply(change); return error ? { applied: false, error } : { applied: true }; });
        let round = 0;
        c.makeProvider = () => ({
            async chat(req): Promise<ChatResult> {
                if (++round === 1) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 't1', name: 'edit_file', arguments: JSON.stringify({ name: 'notes.md', old_text: '15 November', new_text: '22 November', reason: 'x' }) }] };
                req.onText('done');
                return { usage: null, cancelled: false, reasoning: '', toolCalls: [] };
            },
        });
        await within(c.send('change the date'));
        eq(disk.get('notes.md'), 'Release 22 November\n');
        ok(applied && !Array.isArray(applied), 'single change');
        eq(c.undo([applied as Change]), null, 'undo error');
        eq(disk.get('notes.md'), 'Release 15 November\n');
        eq(c.session.events[0].status, 'reverted');
    });

    await test('stop cancels the running turn; busy ends', async () => {
        const { c, log } = setup(null);
        c.makeProvider = () => ({
            chat: req => new Promise(resolve => { req.cancellable?.onCancel(() => resolve({ usage: null, cancelled: true, toolCalls: [], reasoning: '' })); }),
        });
        const sending = c.send('slow');
        setTimeout(() => { ok(c.busy, 'not busy while sending'); c.stop(); }, 0);
        await within(sending);
        eq(log, ['turn slow', 'busy true', 'end cancelled', 'busy false']);
        ok(!c.busy, 'still busy');
    });

    await test('reset during a turn drops its late result', async () => {
        const { c, log } = setup(null);
        let finish: (r: ChatResult) => void = () => {};
        c.makeProvider = () => ({ chat: req => new Promise(resolve => { finish = r => { req.onText('late'); resolve(r); }; }) });
        const sending = c.send('first');
        setTimeout(() => {
            c.reset();
            finish({ usage: null, cancelled: false, toolCalls: [], reasoning: '' });
        }, 0);
        await within(sending);
        eq(log, ['turn first', 'busy true', 'busy false'], 'no end for the dropped turn');
        eq(c.session.history.length, 0, 'history cleared');
    });
}
