// The Assistant in the application session: AppSession owns the conversation, a recording panel stands in
// for the Assistant panel, and a scripted provider proposes changes. The panel only sees plain data and reports; what is written,
// and what the agent is told, is decided by the core.

import { AppSession } from '../../src/app/session.js';
import type { ChatPanelSettings, ChatPanelView, ProposalAnswer, ProposalAsk } from '../../src/app/assistant.js';
import type { KeyStore } from '../../src/agent/apikey.js';
import type { TraceUpdate } from '../../src/agent/tracefeed.js';
import type { ChatResult, Provider } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, within, until, untilText, tmp, disk, sync } from '../framework.js';
import { fakeFrontend, FakeEditor, LaggingEditor, memorySettings, quiet } from './appsession.js';

const KEY: KeyStore = { get: async () => ({ key: 'test', source: 'env' }), set: async () => 'env', clear: async () => {} };

// A model that calls one tool in its first round, then answers; every tool result it is sent is kept.
function proposing(name: string, args: object, replies: string[]): Provider {
    let round = 0;
    return {
        async chat(req): Promise<ChatResult> {
            for (const m of req.messages) if (m.role === 'tool') replies.push(m.content);
            if (++round === 1) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: `t${round}`, name, arguments: JSON.stringify(args) }] };
            req.onText('done');
            return { usage: null, cancelled: false, reasoning: '', toolCalls: [] };
        },
    };
}

// The panel: records the notices and answers each proposal with `decide`, which may ask the core to apply first.
function recordingPanel() {
    const log: string[] = [];
    const asks: ProposalAsk[] = [];
    const shown: ChatPanelSettings[] = [];
    const updates: TraceUpdate[] = [];
    let decide: (ask: ProposalAsk, panel: ChatPanelView) => Promise<ProposalAnswer> = async () => ({ note: '' });
    const panel: ChatPanelView = quiet<ChatPanelView>({
        setSettings: settings => { shown.push(settings); },
        noKey: () => { log.push('noKey'); },
        startTurn: (turn, question) => { log.push(`turn ${turn} ${question}`); },
        turnEnd: (turn, outcome) => { log.push(`end ${turn} ${'error' in outcome ? outcome.error : outcome.cancelled ? 'cancelled' : 'ok'}`); },
        review: ask => { asks.push(ask); log.push(`review ${ask.id}`); return decide(ask, panel); },
        cancelReview: ask => { log.push(`cancel ${ask}`); },
        logUpdate: update => { updates.push(update); },
    });
    return { panel, log, asks, shown, updates, decideWith: (fn: typeof decide) => { decide = fn; } };
}

export async function assistantTests(): Promise<void> {
    section('Assistant in the application session');
    let n = 0;
    const setup = (makeEditor: () => FakeEditor = () => new FakeEditor()) => {
        const root = disk.join(tmp, `assistant-${++n}`);
        disk.mkdirs(root);
        disk.write(disk.join(root, 'notes.md'), 'Release 15 November\n');
        disk.write(disk.join(root, 'plan.md'), 'Ship 15 November\n');
        const settings = memorySettings();
        settings.chatSave = false;
        const rec = recordingPanel();
        const session = new AppSession(fakeFrontend(settings, [], makeEditor, { chatPanel: rec.panel }));
        session.files.root = root;   // the work folder without the Files tab: nothing is listed or watched
        session.start();
        session.assistant.chat.keyStore = KEY;
        return { session, root, settings, chat: session.assistant.chat, ...rec };
    };
    const read = (root: string, file: string) => disk.read(disk.join(root, file));
    const edit = (name: string) => ({ name, old_text: '15 November', new_text: '22 November', reason: 'the meeting moved it' });

    await test('the panel gets the proposal as plain data; the core writes only after the panel asks it to', async () => {
        const { root, chat, asks, decideWith } = setup();
        const replies: string[] = [];
        let before = '';
        decideWith(async (ask, panel) => {
            before = read(root, 'notes.md');
            eq(panel.onApply(ask.id, null), null, 'apply');
            return { note: 'thanks' };
        });
        chat.makeProvider = () => proposing('edit_file', edit('notes'), replies);
        await within(chat.send('move the release'));
        eq(before, 'Release 15 November\n', 'written before the user decided');
        eq(read(root, 'notes.md'), 'Release 22 November\n');
        eq(asks.length, 1);
        eq(JSON.parse(JSON.stringify(asks[0])), asks[0], 'the ask is not plain data');
        eq(asks[0].batch, false);
        ok(replies.some(r => r.includes('User note: thanks')), replies.join('\n'));
        eq(chat.session.events[0].status, 'applied');
    });

    await test('Undo names an ask or an event; the core undoes what it wrote, and nothing the panel makes up', async () => {
        const { root, chat, panel, decideWith } = setup();
        const replies: string[] = [];
        let askId = 0;
        decideWith(async (ask, view) => { askId = ask.id; eq(view.onApply(ask.id, null), null, 'apply'); return { note: '' }; });
        chat.makeProvider = () => proposing('edit_file', edit('notes'), replies);
        await within(chat.send('move the release'));
        eq(read(root, 'notes.md'), 'Release 22 November\n');
        ok(panel.onUndo({ ask: askId + 5 }) !== null, 'an ask that was never applied');
        ok(panel.onUndo({ event: 'no-such-event' }) !== null, 'an event that does not exist');
        eq(read(root, 'notes.md'), 'Release 22 November\n', 'nothing changed');
        eq(panel.onUndo({ ask: askId }), null, 'undo by ask');
        eq(read(root, 'notes.md'), 'Release 15 November\n');
        ok(panel.onUndo({ ask: askId }) !== null, 'once only');
        eq(chat.session.events[0].status, 'reverted');
    });

    await test('an applied action of an opened conversation is undone by its event id', async () => {
        const { root, chat, panel, decideWith } = setup();
        decideWith(async (ask, view) => { view.onApply(ask.id, null); return { note: '' }; });
        chat.makeProvider = () => proposing('edit_file', edit('notes'), []);
        await within(chat.send('move the release'));
        const event = chat.session.events[0];
        eq(panel.onUndo({ event: event.id }), null, 'undo by event');
        eq(read(root, 'notes.md'), 'Release 15 November\n');
        ok(panel.onUndo({ event: event.id }) !== null, 'a reverted event is not undone again');
    });

    await test('the agent log reaches the panel as updates of plain events, and clearing it is asked of the core', async () => {
        const { chat, panel, updates } = setup();
        eq([updates.length, updates[0].reset, updates[0].events.length], [1, true, 0], 'the log as it is when the panel is connected');
        chat.makeProvider = () => proposing('read_file', { name: 'notes' }, []);
        await within(chat.send('what is in notes'));
        const events = () => updates.flatMap(u => u.events);
        await until(() => events().some(e => e.kind === 'turn') && events().some(e => e.kind === 'tool'));
        eq(JSON.parse(JSON.stringify(updates)), updates, 'not plain data');
        panel.onClearLog();
        await until(() => updates.at(-1)!.reset && updates.at(-1)!.events.length === 0);
        eq(chat.session.trace.events.length, 0);
    });

    await test('a review that closes without an apply is a rejection, whatever the panel answers', async () => {
        const { root, chat, decideWith } = setup();
        const replies: string[] = [];
        decideWith(async () => ({ note: '' }));
        chat.makeProvider = () => proposing('edit_file', edit('notes'), replies);
        await within(chat.send('move the release'));
        eq(read(root, 'notes.md'), 'Release 15 November\n');
        eq(chat.session.events[0].status, 'rejected');
    });

    await test('a partial batch applies the chosen files, once; the agent is told which', async () => {
        const { root, chat, decideWith } = setup();
        const replies: string[] = [];
        const answers: (string | null)[] = [];
        decideWith(async (ask, panel) => {
            eq(ask.batch, true);
            eq(ask.changes.map(c => c.file), ['notes.md', 'plan.md']);
            answers.push(sync(panel.onApply(ask.id, [1])), sync(panel.onApply(ask.id, [0])));
            return { note: '' };
        });
        const actions = ['notes', 'plan'].map(name => ({ tool: 'edit_file', arguments: JSON.stringify(edit(name)) }));
        chat.makeProvider = () => proposing('propose_batch', { actions }, replies);
        await within(chat.send('move both'));
        eq(answers[0], null);
        contains(answers[1] ?? '', 'already answered');
        eq(read(root, 'notes.md'), 'Release 15 November\n');
        eq(read(root, 'plan.md'), 'Ship 22 November\n');
        ok(replies.some(r => r.includes('Rejected (do not repeat without asking): notes.md')), replies.join('\n'));
    });

    await test('applying re-checks the file: a change the user made after the proposal is not overwritten', async () => {
        const { root, chat, decideWith } = setup();
        const replies: string[] = [];
        let answer: string | null = null;
        decideWith(async (ask, panel) => {
            disk.write(disk.join(root, 'notes.md'), 'Release 15 November, maybe\n');
            answer = sync(panel.onApply(ask.id, null));
            return { note: '' };
        });
        chat.makeProvider = () => proposing('edit_file', edit('notes'), replies);
        await within(chat.send('move the release'));
        contains(answer ?? '', 'changed since it was proposed');
        eq(read(root, 'notes.md'), 'Release 15 November, maybe\n');
        eq(chat.session.events[0].status, 'failed');
    });

    await test('stopping the turn withdraws the ask; an apply that comes after it writes nothing', async () => {
        const { root, chat, log, decideWith } = setup();
        let late: string | null = null;
        decideWith((ask, panel) => new Promise(resolve => {
            setTimeout(() => {
                chat.stop();
                late = sync(panel.onApply(ask.id, null));
                resolve({ note: '' });
            }, 0);
        }));
        chat.makeProvider = () => ({
            async chat(req): Promise<ChatResult> {
                if (req.cancellable?.cancelled) return { usage: null, cancelled: true, reasoning: '', toolCalls: [] };
                return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 't1', name: 'edit_file', arguments: JSON.stringify(edit('notes')) }] };
            },
        });
        await within(chat.send('move the release'));
        ok(log.includes('cancel 1'), log.join('\n'));
        contains(late ?? '', 'no longer open');
        eq(read(root, 'notes.md'), 'Release 15 November\n');
    });

    await test('the settings live in the store: the panel shows them and reports changes to the store', () => {
        const { session, settings, chat, panel, shown } = setup();
        eq(shown.at(-1)?.saveChats, false);
        settings.chatModel = 'deepseek-chat';   // a name from an older version
        eq(chat.model, 'deepseek-flash');
        eq(shown.at(-1)?.model, 'deepseek-flash');
        panel.onModel('deepseek-v4-pro');
        eq(settings.chatModel, 'deepseek-v4-pro');
        eq(chat.model, 'deepseek-v4-pro');
        panel.onThinking(true);
        eq(chat.session.thinking, true);
        panel.onOptions({ activeDocument: false, selection: true, project: false });
        eq(chat.options, { activeDocument: false, selection: true, project: false });
        session.dispose();
        settings.chatModel = 'deepseek-flash';
        eq(chat.model, 'deepseek-v4-pro', 'a disposed session no longer listens to the store');
    });

    await test('an approved change to an open document lands even when the editor applies writes a turn later', async () => {
        const { session, root, chat, decideWith } = setup(() => new LaggingEditor());
        ok(session.host.openInTab(disk.join(root, 'notes.md')), 'openInTab');
        const editor = session.documents.active.editor;
        const replies: string[] = [];
        decideWith(async (ask, panel) => ({ note: sync(panel.onApply(ask.id, null)) ?? '' }));
        // The model reads the file again right after the change was applied, in the same turn of the main loop.
        let round = 0;
        chat.makeProvider = () => ({
            async chat(req): Promise<ChatResult> {
                for (const m of req.messages) if (m.role === 'tool') replies.push(m.content);
                round++;
                if (round === 1) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 't1', name: 'edit_file', arguments: JSON.stringify(edit('notes')) }] };
                if (round === 2) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 't2', name: 'read_file', arguments: JSON.stringify({ name: 'notes' }) }] };
                req.onText('done');
                return { usage: null, cancelled: false, reasoning: '', toolCalls: [] };
            },
        });
        await within(chat.send('move the release'));
        await untilText(editor, 'Release 22 November\n');
        ok(replies.some(r => r.includes('Release 22 November')), `the agent read an old text: ${replies.join('\n')}`);
        eq(read(root, 'notes.md'), 'Release 15 November\n', 'an open document is changed in its editor, not on disk');
        ok(replies.some(r => r.includes('has been applied')), replies.join('\n'));
        // Undo in a later turn goes through the same preflight against the text that landed.
        eq(chat.undo(chat.session.events[0].changes), null, 'undo');
        await until(() => { try { return editor.getText() === 'Release 15 November\n'; } catch { return false; } });
    });

    await test('an answer goes into the open note only while its text is shown', () => {
        const { session, root, panel } = setup();
        ok(session.host.openInTab(disk.join(root, 'notes.md')), 'openInTab');
        ok(panel.onInsert('  The answer.  '), 'insert');
        eq(session.documents.active.editor.getText(), 'Release 15 November\nThe answer.\n');
    });
}
