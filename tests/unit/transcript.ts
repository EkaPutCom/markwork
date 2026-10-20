// Conversation file format tests (agent/transcript.ts): pure, without GUI.

import { chatFileName, parseChat, serializeChat, titleFrom, type SavedChat } from '../../src/agent/transcript.js';
import { section, test, eq, ok, contains } from '../core/framework.js';

export function transcriptTests(): void {
    section('Conversation file');

    const chat: SavedChat = {
        title: 'Raka age contradiction', model: 'deepseek-flash', created: '2026-10-04T14:20:00',
        turns: [
            { role: 'user', content: 'Is there a contradiction in Raka age?' },
            { role: 'assistant', content: 'Yes.\n\n## Findings\n- `chapter-01.md:12` → 24 years\n- `chapter-07.md:40` → 31 years\n\n```js\nconst a = 1;\n```' },
            { role: 'user', content: 'First line\nSecond line' },
            { role: 'assistant', content: 'Ready.' },
        ],
    };

    test('serialization uses frontmatter and the You/Assistant headings', () => {
        const text = serializeChat(chat);
        ok(text.startsWith('---\ntitle: "Raka age contradiction"\nmodel: deepseek-flash\ncreated: 2026-10-04T14:20:00\n---\n'), text);
        contains(text, '## You\nIs there a contradiction in Raka age?\n\n## Assistant\nYes.');
        ok(text.endsWith('Ready.\n'), 'end of file');
    });

    test('write then read yields the same conversation', () => {
        eq(parseChat(serializeChat(chat)), chat);
    });

    test('a line resembling a turn marker inside an answer does not split the turn', () => {
        const tricky: SavedChat = { ...chat, turns: [
            { role: 'user', content: 'Write an example' },
            { role: 'assistant', content: 'Like this:\n## You\ntext\n\\## Assistant\nagain' },
        ] };
        const text = serializeChat(tricky);
        eq(text.match(/^## (You|Assistant)$/gm), ['## You', '## Assistant']);
        eq(parseChat(text), tricky);
    });

    test('a title with quotes and a colon stays intact', () => {
        const odd: SavedChat = { ...chat, title: 'What does "x: y" mean?\\' };
        eq(parseChat(serializeChat(odd))?.title, odd.title);
    });

    test('a file without turns, or that is not a conversation, is rejected', () => {
        eq(parseChat('# Plain notes\n\nContent.'), null);
        eq(parseChat(serializeChat({ ...chat, turns: [] })), null);
        eq(parseChat(''), null);
    });

    test('a hand-edited file: without frontmatter or with a broken title is still readable', () => {
        const bare = parseChat('## You\nHello\n\n## Assistant\nHi\n');
        eq(bare?.turns.length, 2);
        eq(bare?.title, 'Hello');
        const broken = parseChat('---\ntitle: "broken\nmodel: x\n---\n\n## You\nThis question\n');
        eq(broken?.title, 'This question');
        eq(parseChat('## You\r\nHello\r\n\r\n## Assistant\r\nHi\r\n')?.turns[1].content, 'Hi');
    });

    test('title from the question: first line, whitespace collapsed, truncated', () => {
        eq(titleFrom('  Is   there\nanything?'), 'Is there');
        eq(titleFrom(''), 'Conversation');
        const long = titleFrom('a'.repeat(100));
        eq([...long].length, 60);
        ok(long.endsWith('…'), 'truncation mark');
    });

    test('file name: date and simplified title', () => {
        eq(chatFileName('2026-10-04T14:20:00', 'Raka age contradiction?'), '2026-10-04-raka-age-contradiction.md');
        eq(chatFileName('2026-10-04T14:20:00', 'Éclair — “exam”!'), '2026-10-04-eclair-exam.md');
        eq(chatFileName('2026-10-04T14:20:00', '???'), '2026-10-04-conversation.md');
        ok(chatFileName('2026-10-04T14:20:00', 'x'.repeat(100)).length <= 10 + 1 + 40 + 3, 'too long');
    });
}
