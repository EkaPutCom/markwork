// Assistant tests: context composition (agent/context.ts), reading the SSE stream, answer markup, and the conversation session.
// Without a GUI and a network; the model is replaced by a fake provider.

import { buildContext, buildMessages, estimateTokens, findMentions, headingsOf, matchMention, rankChunks, splitChunks, tokenize, type ContextInput, type SourceFile } from '../../src/agent/context';
import { httpErrorMessage, parseStreamLine } from '../../src/agent/sse';
import { ChatSession, MAX_ROUNDS, type ToolStep } from '../../src/agent/session';
import { describeCall, runTool } from '../../src/agent/tools';
import { toApiMessage } from '../../src/agent/deepseek';
import type { ChatMessage, ChatRequest, ChatResult, Provider } from '../../src/agent/provider';
import { systemKeyStore } from '../../src/agent/apikey';
import { section, test, eq, ok, contains, within } from '../core/framework';
import { host } from '../core/host';
import { platform } from '../../src/platform/index';

const CH1 = `# Chapter 1: The Harbor

Raka was seventeen years old when he first saw the ship White Seagull.

## The Meeting

On the pier, Raka met Laras. Laras carried a letter from the village.
`;

const CH2 = `# Chapter 2: The Voyage

The White Seagull left the harbor at dawn. Captain Hasan led the voyage.

## The Storm

The storm hit on the third night. Laras hid the letter inside a jacket.
`;

const CH3 = `# Chapter 3: The Island

They found an island without a name. No one knows who owns it.
`;

const FILES: SourceFile[] = [{ name: 'chapter-1.md', text: CH1 }, { name: 'chapter-3.md', text: CH3 }];

const input = (over: Partial<ContextInput> = {}): ContextInput => ({
    question: 'What happened to the letter of Laras?',
    recent: [],
    active: { name: 'chapter-2.md', text: CH2, cursorLine: 6 },
    selection: '',
    files: FILES,
    mentions: [],
    options: { activeDocument: true, selection: true, project: true },
    budget: 48_000,
    ...over,
});

export async function agentTests(): Promise<void> {
    section('Assistant: splitting and searching the manuscript');

    await test('headingsOf ignores # inside a code block', async () => {
        eq(headingsOf('# A\n```\n# not\n```\n## B\n').map(h => h.text), ['A', 'B']);
    });

    await test('splitChunks cuts per heading with the heading path and line numbers', async () => {
        const chunks = splitChunks('chapter-1.md', CH1);
        eq(chunks.map(c => c.heading), ['Chapter 1: The Harbor', 'Chapter 1: The Harbor › The Meeting']);
        eq(chunks.map(c => [c.start, c.end]), [[0, 3], [4, 7]]);
        contains(chunks[1].text, 'Laras carried a letter');
    });

    await test('splitChunks splits a long section at paragraph boundaries and loses no lines', async () => {
        const para = 'long sentence '.repeat(40);   // ±560 characters
        const text = `# Title\n\n${[1, 2, 3, 4, 5].map(() => para).join('\n\n')}\n`;
        const chunks = splitChunks('x.md', text);
        ok(chunks.length > 1, 'not split');
        ok(chunks.every(c => c.text.length < 3000), 'a chunk is too large');
        eq(chunks.map(c => c.text).join('\n').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
    });

    await test('tokenize drops common words and strips suffixes', async () => {
        eq(tokenize('Who is the character carrying the letter?'), ['character', 'carrying', 'letter']);
        eq(tokenize('Chapter 12 and 7'), ['12', '7']);   // numbers still count (years, numbers), common words do not
    });

    await test('rankChunks puts the most relevant chunk on top and drops the ones that do not match', async () => {
        const chunks = [...splitChunks('chapter-1.md', CH1), ...splitChunks('chapter-3.md', CH3)];
        const ranked = rankChunks(chunks, new Map(tokenize('island without name').map(t => [t, 1])));
        eq(ranked.length, 1);
        eq(ranked[0].chunk.file, 'chapter-3.md');
        eq(rankChunks(chunks, new Map([['zzz', 1]])).length, 0);
    });

    section('Assistant: building the context');

    await test('the whole active document goes into the system part, the question does not', async () => {
        const b = buildContext(input());
        contains(b.system, '<active_document>\n');
        contains(b.system, 'Captain Hasan');
        ok(!b.system.includes('What happened to the letter'), 'the question leaked into system');
        ok(b.items.some(i => i.kind === 'active' && i.label.includes('in full')), 'no active document item');
    });

    await test('system is identical between questions (a stable prefix for the cache) as long as the manuscript is the same', async () => {
        const a = buildContext(input({ question: 'Who is Laras?' }));
        const b = buildContext(input({ question: 'Where is that island?' }));
        eq(a.system, b.system);
        ok(a.note !== b.note, 'the extra context should follow the question');
    });

    await test('relevant excerpts from other files go into the extra context, irrelevant ones do not', async () => {
        const b = buildContext(input({ question: 'Who carried the letter from the village?' }));
        contains(b.note, 'file="chapter-1.md"');
        contains(b.note, 'Laras carried a letter from the village');
        ok(!b.note.includes('island without a name'), 'an irrelevant excerpt came along');
        ok(b.items.some(i => i.kind === 'excerpt'), 'no excerpt item');
    });

    await test('a follow-up question uses the previous question to search ("and he?")', async () => {
        const b = buildContext(input({ question: 'Then why was he disappointed?', recent: ['Tell me about the island without a name'] }));
        contains(b.note, 'chapter-3.md');
    });

    await test('the selection and cursor position are in the extra context', async () => {
        const b = buildContext(input({ selection: 'The storm hit on the third night.' }));
        contains(b.note, '<selection>\nThe storm hit on the third night.\n</selection>');
        contains(b.note, 'chapter-2.md, line 7, section “Chapter 2: The Voyage › The Storm”');
    });

    await test('an @mention attaches a whole file; unknown ones are reported', async () => {
        const b = buildContext(input({ question: 'Compare with @chapter-3 and @missing', mentions: ['chapter-3', 'missing'] }));
        contains(b.note, '<file name="chapter-3.md">');
        eq(b.unknownMentions, ['missing']);
        ok(b.items.some(i => i.kind === 'mention'), 'no attachment item');
    });

    await test('numbered manuscript lines in the active document, excerpts, and attachments (the original numbers, including in the cursor window)', async () => {
        const b = buildContext(input({ question: 'Who carried the letter from the village?', mentions: ['chapter-3'] }));
        contains(b.system, '7│ The storm hit on the third night.');
        contains(b.note, '7│ On the pier, Raka met Laras.');       // an excerpt from chapter-1: the line number in its file
        contains(b.note, '3│ They found an island without a name.');   // attachment
        contains(b.system, 'do not quote it');
        const filler = Array.from({ length: 4000 }, (_, i) => `Line ${i} in chapter 99.`).join('\n');
        const w = buildContext(input({ active: { name: 'active.md', text: `# Active\n\n${filler}\n`, cursorLine: 2502 }, budget: 12_000 }));
        contains(w.system, '2503│ Line 2500 in chapter 99.');
    });

    await test('the instructions do not tell the model to ask the writer to attach files (with or without tools)', async () => {
        const withTools = buildContext(input());
        const without = buildContext(input({ options: { activeDocument: true, selection: true, project: false } }));
        ok(!withTools.system.includes('@filename') && !without.system.includes('@filename'), 'the instructions still suggest @filename');
        contains(withTools.system, 'search_text');
        ok(!without.system.includes('search_text'), 'tool instructions are present although no tools were given');
    });

    await test('options turned off: without the active document, selection, or project', async () => {
        const none = buildContext(input({ selection: 'x', options: { activeDocument: false, selection: false, project: false } }));
        ok(!none.system.includes('<active_document>\n') && !none.system.includes('<project_map>\n'), 'system still contains the manuscript');
        ok(!none.system.includes('Captain Hasan'), 'the manuscript contents were sent');
        eq(none.note, '');
        eq(none.items, []);
    });

    await test('the project map contains the file list with headings and marks the open file', async () => {
        const b = buildContext(input());
        contains(b.system, '- chapter-1.md · ');
        contains(b.system, 'Chapter 1: The Harbor | The Meeting');
        contains(b.system, '- chapter-2.md (currently open)');
    });

    await test('the token budget is not exceeded on a large book; the active document is truncated around the cursor', async () => {
        const filler = (n: number) => Array.from({ length: 4000 }, (_, i) => `Line ${i} in chapter ${n} contains an ordinary sentence about sailing and the sea.`).join('\n');
        const big = Array.from({ length: 12 }, (_, i) => ({ name: `chapter-${i}.md`, text: `# Chapter ${i}\n\n${filler(i)}\n\nThe character Wicaksono appears here in chapter ${i}.\n` }));
        const active = { name: 'active.md', text: `# Active\n\n${filler(99)}\n`, cursorLine: 2500 };
        const budget = 12_000;
        const b = buildContext(input({ active, files: big, budget, question: 'Who is Wicaksono?' }));
        ok(b.tokens <= budget, `context ${b.tokens} exceeds the budget ${budget}`);
        ok(b.items.some(i => i.kind === 'active' && i.label.includes('lines')), 'the active document should have been truncated');
        contains(b.system, 'Line 2500 in chapter 99');
        ok(!b.system.includes('Line 10 in chapter 99'), 'a part far from the cursor came along');
        contains(b.system, 'partial="yes"');
        contains(b.note, 'Wicaksono');
    });

    await test('matchMention: full name, without extension, or path suffix; findMentions reads @ in text', async () => {
        const files = [{ name: 'chapter/01-start.md', text: '' }, { name: 'notes.md', text: '' }];
        eq(matchMention('notes', files)?.name, 'notes.md');
        eq(matchMention('@Notes.MD', files)?.name, 'notes.md');
        eq(matchMention('01-start', files)?.name, 'chapter/01-start.md');
        eq(matchMention('nonexistent', files), null);
        eq(findMentions('See @chapter/01-start.md, then (@notes). email a@b.c is not'), ['chapter/01-start.md', 'notes']);
    });

    await test('buildMessages trims the oldest history in pairs and attaches the context only to the last message', async () => {
        const built = buildContext(input());
        const turn = (i: number) => [{ role: 'user' as const, content: `ask ${i} ${'x'.repeat(300)}` }, { role: 'assistant' as const, content: `reply ${i} ${'y'.repeat(300)}` }];
        const history = [0, 1, 2, 3].flatMap(turn);
        const msgs = buildMessages(built, history, 'new question', 400);
        eq(msgs[0].role, 'system');
        eq(msgs[1].role, 'user');                   // the history still starts with a user turn
        ok(msgs.length < 1 + history.length + 1, 'the history was not trimmed');
        contains(msgs[msgs.length - 1].content, '<extra_context>');
        contains(msgs[msgs.length - 1].content, 'new question');
        ok(msgs.slice(1, -1).every(m => !m.content.includes('<extra_context>')), 'context leaked into the history');
        eq(buildMessages(buildContext(input({ options: { activeDocument: false, selection: false, project: false } })), [], 'hello', 1000)[1].content, 'hello');
    });

    await test('estimateTokens is conservative', async () => {
        eq(estimateTokens('a'.repeat(300)), 100);
    });

    section('Assistant: the SSE stream and errors');

    await test('parseStreamLine reads text, reasoning, usage, tool fragments, and [DONE]; it ignores the rest', async () => {
        const chunk = (over: object) => ({ kind: 'chunk', text: '', reasoning: '', tools: [], usage: null, ...over });
        eq(parseStreamLine('data: {"choices":[{"delta":{"content":"Hello"}}]}'), chunk({ text: 'Hello' }));
        eq(parseStreamLine('data: {"choices":[{"delta":{"reasoning_content":"hmm","content":null}}]}'), chunk({ reasoning: 'hmm' }));
        eq(parseStreamLine('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":64}}'), chunk({ usage: { prompt: 100, cached: 64, completion: 20 } }));
        eq(parseStreamLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search_text","arguments":"{\\"te"}}]}}]}'),
            chunk({ tools: [{ index: 0, id: 'c1', name: 'search_text', arguments: '{"te' }] }));
        eq(parseStreamLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ks\\":1}"}}]}}]}'),
            chunk({ tools: [{ index: 0, arguments: 'ks":1}' }] }));
        eq(parseStreamLine('data: [DONE]'), { kind: 'done' });
        eq(parseStreamLine(': keep-alive'), null);
        eq(parseStreamLine(''), null);
        eq(parseStreamLine('data: {broken'), null);
        eq(parseStreamLine('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}'), null);
    });

    await test('httpErrorMessage explains common statuses and includes the server message', async () => {
        contains(httpErrorMessage(401, '{"error":{"message":"Authentication Fails"}}'), 'API key rejected');
        contains(httpErrorMessage(401, '{"error":{"message":"Authentication Fails"}}'), 'Authentication Fails');
        contains(httpErrorMessage(402, ''), 'balance');
        contains(httpErrorMessage(418, 'not json'), 'status 418');
    });

    section('Assistant: conversation session');

    const fake = (reply: string, seen: ChatRequest[] = []): Provider => ({
        async chat(req) {
            seen.push(req);
            for (const word of reply.split(' ')) req.onText(`${word} `);
            return { usage: { prompt: 10, cached: 0, completion: 3 }, cancelled: false, toolCalls: [], reasoning: '' };
        },
    });

    await test('ask streams the answer, saves the history, and the next question carries the history without the old context', async () => {
        const session = new ChatSession();
        const seen: ChatRequest[] = [];
        const chunks: string[] = [];
        const { text, usage } = await within(session.ask({ ...input(), question: 'Who is Laras?' }, fake('a girl who carries a letter', seen), 'm',
            { onContext: () => {}, onText: d => chunks.push(d), onReasoning: () => {} }));
        eq(text.trim(), 'a girl who carries a letter');
        eq(chunks.length, 6);
        eq(usage?.prompt, 10);
        eq(session.history.length, 2);
        await within(session.ask({ ...input(), question: 'And the father?' }, fake('not mentioned', seen), 'm', { onContext: () => {}, onText: () => {}, onReasoning: () => {} }));
        const second = seen[1].messages;
        eq(second.map(m => m.role), ['system', 'user', 'assistant', 'user']);
        eq(second[1].content, 'Who is Laras?');                      // history: the plain question
        ok(!second[1].content.includes('<extra_context>'), 'the old context was sent again');
    });

    await test('a provider error does not add to the history', async () => {
        const session = new ChatSession();
        const broken: Provider = { chat: () => Promise.reject(new Error('failed')) };
        let failed = false;
        try {
            await within(session.ask({ ...input() }, broken, 'm', { onContext: () => {}, onText: () => {}, onReasoning: () => {} }));
        } catch (e) {
            failed = true;
        }
        ok(failed, 'the error was not propagated');
        eq(session.history.length, 0);
    });
}

export async function apiKeyTests(): Promise<void> {
    section('Assistant: API key');
    await test('the DEEPSEEK_API_KEY environment variable takes precedence over other storage', async () => {
        const before = platform().env('DEEPSEEK_API_KEY');
        host().setenv('DEEPSEEK_API_KEY', '  sk-from-env \n');
        try {
            eq(await within(systemKeyStore.get()), { key: 'sk-from-env', source: 'env' });
        } finally {
            if (before === null) host().setenv('DEEPSEEK_API_KEY', null); else host().setenv('DEEPSEEK_API_KEY', before);
        }
    });
}

export async function toolTests(): Promise<void> {
    const files: SourceFile[] = [
        { name: 'chapter-1.md', text: CH1 },
        { name: 'chapter-2.md', text: CH2 },
        { name: 'chapter-3.md', text: CH3 },
        { name: 'notes/characters.md', text: '# Characters\n\n- Laras: letter carrier\n- Hasan: captain\n' },
    ];

    section('Assistant: browsing tools');

    await test('list_files names all files together with their headings', async () => {
        const r = runTool('list_files', '', files);
        contains(r.content, '- chapter-1.md · ');
        contains(r.content, 'notes/characters.md');
        contains(r.content, 'Chapter 2: The Voyage');
        eq(r.summary, '4 files');
    });

    await test('search_text: exact occurrences with the file name and line number, case-insensitive', async () => {
        const r = runTool('search_text', '{"text":"laras"}', files);
        contains(r.content, 'chapter-1.md:7: On the pier, Raka met Laras. Laras carried a letter from the village.');
        contains(r.content, 'chapter-2.md:7: The storm hit');
        contains(r.content, 'notes/characters.md:3: - Laras: letter carrier');
        eq(r.summary, '3 lines');
        const only = runTool('search_text', '{"text":"Laras","file":"chapter-2"}', files);
        ok(!only.content.includes('chapter-1.md'), 'the file filter was ignored');
        contains(runTool('search_text', '{"text":"Zebua"}', files).content, 'not found');
    });

    await test('search_text limits the number of lines and reports the rest', async () => {
        const many = [{ name: 'x.md', text: Array.from({ length: 100 }, (_, i) => `Raka number ${i}`).join('\n') }];
        const r = runTool('search_text', '{"text":"raka"}', many);
        contains(r.content, '100 lines contain');
        contains(r.content, '60 more occurrences not shown');
        eq(r.content.split('\n').filter(l => l.startsWith('x.md:')).length, 40);
    });

    await test('search_documents returns the most relevant chunk together with its location', async () => {
        const r = runTool('search_documents', '{"query":"island without a name"}', files);
        contains(r.content, '[chapter-3.md › Chapter 3: The Island · lines 1–');
        contains(r.content, 'island without a name');
        eq(r.summary, '1 snippet');
        contains(runTool('search_documents', '{"query":"zzz qqq"}', files).content, 'No document section matches');
    });

    await test('read_file: with line numbers, can be a range, knows the total number of lines', async () => {
        const all = runTool('read_file', '{"name":"chapter-3"}', files);
        contains(all.content, '[chapter-3.md, lines 1–');
        contains(all.content, '1│ # Chapter 3: The Island');
        const part = runTool('read_file', '{"name":"chapter-1.md","from_line":5,"to_line":6}', files);
        contains(part.content, '[chapter-1.md, lines 5–6 of ');
        contains(part.content, '5│ ## The Meeting');
        ok(!part.content.includes('1│'), 'a line outside the range came along');
        eq(part.summary, 'lines 5–6');
    });

    await test('read_file truncates a long file and points to its continuation', async () => {
        const long = [{ name: 'long.md', text: Array.from({ length: 5000 }, (_, i) => `Content line number ${i + 1} with a sentence that is long enough.`).join('\n') }];
        const r = runTool('read_file', '{"name":"long.md"}', long);
        ok(estimateTokens(r.content) < 6500, 'the result exceeded the limit');
        const next = /from_line=(\d+)/.exec(r.content);
        ok(next, 'no continuation hint');
        contains(runTool('read_file', `{"name":"long.md","from_line":${next[1]}}`, long).content, `${next[1]}│ Content line`);
    });

    await test('errors are returned as text the model can understand, and are not thrown', async () => {
        contains(runTool('read_file', '{"name":"characters"}', files).content, '');   // "characters" matches notes/characters.md through the path suffix
        contains(runTool('read_file', '{"name":"characters"}', files).content, 'notes/characters.md');
        contains(runTool('read_file', '{"name":"chapter-9"}', files).content, 'not found');
        contains(runTool('read_file', '{}', files).content, 'required');
        contains(runTool('search_text', '{broken', files).content, 'not a valid JSON');
        contains(runTool('delete_file', '{}', files).content, 'not recognized');
        contains(runTool('list_files', '', []).content, 'There are no document files');
    });

    await test('describeCall composes interface phrases', async () => {
        eq(describeCall('search_text', '{"text":"Hasan","file":"chapter-2.md"}'), 'Searching text “Hasan” in chapter-2.md');
        eq(describeCall('read_file', '{"name":"chapter-1.md","from_line":10}'), 'Reading chapter-1.md (from line 10)');
        eq(describeCall('search_documents', '{"query":"letter"}'), 'Searching “letter”');
        eq(describeCall('list_files', ''), 'Viewing the file list');
        eq(describeCall('search_text', '{broken'), 'Searching text “”');
    });

    section('Assistant: the agent loop');

    const turn = (over: Partial<ContextInput> = {}) => ({ ...input(over), question: 'Who carried the letter?' });
    const nohandlers = { onContext: () => {}, onText: () => {}, onReasoning: () => {} };
    const result = (over: Partial<ChatResult> = {}): ChatResult => ({ usage: { prompt: 100, cached: 40, completion: 10 }, cancelled: false, toolCalls: [], reasoning: '', ...over });

    await test('the model asks for a tool, the result is sent back, then the model answers; the history contains only Q&A', async () => {
        const calls: ChatRequest[] = [];
        const snapshots: ChatMessage[][] = [];
        const provider: Provider = {
            async chat(req) {
                calls.push(req);
                snapshots.push([...req.messages]);
                if (calls.length === 1) {
                    req.onText('Let me check first.');
                    return result({ toolCalls: [{ id: 'c1', name: 'search_text', arguments: '{"text":"letter"}' }], reasoning: 'needs to look up' });
                }
                req.onText('Laras.');
                return result();
            },
        };
        const session = new ChatSession();
        session.thinking = true;
        const steps: ToolStep[] = [];
        const streamed: string[] = [];
        const r = await within(session.ask(turn(), provider, 'm', { ...nohandlers, onText: d => streamed.push(d), onTool: s => steps.push({ ...s }) }));
        eq(calls.length, 2);
        ok(calls[0].tools && calls[0].tools.some(t => t.name === 'read_file'), 'tools were not given');
        eq(calls[0].thinking, true);
        const second = snapshots[1];
        const assistant = second[second.length - 2];
        const tool = second[second.length - 1];
        eq(assistant.role, 'assistant');
        eq((assistant as { toolCalls: unknown[] }).toolCalls.length, 1);
        eq((assistant as { reasoning?: string }).reasoning, 'needs to look up');   // reasoning is returned together with the tool call
        eq(tool.role, 'tool');
        eq((tool as { toolCallId: string }).toolCallId, 'c1');
        contains(tool.content, 'chapter-1.md:7');
        eq(steps.map(s => [s.id, s.summary === '' ? 'start' : 'finish']), [['c1', 'start'], ['c1', 'finish']]);
        eq(steps[0].label, 'Searching text “letter”');
        eq(streamed.join(''), 'Let me check first.\n\nLaras.');
        eq(r.text, 'Let me check first.\n\nLaras.');
        eq(r.toolCalls, 1);
        eq(r.usage, { prompt: 200, cached: 80, completion: 20 });   // summed over both rounds
        eq(session.history.map(t => t.role), ['user', 'assistant']);
        eq(session.history[1].content, 'Let me check first.\n\nLaras.');
    });

    await test('the active document can also be browsed with the buffer contents, not the disk version', async () => {
        let seen = '';
        const provider: Provider = {
            async chat(req) {
                if (req.tools) return result({ toolCalls: [{ id: 'c', name: 'read_file', arguments: '{"name":"chapter-2.md"}' }] });
                seen = req.messages[req.messages.length - 1].content;
                return result();
            },
        };
        await within(new ChatSession().ask(turn({ active: { name: 'chapter-2.md', text: '# Chapter 2\n\nA new version that is not saved yet.\n', cursorLine: 0 } }), provider, 'm', nohandlers));
        contains(seen, 'A new version that is not saved yet.');
    });

    await test('without permission for other files no tools are given', async () => {
        const seen: (ChatRequest['tools'])[] = [];
        const provider: Provider = { async chat(req) { seen.push(req.tools); req.onText('ok'); return result(); } };
        await within(new ChatSession().ask(turn({ options: { activeDocument: true, selection: true, project: false } }), provider, 'm', nohandlers));
        eq(seen, [undefined]);
    });

    await test('rounds are limited to MAX_ROUNDS and the last round has no tools, so it always ends with an answer', async () => {
        let rounds = 0, lastHadTools = true;
        const provider: Provider = {
            async chat(req) {
                rounds++;
                lastHadTools = !!req.tools;
                if (req.tools) return result({ toolCalls: [{ id: `c${rounds}`, name: 'list_files', arguments: '' }] });
                req.onText('Enough.');
                return result();
            },
        };
        const r = await within(new ChatSession().ask(turn(), provider, 'm', nohandlers));
        eq(rounds, MAX_ROUNDS);
        ok(!lastHadTools, 'the last round was still given tools');
        eq(r.text, 'Enough.');
        eq(r.toolCalls, MAX_ROUNDS - 1);
    });

    await test('reading budget per question: a tool result that exceeds it is replaced by a "budget exhausted" message', async () => {
        const big = { name: 'large.md', text: Array.from({ length: 800 }, (_, i) => `Content line ${i} that is long enough to eat up tokens.`).join('\n') };
        const outcomes: string[] = [];
        let n = 0;
        const provider: Provider = {
            async chat(req) {
                const last = req.messages[req.messages.length - 1];
                if (last.role === 'tool') outcomes.push(last.content);
                if (++n <= 3) return result({ toolCalls: [{ id: `c${n}`, name: 'read_file', arguments: '{"name":"large.md"}' }] });
                req.onText('finished');
                return result();
            },
        };
        await within(new ChatSession().ask(turn({ files: [big], budget: 9000 }), provider, 'm', nohandlers));
        ok(outcomes.length >= 2, 'the tool was not called');
        contains(outcomes[0], 'Content line 0 that');
        contains(outcomes[outcomes.length - 1], 'The reading budget');
    });

    await test('cancelled halfway: the text fragment is kept and the loop stops', async () => {
        let calls = 0;
        const provider: Provider = { async chat(req) { calls++; req.onText('Half'); return result({ cancelled: true }); } };
        const session = new ChatSession();
        const r = await within(session.ask(turn(), provider, 'm', nohandlers));
        eq(calls, 1);
        ok(r.cancelled, 'should have been cancelled');
        eq(session.history.length, 2);
    });

    await test('toApiMessage: the message shape in the API (tools and reasoning)', async () => {
        eq(toApiMessage({ role: 'tool', toolCallId: 'c1', content: 'result' }), { role: 'tool', tool_call_id: 'c1', content: 'result' });
        eq(toApiMessage({ role: 'assistant', content: '', reasoning: 'thinking', toolCalls: [{ id: 'c1', name: 'search_text', arguments: '{}' }] }),
            { role: 'assistant', content: '', reasoning_content: 'thinking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_text', arguments: '{}' } }] });
        eq(toApiMessage({ role: 'assistant', content: 'hello' }), { role: 'assistant', content: 'hello' });
        eq(toApiMessage({ role: 'user', content: 'question' }), { role: 'user', content: 'question' });
    });
}
