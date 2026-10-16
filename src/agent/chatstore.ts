// Conversation history on disk: one Markdown file per conversation in <manuscript folder>/.markwork/chats/.
// The file format is in transcript.ts. Dot folders are not read as manuscripts by the assistant
// (project.ts) and do not show in the Files tree, so history does not get mixed with the manuscript.

import { platform } from '../platform/index.js';
import { chatFileName, parseChat, serializeChat, titleFrom, type SavedChat } from './transcript.js';

const MAX_LISTED = 200;

export interface ChatSummary {
    path: string;
    title: string;
    created: string;
    turns: number;
}

const fs = () => platform().fs;
const join = (...parts: string[]) => platform().paths.join(...parts);

export const chatsDir = (root: string): string => join(root, '.markwork', 'chats');

// Current local time to record in the file, e.g. 2026-10-04T14:20:00.
export function nowStamp(): string {
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export { titleFrom };

// Save a conversation. path = an existing file (overwritten); null = create a new file. Returns its path.
export function saveChat(root: string, chat: SavedChat, path: string | null): string {
    const dir = chatsDir(root);
    fs().makeDirs(dir, 0o755);
    // History contains manuscript quotes: do not get committed by accident. Delete this file to allow it.
    const ignore = join(root, '.markwork', '.gitignore');
    if (!fs().exists(ignore)) fs().writeText(ignore, '*\n');
    let target = path;
    if (!target) {
        const name = chatFileName(chat.created, chat.title);
        const base = name.replace(/\.md$/, '');
        target = join(dir, name);
        for (let n = 2; fs().exists(target); n++) target = join(dir, `${base}-${n}.md`);
    }
    fs().writeText(target, serializeChat(chat));
    return target;
}

// The agent log of a conversation is saved next to it: chats/<name>.log.jsonl, one event per line.
export const chatLogPath = (path: string): string => path.replace(/\.md$/, '') + '.log.jsonl';

// jsonl = '' removes the file (an empty log leaves nothing behind).
export function saveChatLog(path: string, jsonl: string): void {
    const file = chatLogPath(path);
    if (jsonl) fs().writeText(file, jsonl);
    else if (fs().exists(file)) fs().remove(file);
}

export function loadChatLog(path: string): string {
    try {
        return fs().readText(chatLogPath(path));
    } catch (e) {
        return '';
    }
}

export function loadChat(path: string): SavedChat | null {
    try {
        return parseChat(fs().readText(path));
    } catch (e) {
        return null;
    }
}

// Conversations in the folder, newest first. Files that are not conversations are skipped.
export function listChats(root: string): ChatSummary[] {
    const dir = chatsDir(root);
    const found: ChatSummary[] = [];
    let names: string[] = [];
    try {
        names = fs().list(dir);
    } catch (e) {
        return [];
    }
    for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const path = join(dir, name);
        const chat = loadChat(path);
        if (chat) found.push({ path, title: chat.title, created: chat.created, turns: chat.turns.length });
    }
    // ISO timestamps can be compared as text; the file name is the tiebreaker if empty or equal.
    found.sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path));
    return found.slice(0, MAX_LISTED);
}

export function deleteChat(path: string): void {
    fs().trash(path);
    const log = chatLogPath(path);
    if (fs().exists(log)) fs().trash(log);
}
