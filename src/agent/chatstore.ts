// Conversation history on disk: one Markdown file per conversation in <manuscript folder>/.markwork/chats/.
// The file format is in transcript.ts. Dot folders are not read as manuscripts by the assistant
// (project.ts) and do not show in the Files tree, so history does not get mixed with the manuscript.

import { fileExists, readTextFile, trashFile, writeTextFile } from '../base/files';
import { folderPath } from './path';
import { platform } from '../platform/index';
import { chatFileName, parseChat, serializeChat, titleFrom, type SavedChat } from './transcript';

const MAX_LISTED = 200;

export interface ChatSummary {
    path: string;
    title: string;
    created: string;
    turns: number;
}

const join = (...parts: string[]) => platform().paths.join(...parts);

export type ChatStorage = 'assistant' | 'agent-folder';
export const chatsDir = (root: string, storage: ChatStorage = 'assistant'): string => storage === 'agent-folder' ? folderPath(root, 'chats') : join(root, '.markwork', 'chats');

// Current local time to record in the file, e.g. 2026-10-04T14:20:00.
export function nowStamp(): string {
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export { titleFrom };

// A visible chats directory can predate agent activation. Never adopt unrelated notes or linked storage.
export function ensureAgentChatStorage(root: string): void {
    const dir = chatsDir(root, 'agent-folder');
    if (!platform().fs.exists(dir)) return;
    for (const entry of platform().fs.listInfo(dir)) {
        const path = folderPath(root, 'chats/' + entry.name);
        if (entry.kind !== 'file') throw Error('The chats folder contains an unsupported entry: ' + entry.name);
        if (entry.name === '.gitignore') continue;
        if (entry.name.endsWith('.md') && loadChat(path)) continue;
        const paired = entry.name.endsWith('.log.jsonl') ? entry.name.replace(/\.log\.jsonl$/, '.md') : entry.name.endsWith('.md.worker.json') ? entry.name.replace(/\.worker\.json$/, '') : '';
        if (paired && loadChat(folderPath(root, 'chats/' + paired))) continue;
        throw Error('The chats folder contains a file that is not an agent conversation: ' + entry.name);
    }
}

// Save a conversation. path = an existing file (overwritten); null = create a new file. Returns its path.
export function saveChat(root: string, chat: SavedChat, path: string | null, storage: ChatStorage = 'assistant'): string {
    const dir = chatsDir(root, storage);
    platform().fs.makeDirs(dir, 0o755);
    // History contains manuscript quotes: do not get committed by accident. Delete this file to allow it.
    const ignore = storage === 'agent-folder' ? folderPath(root, 'chats/.gitignore') : join(root, '.markwork', '.gitignore');
    if (!fileExists(ignore)) writeTextFile(ignore, '*\n');
    let target = path;
    if (!target) {
        const name = chatFileName(chat.created, chat.title);
        const base = name.replace(/\.md$/, '');
        target = join(dir, name);
        for (let n = 2; fileExists(target); n++) target = join(dir, `${base}-${n}.md`);
    }
    writeTextFile(target, serializeChat(chat));
    return target;
}

// The agent log of a conversation is saved next to it: chats/<name>.log.jsonl, one event per line.
export const chatLogPath = (path: string): string => path.replace(/\.md$/, '') + '.log.jsonl';

// jsonl = '' removes the file (an empty log leaves nothing behind).
export function saveChatLog(path: string, jsonl: string): void {
    const file = chatLogPath(path);
    if (jsonl) writeTextFile(file, jsonl);
    else if (fileExists(file)) platform().fs.remove(file);
}

export function loadChatLog(path: string): string {
    try {
        return readTextFile(chatLogPath(path));
    } catch (e) {
        return '';
    }
}

export function loadChat(path: string): SavedChat | null {
    try {
        return parseChat(readTextFile(path));
    } catch (e) {
        return null;
    }
}

// Conversations in the folder, newest first. Files that are not conversations are skipped.
export function listChats(root: string, storage: ChatStorage = 'assistant'): ChatSummary[] {
    const dir = chatsDir(root, storage);
    const found: ChatSummary[] = [];
    let names: string[] = [];
    try {
        names = platform().fs.list(dir);
    } catch (e) {
        return [];
    }
    for (const name of names) {
        if (!name.endsWith('.md')) continue;
        let path = join(dir, name);
        if (storage === 'agent-folder') {
            try { path = folderPath(root, 'chats/' + name); } catch { continue; }
        }
        const chat = loadChat(path);
        if (chat) found.push({ path, title: chat.title, created: chat.created, turns: chat.turns.length });
    }
    // ISO timestamps can be compared as text; the file name is the tiebreaker if empty or equal.
    found.sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path));
    return found.slice(0, MAX_LISTED);
}

export function deleteChat(path: string): void {
    trashFile(path);
    const log = chatLogPath(path);
    if (fileExists(log)) trashFile(log);
}
