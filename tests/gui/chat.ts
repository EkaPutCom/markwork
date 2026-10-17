// GUI tests: the Assistant (chat) panel with a fake model provider and key store.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { AgentTrace } from '../../src/agent/trace.js';
import { TraceReplica } from '../../src/agent/tracefeed.js';
import { LogViewer } from '../../src/ui/logviewer.js';
import type { KeyStore } from '../../src/agent/apikey.js';
import { chatsDir, listChats } from '../../src/agent/chatstore.js';
import { readTextFile } from '../../src/files.js';
import type { ChatRequest, Provider } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle, tmp, optVal } from '../framework.js';
import { widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';
import { childrenOf } from '../../src/gtkutil.js';
import type { ProposalViewer } from '../../src/ui/proposalviewer.js';

export function chatTests(c: GuiContext): void {
    const { w, setText, cursorTo, pump } = c;
    const panel = w.chat;
    const chat = w.session.assistant.chat;   // the conversation, owned by the application session

    section('Assistant (chat)');

    const seen: ChatRequest[] = [];
    let reply = 'Laras hid the **letter**.';
    const provider: Provider = {
        async chat(req) {
            seen.push(req);
            req.onReasoning?.('Looking through the manuscript. ');
            for (const part of reply.match(/\S+\s*/g) ?? []) req.onText(part);
            return { usage: { prompt: 1500, cached: 1200, completion: 12 }, cancelled: false, toolCalls: [], reasoning: '' };
        },
    };
    let stored: string | null = null;
    const keyStore: KeyStore = {
        get: async () => stored ? { key: stored, source: 'keyring' } : null,
        set: async key => { stored = key; return 'keyring'; },
        clear: async () => { stored = null; },
    };
    chat.makeProvider = () => provider;
    chat.keyStore = keyStore;

    const book = GLib.build_filenamev([tmp, 'assistant-book']);
    GLib.mkdir_with_parents(book, 0o755);
    GLib.file_set_contents(GLib.build_filenamev([book, 'chapter-1.md']), '# Chapter 1\n\nRaka met Laras on the pier. Laras carried a letter from her father.\n');
    GLib.file_set_contents(GLib.build_filenamev([book, 'chapter-2.md']), '# Chapter 2\n\nThe storm hit the ship.\n');
    w.openFolder(book, false);
    w.load(GLib.build_filenamev([book, 'chapter-2.md']));
    pump();

    const labels = (): string[] => {
        const out: string[] = [];
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label) out.push(widget.get_text());
            childrenOf(widget).forEach(walk);
            // The GTK 4 Expander only attaches its contents as a child when opened.
            if (widget instanceof Gtk.Expander && !widget.expanded && widget.get_child()) walk(widget.get_child()!);
        };
        walk(panel.messages);
        return out;
    };
    const all = () => labels().join('\n');
    // The last button in the messages whose labels include the text (e.g. an action under an answer).
    const button = (text: string): Gtk.Button | null => {
        let found: Gtk.Button | null = null;
        const inside = (widget: Gtk.Widget): boolean => (widget instanceof Gtk.Label && widget.get_text() === text) || childrenOf(widget).some(inside);
        const walk = (widget: Gtk.Widget) => { if (widget instanceof Gtk.Button && inside(widget)) found = widget; childrenOf(widget).forEach(walk); };
        walk(panel.messages);
        return found;
    };

    test('the panel opens through the chat option; the setting is saved', () => {
        ok(!w.chatSplit.show_sidebar, 'initially closed');
        w.setOption('chat', true);   // the app action is already directed at the folder test window, so go through this window directly
        // Wait for the panel to finish laying out: the settings popover (next test) from a button that has no
        // position on the monitor yet triggers Gdk-CRITICAL gdk_monitor_get_geometry.
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
        ok(w.chatSplit.show_sidebar, 'did not open');
        eq(w.settings.chat, true);
    });

    test('without an API key: a hint message appears and no request goes to the model', () => {
        seen.length = 0;
        settle(panel.ask('How are you?'));
        contains(all(), 'There is no DeepSeek API key yet');
        eq(seen.length, 0);
        eq(chat.session.history.length, 0);
        panel.settingsButton.get_popover()?.popdown();
        pump();
    });

    test('the key can be saved from the settings', () => {
        panel.keyEntry.set_text('sk-secret');
        panel.keyEntry.emit('activate');
        for (let i = 0; i < 100 && panel.keyEntry.text; i++) { pump(); GLib.usleep(2000); }
        eq(stored, 'sk-secret');
        eq(panel.keyEntry.text, '');   // the key does not remain in the entry field
        chat.keyStore = keyStore;
    });

    test('the question is sent with the active document, the selection, and snippets from other files', () => {
        seen.length = 0;
        setText('# Chapter 2\n\nThe storm hit the ship. Laras hid the letter.\n');
        const text = c.text();
        const start = buf().get_iter_at_offset(c.offsetIn(text, 'The storm'));
        const end = buf().get_iter_at_offset(c.offsetIn(text, 'ship.') + 5);
        buf().select_range(start, end);
        w.save();
        settle(panel.ask('Who carried the letter from her father?'));
        eq(seen.length, 1);
        eq(seen[0].model, 'deepseek-flash');
        const [system, user] = [seen[0].messages[0].content, seen[0].messages[1].content];
        contains(system, 'Laras hid the letter');                   // the active document (buffer contents)
        contains(user, '<selection>\nThe storm hit the ship.\n</selection>');
        contains(user, 'file="chapter-1.md"');                               // relevant snippet from another file
        contains(user, 'Laras carried a letter from her father');
        contains(system, '- chapter-1.md · ');                                 // the project map lists the other file
        ok(!system.includes('chapter-2.md · '), 'the active file should be on the map as "currently open"');
    });

    test('the answer is shown as markup, with the thinking process, the context breakdown, and the token usage', () => {
        const text = all();
        contains(text, 'Who carried the letter from her father?');
        contains(text, 'Laras hid the letter.');          // the ** marks are removed by the markup
        ok(!text.includes('**'), 'the markdown marks are shown raw');
        contains(text, 'Looking through the manuscript.');
        contains(text, 'Context: ≈');
        contains(text, 'Answered');   // the status card of the finished turn
        for (const action of ['Copy', 'Retry', 'Log']) ok(button(action) !== null, `no ${action} action under the answer`);
        contains(text, 'excerpt from chapter-1.md');
        contains(text, '1.5k in (1.2k from cache) · 12 out');
        ok(panel.contextButton.get_label()!.startsWith('Context · ≈'), `context button: ${panel.contextButton.get_label()}`);
        eq(chat.session.history.length, 2);
        ok(!panel.busy, 'still busy');
        eq(panel.sendButton.get_tooltip_text(), 'Send (Enter)');
    });

    test('the agent log window shows the reasoning and the model rounds, then updates itself', () => {
        panel.showLog();
        const viewer = panel.logViewer!;
        ok(viewer, 'the log window did not open');
        const rows = () => { const out: string[] = []; const walk = (x: Gtk.Widget) => { if (x instanceof Gtk.Label) out.push(x.get_text()); childrenOf(x).forEach(walk); }; walk(viewer.list); return out.join('\n'); };
        const detail = () => { const out: string[] = []; const walk = (x: Gtk.Widget) => { if (x instanceof Gtk.Label) out.push(x.get_text()); childrenOf(x).forEach(walk); }; walk(viewer.detail.widget); return out.join('\n'); };
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
        contains(rows(), 'Round 1');
        contains(rows(), 'Reasoning');
        contains(rows(), 'Answer');
        contains(detail(), 'Model and tools');   // the summary of the finished turn
        chat.session.trace.add('error', 'New event');
        for (let i = 0; i < 30 && !rows().includes('New event'); i++) { pump(); GLib.usleep(10000); }
        contains(rows(), 'New event');
        // The detail follows the newest step until the user picks one.
        contains(detail(), 'New event');
        viewer.list.select_row(viewer.list.get_row_at_index(1));
        pump();
        chat.session.trace.add('error', 'Later event');
        for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
        ok(!detail().includes('Later event'), 'the detail jumped away from what the user chose');
        viewer.window.destroy();
        panel.logViewer = null;
    });

    test('the agent log detail shows the metrics, arguments, and result of a selected tool call', () => {
        const trace = new AgentTrace();
        trace.add('turn', 'New turn: q', 'Question:\nq', { items: ['a.md'] });
        trace.begin('round', '1', 'Calling the model (round 1/10)', '', 1);
        trace.begin('tool', '1:a', 'Tool: read_file', '', 1, { args: '{\n  "path": "a.md"\n}' });
        trace.finish('tool', '1:a', 'ok', undefined, undefined, { result: '# A\nbody text' });
        trace.finish('round', '1', 'ok', 'Tokens', undefined, { usage: { prompt: 1200, cached: 0, completion: 30 } });
        const replica = new TraceReplica();
        replica.apply({ reset: true, events: [...trace.events] });
        const viewer = new LogViewer(null, replica);
        viewer.show();
        pump();
        const labels = (): string => { const out: string[] = []; const walk = (x: Gtk.Widget) => { if (x instanceof Gtk.Label) out.push(x.get_text()); childrenOf(x).forEach(walk); }; walk(viewer.detail.widget); return out.join('\n'); };
        viewer.list.select_row(viewer.list.get_row_at_index(2));
        pump();
        for (const text of ['read_file', 'Tool call', 'Result size', '"path": "a.md"', '# A', 'Copy arguments']) contains(labels(), text);
        viewer.list.select_row(viewer.list.get_row_at_index(1));
        pump();
        contains(labels(), 'Tokens in');
        contains(labels(), '1.2k');
        const shot = optVal('shot-log');
        if (shot) { viewer.list.select_row(viewer.list.get_row_at_index(2)); for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); } widgetPixbuf(viewer.window)?.savev(`${shot}-log.png`, 'png', [], []); }
        viewer.window.destroy();
    });

    test('the answer actions: Insert into note puts the answer into the open note; Retry asks the same question again', () => {
        const historyBefore = chat.session.history.length;
        const noteBefore = w.editor.getText();
        const modifiedBefore = w.editor.buffer.get_modified();
        cursorTo(noteBefore.length);
        const asked: string[] = [];
        chat.makeProvider = () => ({ chat: async req => { asked.push(String(req.messages[req.messages.length - 1].content)); req.onText('The answer.'); return { usage: null, cancelled: false, toolCalls: [], reasoning: '' }; } });
        settle(panel.ask('A question for the actions'));
        ok(button('Insert into note') !== null, 'the insert action is missing although the window can insert');
        button('Insert into note')!.emit('clicked');
        eq(w.editor.getText(), `${noteBefore}The answer.\n`);
        contains(all(), 'Inserted');
        button('Retry')!.emit('clicked');
        for (let i = 0; i < 200 && asked.length < 2; i++) { pump(); GLib.usleep(5000); }
        for (let i = 0; i < 200 && panel.busy; i++) { pump(); GLib.usleep(5000); }
        eq(asked.length, 2);
        contains(asked[1], 'A question for the actions');
        setText(noteBefore);
        w.editor.buffer.set_modified(modifiedBefore);
        chat.session.history.splice(historyBefore);   // the next tests expect the earlier conversation
        chat.makeProvider = () => provider;
    });

    test('the second question carries the history and the context is not repeated in old turns', () => {
        seen.length = 0;
        settle(panel.ask('And her father?'));
        const roles = seen[0].messages.map(m => m.role);
        eq(roles, ['system', 'user', 'assistant', 'user']);
        eq(seen[0].messages[1].content, 'Who carried the letter from her father?');
    });

    test('@name attaches the whole file; an unknown name is reported in the context breakdown', () => {
        seen.length = 0;
        settle(panel.ask('Match the style to @chapter-1 and @missing'));
        contains(seen[0].messages[seen[0].messages.length - 1].content, '<file name="chapter-1.md">');
        contains(all(), 'not found: @missing');
    });

    test('the Context popover details what will be sent for the text being typed', () => {
        panel.input.buffer.set_text('Who carried the letter?', -1);
        const popover = panel.contextButton.get_popover()!;
        popover.popup();
        pump();
        const texts: string[] = [];
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label) texts.push(widget.get_text());
            childrenOf(widget).forEach(walk);
        };
        walk(popover);
        popover.popdown();
        pump();
        const shown = texts.join('\n');
        contains(shown, 'Document: chapter-2.md (in full)');
        contains(shown, 'Excerpt: chapter-1.md');
        contains(shown, 'Total ≈');
        panel.input.buffer.set_text('', -1);
    });

    test('turning off the context options changes what is sent', () => {
        seen.length = 0;
        chat.options = { activeDocument: false, selection: false, project: false };
        settle(panel.ask('Just a general question'));
        const msgs = seen[0].messages;
        ok(!msgs[0].content.includes('Laras'), 'the manuscript was still sent');
        eq(msgs[msgs.length - 1].content, 'Just a general question');
        chat.options = { activeDocument: true, selection: true, project: true };
    });

    test('an error from the model is shown in the assistant message and does not enter the history', () => {
        const before = chat.session.history.length;
        chat.makeProvider = () => ({ chat: () => Promise.reject(new Error('Insufficient DeepSeek account balance')) });
        settle(panel.ask('Try again'));
        contains(all(), 'Insufficient DeepSeek account balance');
        eq(chat.session.history.length, before);
        ok(!panel.busy, 'the send button stayed locked after the error');
        chat.makeProvider = () => provider;
    });

    test('the send button inside the message box: disabled when empty, primary button when there is text', () => {
        const composer = panel.sendButton.get_parent()!;
        ok(composer.has_css_class('chat-composer'), 'the send button is not in the message box');
        ok(panel.input.is_ancestor(composer), 'the text box is not in the same frame');
        void panel.ask('', false);
        ok(!panel.sendButton.sensitive, 'send is active although empty');
        void panel.ask('   ', false);
        ok(!panel.sendButton.sensitive, 'send is active although only whitespace');
        void panel.ask('Hello', false);
        ok(panel.sendButton.sensitive && panel.sendButton.has_css_class('suggested-action'), 'send is not active after text was entered');
        const prefix = optVal('shot-composer');
        if (prefix) {
            const oldDark = w.dark;
            for (const dark of [false, true]) {
                w.setDark(dark);
                for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(panel.widget)?.savev(`${prefix}-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
            }
            w.setDark(oldDark);
        }
        void panel.ask('', false);
    });

    test('the stop button cancels the answer being streamed; its fragment stays shown and saved', () => {
        const before = chat.session.history.length;
        chat.makeProvider = () => ({
            chat: req => new Promise(resolve => {
                req.onText('Half the answer ');
                req.cancellable?.onCancel(() => resolve({ usage: null, cancelled: true, toolCalls: [], reasoning: '' }));
            }),
        });
        const pending = panel.ask('Tell me at length');
        for (let i = 0; i < 200 && !all().includes('Half the answer'); i++) { pump(); GLib.usleep(5000); }
        ok(panel.busy, 'should be busy');
        eq(panel.sendButton.get_tooltip_text(), 'Stop');
        ok(panel.sendButton.sensitive && !panel.sendButton.has_css_class('suggested-action'), 'the stop button must be active and not the primary button');
        panel.stop();
        settle(pending);
        contains(all(), 'Half the answer');
        contains(all(), 'Stopped');
        ok(button('Retry') !== null, 'no Retry after stopping');
        eq(chat.session.history.length, before + 2);
        ok(!panel.busy, 'still busy after being stopped');
        chat.makeProvider = () => provider;
    });

    test('typing a long message without spaces does not widen the panel or shift the editor', () => {
        w.win.set_default_size(1280, 760);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        const before = { panel: panel.widget.get_allocated_width(), editor: w.editor.widget.get_allocated_width() };
        panel.input.buffer.set_text('a'.repeat(60), -1);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        eq(panel.widget.get_allocated_width(), before.panel);
        eq(w.editor.widget.get_allocated_width(), before.editor);
        // An answer with one very long word (e.g. a URL) must not widen the panel either.
        chat.makeProvider = () => ({ chat: async req => { req.onText('x'.repeat(500)); return { usage: null, cancelled: false, toolCalls: [], reasoning: '' }; } });
        panel.input.buffer.set_text('', -1);
        settle(panel.ask('long'));
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        eq(panel.widget.get_allocated_width(), before.panel);
        chat.makeProvider = () => provider;
        panel.input.buffer.set_text('', -1);
    });

    test('Enter sends, Shift+Enter does not (new line)', () => {
        const press = (state: number) => panel.onInputKey(0xff0d, state);
        panel.input.buffer.set_text('line', -1);
        eq(press(1), false);               // Shift
        seen.length = 0;
        eq(press(0), true);
        for (let i = 0; i < 100 && !seen.length; i++) { pump(); GLib.usleep(2000); }
        eq(seen.length, 1);
        for (let i = 0; i < 100 && panel.busy; i++) { pump(); GLib.usleep(2000); }
    });

    test('a new conversation clears the messages and the history', () => {
        panel.reset();
        eq(chat.session.history.length, 0);
        ok(!all().includes('And her father?'), 'the old message is still shown');
        ok(panel.empty.get_visible(), 'the empty state is not shown');
    });

    test('the selected model is saved to the settings', () => {
        w.settings.chatModel = 'deepseek-v4-pro';
        eq(chat.model, 'deepseek-v4-pro');
        panel.modelDrop.set_selected(0);  // deepseek-flash
        eq(w.settings.chatModel, 'deepseek-flash');
    });

    test('the assistant browses the manuscript itself: the browsing steps are shown and the tool results reach the model', () => {
        let round = 0;
        let toolResult = '';
        chat.makeProvider = () => ({
            async chat(req) {
                round++;
                const last = req.messages[req.messages.length - 1];
                if (last.role === 'tool') toolResult = last.content;
                if (round === 1) {
                    return { usage: { prompt: 100, cached: 0, completion: 5 }, cancelled: false, reasoning: '',
                        toolCalls: [{ id: 'c1', name: 'search_text', arguments: '{"text":"storm"}' }, { id: 'c2', name: 'read_file', arguments: '{"name":"chapter-2"}' }] };
                }
                req.onText('The storm is in chapter 2.');
                return { usage: { prompt: 300, cached: 100, completion: 8 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        });
        settle(panel.ask('In which chapter is there a storm?'));
        const text = all();
        contains(text, 'Searching text “storm” → 1 line');
        contains(text, 'Reading chapter-2 → lines 1–');
        contains(text, 'The storm is in chapter 2.');
        contains(text, '400 in (100 from cache) · 13 out · 2 lookups');
        contains(text, '2 lookups');   // the status card of the finished turn
        contains(toolResult, 'The storm hit the ship.');
        chat.makeProvider = () => provider;
    });

    test('the old model is normalized; the thinking mode is saved and passed on to the session', () => {
        w.settings.chatModel = 'deepseek-chat';   // name from the settings of a previous version
        eq(chat.model, 'deepseek-flash');
        panel.thinkingCheck.set_active(true);
        eq(chat.session.thinking, true);
        eq(w.settings.chatThinking, true);
        panel.thinkingCheck.set_active(false);
        eq(w.settings.chatThinking, false);
    });

    // ---------- History on disk ----------
    const savedFiles = () => listChats(book);
    const rmChats = () => {
        for (const chat of savedFiles()) GLib.unlink(chat.path);
    };

    test('the conversation is saved as Markdown in .markwork/chats and that folder is not part of Git', () => {
        rmChats();
        panel.reset();
        settle(panel.ask('History question one'));
        const chats = savedFiles();
        eq(chats.length, 1, 'number of files');
        eq(chats[0].title, 'History question one');
        ok(chats[0].path.startsWith(chatsDir(book)), chats[0].path);
        ok(chats[0].path.endsWith('-history-question-one.md'), chats[0].path);
        const text = readTextFile(chats[0].path);
        contains(text, '## You\nHistory question one');
        contains(text, '## Assistant\n');
        contains(text, 'model: deepseek-flash');
        eq(readTextFile(GLib.build_filenamev([book, '.markwork', '.gitignore'])), '*\n');
    });

    test('the next turn appends to the same file', () => {
        settle(panel.ask('Follow-up one'));
        eq(savedFiles().length, 1, 'number of files');
        eq(savedFiles()[0].turns, 4);
    });

    test('the history is not read by the assistant as manuscript', () => {
        w.openFolder(book, false);
        ok(!chat.host.files().some(f => f.name.includes('.markwork')), 'the history entered the manuscript file list');
    });

    test('New conversation creates a new file; the list contains both, newest first', () => {
        panel.reset();
        settle(panel.ask('History question two'));
        const chats = savedFiles();
        eq(chats.length, 2, 'number of files');
        eq(chats.map(c => c.title).sort(), ['History question one', 'History question two']);
    });

    test('the history popover shows the title of each conversation', () => {
        const popover = panel.historyButton.get_popover()!;
        popover.popup();
        pump();
        const texts: string[] = [];
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label) texts.push(widget.get_text());
            childrenOf(widget).forEach(walk);
        };
        walk(popover);
        popover.popdown();
        pump();
        contains(texts.join('\n'), 'History question one');
        contains(texts.join('\n'), 'History question two');
    });

    test('opening an old conversation restores the messages and the history, then continues it in that file', () => {
        const first = savedFiles().find(c => c.title === 'History question one')!;
        ok(panel.openChat(first.path), 'openChat() failed');
        eq(chat.session.history.length, 4);
        ok(chat.session.trace.events.some(e => e.kind === 'turn' && e.title.includes('History question one')), 'the agent log did not come back with the conversation');
        contains(all(), 'History question one');
        contains(all(), 'Follow-up one');
        contains(all(), 'Laras hid the letter.');
        ok(!all().includes('History question two'), 'another conversation was shown too');
        seen.length = 0;
        settle(panel.ask('Follow-up two'));
        eq(seen[0].messages.map(m => m.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);   // the old history was sent along
        eq(savedFiles().length, 2, 'a new file was created although continuing');
        eq(savedFiles().find(c => c.path === first.path)?.turns, 6);
    });

    test('files that are not conversations are ignored and cannot be opened', () => {
        const stray = GLib.build_filenamev([chatsDir(book), 'notes.md']);
        GLib.file_set_contents(stray, '# Notes\n\nNot a conversation.\n');
        eq(savedFiles().length, 2, 'a foreign file entered the list');
        ok(!panel.openChat(stray), 'openChat() should have failed');
        GLib.unlink(stray);
        panel.reset();
    });

    test('the save switch is turned off: nothing is written, and the choice is saved in the settings', () => {
        rmChats();
        panel.saveCheck.set_active(false);
        eq(w.settings.chatSave, false);
        panel.reset();
        settle(panel.ask('Not to be saved'));
        eq(savedFiles().length, 0, 'a file was written although it was turned off');
        panel.saveCheck.set_active(true);
        eq(w.settings.chatSave, true);
    });

    test('without a manuscript folder nothing is written', () => {
        const rootBefore = chat.host.root;
        chat.host.root = () => null;
        panel.reset();
        settle(panel.ask('Without a folder'));
        eq(savedFiles().length, 0, 'a file was written without a folder');
        chat.host.root = rootBefore;
        panel.reset();
    });

    // ---------- Agent change proposals ----------
    const proposalProvider = (name: string, args: object): Provider => {
        let round = 0;
        return {
            async chat(req) {
                round++;
                if (round === 1) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 'u1', name, arguments: JSON.stringify(args) }] };
                req.onText('I have proposed it.');
                return { usage: { prompt: 50, cached: 0, completion: 5 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        };
    };
    // Send a question, wait for the review window to open, take its diff text, then press its button and wait for the turn to finish.
    let lastDiff = '';
    let shotCount = 0;
    const proposeAndPress = (provider: Provider, button: 'apply' | 'reject' | 'close', prepare?: (viewer: ProposalViewer) => void): void => {
        chat.makeProvider = () => provider;
        panel.reset();
        const done = panel.ask('Please change');
        for (let i = 0; i < 300 && !panel.viewer; i++) { pump(); GLib.usleep(5000); }
        const viewer = panel.viewer;
        ok(viewer, 'the review window did not open');
        lastDiff = viewer.diffView.buffer.text;
        // --shot-proposal=<prefix>: save screenshots of the review window and the main window (<prefix>-<n>-review.png) for visual inspection.
        const prefix = optVal('shot-proposal');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            const n = shotCount++;
            widgetPixbuf(viewer.window)?.savev(`${prefix}-${n}-review.png`, 'png', [], []);
            widgetPixbuf(w.win)?.savev(`${prefix}-${n}-main.png`, 'png', [], []);
            const oldDark = w.dark;
            w.setDark(!oldDark);
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(viewer.window)?.savev(`${prefix}-${n}-review-${oldDark ? 'light' : 'dark'}.png`, 'png', [], []);
            widgetPixbuf(w.win)?.savev(`${prefix}-${n}-main-${oldDark ? 'light' : 'dark'}.png`, 'png', [], []);
            w.setDark(oldDark);
        }
        const agenticShot = optVal('shot-agentic');
        if (agenticShot && Array.isArray(viewer.change)) {
            const oldDark = w.dark;
            for (const dark of [false, true]) {
                w.setDark(dark);
                // An open review window must follow theme changes.
                for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(viewer.window)?.savev(`${agenticShot}-batch-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
            }
            w.setDark(oldDark);
        }
        prepare?.(viewer);
        if (button === 'apply') viewer.applyButton.emit('clicked');
        else if (button === 'reject') viewer.rejectButton.emit('clicked');
        else viewer.window.destroy();
        settle(done);
        chat.makeProvider = () => provider;
    };
    const diskOf = (name: string) => readTextFile(GLib.build_filenamev([book, name]));

    test('edit proposal: the card shows the diff; Apply changes the editor and can be undone, disk is not touched yet', () => {
        setText('# Chapter 2\n\nThe storm hit the ship.\n');
        w.editor.buffer.set_modified(false);
        const diskBefore = diskOf('chapter-2.md');
        proposeAndPress(proposalProvider('edit_file', { name: 'chapter-2.md', old_text: 'The storm hit the ship.', new_text: 'The storm hit the ship hard.', reason: 'clearer' }), 'apply');
        const text = all();
        contains(text, 'Edit chapter-2.md');
        contains(lastDiff, '@@ -1,3 +1,3 @@');
        contains(lastDiff, '-The storm hit the ship.');
        contains(lastDiff, '+The storm hit the ship hard.');
        contains(text, 'Applied.');
        contains(text, '1 change applied');
        eq(w.editor.getText(), '# Chapter 2\n\nThe storm hit the ship hard.\n');
        eq(diskOf('chapter-2.md'), diskBefore);
        w.editor.buffer.undo();
        eq(w.editor.getText(), '# Chapter 2\n\nThe storm hit the ship.\n');
    });

    test('an edit proposal on a file that is not open is written to disk after Apply', () => {
        proposeAndPress(proposalProvider('edit_file', { name: 'chapter-1', old_text: 'carried a letter from her father', new_text: 'carried a letter from her mother', reason: 'x' }), 'apply');
        contains(diskOf('chapter-1.md'), 'carried a letter from her mother');
    });

    test('Reject: the file does not change and the model is told', () => {
        const before = diskOf('chapter-1.md');
        proposeAndPress(proposalProvider('edit_file', { name: 'chapter-1.md', old_text: 'Raka met Laras', new_text: 'Raka met Hasan', reason: 'x' }), 'reject');
        eq(diskOf('chapter-1.md'), before);
        contains(all(), 'Rejected.');
        ok(!all().includes('changes applied'), 'counted as applied');
    });

    test('closing the review window is the same as rejecting', () => {
        const before = diskOf('chapter-1.md');
        proposeAndPress(proposalProvider('edit_file', { name: 'chapter-1.md', old_text: 'Raka met Laras', new_text: 'Raka met Hasan', reason: 'x' }), 'close');
        eq(diskOf('chapter-1.md'), before);
        contains(all(), 'Rejected.');
    });

    test('Stop while a proposal is waiting: the review window closes and the card becomes Cancelled', () => {
        chat.makeProvider = () => proposalProvider('edit_file', { name: 'chapter-1.md', old_text: 'Raka met Laras', new_text: 'x', reason: 'x' });
        panel.reset();
        const before = diskOf('chapter-1.md');
        const done = panel.ask('Please change');
        for (let i = 0; i < 300 && !panel.viewer; i++) { pump(); GLib.usleep(5000); }
        ok(panel.viewer, 'the review window did not open');
        panel.stop();
        settle(done);
        contains(all(), 'Cancelled.');
        eq(panel.viewer, null);
        eq(diskOf('chapter-1.md'), before);
    });

    test('new file proposal: Apply writes it and opens it in a tab', () => {
        proposeAndPress(proposalProvider('create_file', { name: 'plans/october', content: '# October\n\n- Write chapter 3\n', reason: 'plan for this month' }), 'apply');
        eq(diskOf('plans/october.md'), '# October\n\n- Write chapter 3\n');
        contains(all(), 'New file plans/october.md');
        contains(lastDiff, '@@ -0,0 +1,3 @@');
        ok(w.file?.endsWith('/plans/october.md'), `active tab:  ${w.file}`);
        ok(w.closeTab(), 'closeTab() failed');
        pump();
    });

    test('kanban board proposal: adding and moving a card appears on the open board', () => {
        const board =  GLib.build_filenamev([book, 'tasks.md']);
        GLib.file_set_contents(board, '---\nlayout: board\n---\n\n## Plan\n\n- [ ] Write report #important\n- [ ] Send invitations [due:: 2026-10-20]\n\n## In Progress\n\n- [ ] Research the harbor\n\n## Done\n\n- [x] Book the venue\n');
        w.openFile(board);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(8000); }
        ok(w.boardMode, 'the board did not open as a board');

        const press = (provider: Provider) => { proposeAndPress(provider, 'apply'); for (let i = 0; i < 40; i++) { pump(); GLib.usleep(8000); } };   // the board reloads in idle
        try {
        press(proposalProvider('edit_note', { name: 'tasks', action: 'add', text: 'Draft the revision schedule', fields: { due: '2026-11-02' }, group: 'in progress', reason: 'user request' }));
        contains(lastDiff, '+- [ ] Draft the revision schedule [due:: 2026-11-02]');
        eq(w.board.getBoard().columns[1].cards.map(c => c.text), ['Research the harbor', 'Draft the revision schedule [due:: 2026-11-02]']);

        press(proposalProvider('edit_note', { name: 'tasks', action: 'move', note: 'Send invitations', group: 'Done', reason: 'already sent' }));
        eq(w.board.getBoard().columns[2].cards.map(c => c.text), ['Book the venue', 'Send invitations [due:: 2026-10-20]']);
        eq(w.board.getBoard().columns[0].cards.map(c => c.text), ['Write report #important']);
        const prefix = optVal('shot-proposal');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-board.png`, 'png', [], []);
        }
        } finally {
            w.editor.buffer.set_modified(false);   // do not show the save dialog when closing the tab
            ok(w.closeTab(), 'closeTab() failed');
            pump();
        }
    });

    test('multi-file batch: one decision applies all diffs and the journal is restored', () => {
        const actions = ['plans/batch-a', 'plans/batch-b'].map(name => ({ tool: 'create_file', arguments: JSON.stringify({ name, content: '# Release schedule\n\nRelease: 22 November\n', reason: 'Sync the meeting decisions in one batch' }) }));
        proposeAndPress(proposalProvider('propose_batch', { actions }), 'apply');
        contains(lastDiff, 'File: plans/batch-a.md');
        contains(lastDiff, 'File: plans/batch-b.md');
        eq(diskOf('plans/batch-a.md'), diskOf('plans/batch-b.md'));
        contains(all(), 'Applied.');
        const saved = listChats(book).find(chat => readTextFile(chat.path).includes('propose_batch'));
        ok(saved, 'the batch checkpoint was not saved');
        ok(panel.openChat(saved.path), 'restoring failed');
        eq(chat.session.events.find(e => e.tool === 'propose_batch')?.status, 'applied');
        contains(all(), 'Applied: propose_batch');
        const prefix = optVal('shot-agentic');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-journal.png`, 'png', [], []);
        }
    });

    test('the plan checkpoint opens again with the resume button, light and dark theme', () => {
        panel.reset();
        chat.makeProvider = () => proposalProvider('set_work', { goal: 'Sync the release schedule', steps: [{ text: 'Read the meeting decisions', status: 'done' }, { text: 'Check the plan and task cards', status: 'pending' }], note: 'Release date: 22 November' });
        settle(panel.ask('Sync the release schedule'));
        // The plan is shown as a checklist: one row per step, not "- [x]" text, and not repeated in the step row.
        const workRows = (): Gtk.Widget[] => {
            const out: Gtk.Widget[] = [];
            const walk = (widget: Gtk.Widget) => {
                if (widget.has_css_class('chat-work-step')) out.push(widget);
                childrenOf(widget).forEach(walk);
            };
            walk(panel.messages);
            return out;
        };
        eq(workRows().length, 2);
        ok(workRows()[0].get_first_child()?.has_css_class('work-done'), 'the finished step is not checked');
        ok(workRows()[1].get_first_child()?.has_css_class('work-pending'), 'the next step is not an empty circle');
        contains(all(), '1/2 steps');
        ok(!all().includes('- [x]'), 'the plan is still shown as raw text');
        ok(!all().includes('Work plan →'), 'the plan is repeated in the step row');
        const saved = listChats(book).find(chat => readTextFile(chat.path).includes('work:'));
        ok(saved, 'the plan was not saved');
        ok(panel.openChat(saved.path), 'the plan did not open');
        eq(chat.session.work?.status, 'paused');
        const resume = childrenOf(panel.messages).find(w => w instanceof Gtk.Button && w.get_label() === 'Resume work');
        ok(resume, 'the resume button is missing');
        eq(workRows().length, 2);
        const prefix = optVal('shot-agentic');
        if (prefix) {
            const oldDark = w.dark;
            for (const dark of [false, true]) {
                w.setDark(dark);
                for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(w.win)?.savev(`${prefix}-plan-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
            }
            w.setDark(oldDark);
        }
        panel.reset();
    });

    // A provider that records the tool results sent back, to check the user's note.
    const toolReplies: string[] = [];
    const recording = (name: string, args: object): Provider => {
        const inner = proposalProvider(name, args);
        return { chat: req => { for (const m of req.messages) if (m.role === 'tool') toolReplies.push(m.content); return inner.chat(req); } };
    };
    const buttons = (): Gtk.Button[] => {
        const out: Gtk.Button[] = [];
        const walk = (widget: Gtk.Widget) => { if (widget instanceof Gtk.Button) out.push(widget); childrenOf(widget).forEach(walk); };
        walk(panel.messages);
        return out;
    };

    test('batch: uncheck one file → only the checked ones are applied; Undo restores them', () => {
        GLib.file_set_contents(GLib.build_filenamev([book, 'schedule-a.md']), 'Release 15 November\n');
        GLib.file_set_contents(GLib.build_filenamev([book, 'schedule-b.md']), 'Release 15 November\n');
        const actions = ['schedule-a', 'schedule-b'].map(name => ({ tool: 'edit_file', arguments: JSON.stringify({ name, old_text: '15 November', new_text: '22 November', reason: 'meeting decision' }) }));
        toolReplies.length = 0;
        proposeAndPress(recording('propose_batch', { actions }), 'apply', viewer => {
            eq(viewer.checks.length, 2);
            viewer.checks[1].set_active(false);
            eq(viewer.applyButton.get_label(), 'Apply 1 of 2');
            viewer.noteEntry.set_text('schedule-b is waiting for confirmation');
            const prefix = optVal('shot-proposal');
            if (prefix) {
                for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(viewer.window)?.savev(`${prefix}-partial.png`, 'png', [], []);
            }
        });
        contains(diskOf('schedule-a.md'), '22 November');
        contains(diskOf('schedule-b.md'), '15 November');
        contains(all(), 'Applied 1 of 2 files.');
        ok(toolReplies.some(m => m.includes('Rejected (do not repeat without asking): schedule-b.md') && m.includes('User note: schedule-b is waiting for confirmation')), toolReplies.join('\n'));
        const undo = buttons().find(b => b.get_label() === 'Undo' && b.get_visible());
        ok(undo, 'the Undo button is missing');
        const prefix = optVal('shot-proposal');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-undo.png`, 'png', [], []);
        }
        undo.emit('clicked');
        eq(diskOf('schedule-a.md'), 'Release 15 November\n');
        contains(all(), 'Undone.');
        eq(chat.session.events.map(e => e.status), ['reverted', 'rejected']);
    });

    test('Undo fails without overwriting if the file has been edited again', () => {
        proposeAndPress(proposalProvider('edit_file', { name: 'schedule-a', old_text: '15 November', new_text: '23 November', reason: 'x' }), 'apply');
        GLib.file_set_contents(GLib.build_filenamev([book, 'schedule-a.md']), 'Edited by the user\n');
        buttons().find(b => b.get_label() === 'Undo')!.emit('clicked');
        eq(diskOf('schedule-a.md'), 'Edited by the user\n');
        contains(all(), 'Cannot be undone: schedule-a.md changed since it was proposed');
        eq(chat.session.events[0].status, 'applied');
    });

    test('Reject with a note: the note reaches the model and appears on the card', () => {
        toolReplies.length = 0;
        proposeAndPress(recording('edit_file', { name: 'chapter-1.md', old_text: 'Raka met Laras', new_text: 'Raka met Hasan', reason: 'x' }), 'reject', viewer => viewer.noteEntry.set_text('The name stays Laras'));
        contains(all(), 'Rejected: The name stays Laras');
        ok(toolReplies.some(m => m.includes('User note: The name stays Laras')), toolReplies.join('\n'));
    });

    test('move an open file: the tab follows the new path; Undo moves it back', () => {
        const from = GLib.build_filenamev([book, 'moved.md']);
        GLib.file_set_contents(from, '# Moved\n');
        w.openFile(from);
        pump();
        try {
            proposeAndPress(proposalProvider('move_file', { name: 'moved', destination: 'archive/moved', reason: 'archive it' }), 'apply');
            contains(lastDiff, 'Move: moved.md → archive/moved.md (contents unchanged)');
            eq(diskOf('archive/moved.md'), '# Moved\n');
            ok(!GLib.file_test(from, GLib.FileTest.EXISTS), 'the source still exists');
            eq(w.file, GLib.build_filenamev([book, 'archive', 'moved.md']));
            buttons().find(b => b.get_label() === 'Undo')!.emit('clicked');
            eq(w.file, from);
            ok(GLib.file_test(from, GLib.FileTest.EXISTS), 'did not move back');
        } finally {
            w.editor.buffer.set_modified(false);
            ok(w.closeTab(), 'closeTab() failed');
            pump();
        }
    });

    test('delete file: moved to the Trash after Apply, rejecting leaves it untouched', () => {
        const path = GLib.build_filenamev([book, 'obsolete.md']);
        GLib.file_set_contents(path, '# Obsolete\n');
        proposeAndPress(proposalProvider('delete_file', { name: 'obsolete', reason: 'duplicate' }), 'reject');
        ok(GLib.file_test(path, GLib.FileTest.EXISTS), 'deleted although rejected');
        proposeAndPress(proposalProvider('delete_file', { name: 'obsolete', reason: 'duplicate' }), 'apply');
        contains(lastDiff, 'Moved to the Trash: obsolete.md');
        contains(lastDiff, '-# Obsolete');
        if (all().includes('Failed to apply')) return;   // an environment without a Trash
        ok(!GLib.file_test(path, GLib.FileTest.EXISTS), 'the file still exists');
    });

    test('applying rejects content that changed since it was proposed and paths outside the folder', () => {
        const apply = chat.host.applyChange!;
        const stale = apply({ kind: 'edit', file: 'chapter-1.md', before: 'old content', after: 'new content', reason: '' });
        contains(stale ?? '', 'changed since it was proposed');
        contains(apply({ kind: 'create', file: '../outside.md', before: '', after: 'x', reason: '' }) ?? '', 'outside the work folder');
        ok(!GLib.file_test(GLib.build_filenamev([tmp, 'outside.md']), GLib.FileTest.EXISTS), 'a file was written outside the folder');
        contains(apply({ kind: 'create', file: 'chapter-1.md', before: '', after: 'x', reason: '' }) ?? '', 'already exists');
    });

    test('long answer: the panel sticks to the bottom down to the last line and the footer is visible', () => {
        const long = Array.from({ length: 14 }, (_, i) => `${i + 1}. **Item ${i + 1}** — example \`code ${i}\` with a sentence long enough to wrap onto several lines in a narrow panel.`).join('\n')
            + '\n\nIf you like, I can propose one concrete change. Shall I draft the proposal?';
        chat.makeProvider = () => ({
            async chat(req) {
                for (const part of long.match(/\S+\s*/g) ?? []) req.onText(part);
                return { usage: { prompt: 3600, cached: 3000, completion: 400 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        });
        panel.reset();
        settle(panel.ask('Give long feedback'));
        const vadj = panel.scroller.get_vadjustment();
        for (let i = 0; i < 60; i++) { pump(); GLib.usleep(10000); }
        ok(vadj.get_upper() > vadj.get_page_size(), 'the answer is not long enough to scroll');
        // The adjustment value alone is not enough (it was once right while the picture was cut off): check the actual footer position
        // inside the visible area.
        let footer: Gtk.Label | null = null;
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label && widget.get_text().startsWith('3.6k in')) footer = widget;
            childrenOf(widget).forEach(walk);
        };
        walk(panel.messages);
        ok(footer, 'the token usage footer is missing');
        const bounds = (footer as Gtk.Label).compute_bounds(panel.scroller);
        ok(bounds[0], 'the footer position could not be read');
        const bottom = bounds[1].get_y() + bounds[1].get_height();
        ok(bounds[1].get_y() >= 0 && bottom <= panel.scroller.get_height() + 1, `footer outside the visible area: y=${bounds[1].get_y().toFixed(0)}, bottom=${bottom.toFixed(0)}, height=${panel.scroller.get_height()}`);
        const prefix = optVal('shot-chat');
        if (prefix) {
            widgetPixbuf(w.win)?.savev(`${prefix}.png`, 'png', [], []);
            const oldDark = w.dark;
            w.setDark(!oldDark);
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-${oldDark ? 'light' : 'dark'}.png`, 'png', [], []);
            w.setDark(oldDark);
        }
        chat.makeProvider = () => provider;
        panel.reset();
    });

    test('closing the panel', () => {
        w.setOption('chat', false);
        pump();
        ok(!w.chatSplit.show_sidebar, 'did not close');
        eq(w.settings.chat, false);
    });

    cursorTo(0);

    function buf() { return w.editor.buffer; }
}
