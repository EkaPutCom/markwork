// Conversation history on disk: one Markdown file per conversation in <manuscript folder>/.markwork/chats/.
// The file format is in transcript.ts. Dot folders are not read as manuscripts by the assistant
// (project.ts) and do not show in the Files tree, so history does not get mixed with the manuscript.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readTextFile, writeTextFile } from '../files.js';
import { trashEntry } from '../fileops.js';
import { chatFileName, parseChat, serializeChat, titleFrom, type SavedChat } from './transcript.js';

const MAX_LISTED = 200;

export interface ChatSummary {
    path: string;
    title: string;
    created: string;
    turns: number;
}

export const chatsDir = (root: string): string => GLib.build_filenamev([root, '.markwork', 'chats']);

// Current local time to record in the file, e.g. 2026-10-04T14:20:00.
export const nowStamp = (): string => GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:%M:%S') ?? '';

export { titleFrom };

// Save a conversation. path = an existing file (overwritten); null = create a new file. Returns its path.
export function saveChat(root: string, chat: SavedChat, path: string | null): string {
    const dir = chatsDir(root);
    GLib.mkdir_with_parents(dir, 0o755);
    // History contains manuscript quotes: do not get committed by accident. Delete this file to allow it.
    const ignore = GLib.build_filenamev([root, '.markwork', '.gitignore']);
    if (!GLib.file_test(ignore, GLib.FileTest.EXISTS)) writeTextFile(ignore, '*\n');
    let target = path;
    if (!target) {
        const name = chatFileName(chat.created, chat.title);
        const base = name.replace(/\.md$/, '');
        target = GLib.build_filenamev([dir, name]);
        for (let n = 2; GLib.file_test(target, GLib.FileTest.EXISTS); n++) target = GLib.build_filenamev([dir, `${base}-${n}.md`]);
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
    else if (GLib.file_test(file, GLib.FileTest.EXISTS)) GLib.unlink(file);
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
export function listChats(root: string): ChatSummary[] {
    const dir = chatsDir(root);
    const found: ChatSummary[] = [];
    let names: string[] = [];
    try {
        const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) names.push(info.get_name());
        enumerator.close(null);
    } catch (e) {
        return [];
    }
    for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const path = GLib.build_filenamev([dir, name]);
        const chat = loadChat(path);
        if (chat) found.push({ path, title: chat.title, created: chat.created, turns: chat.turns.length });
    }
    // ISO timestamps can be compared as text; the file name is the tiebreaker if empty or equal.
    found.sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path));
    return found.slice(0, MAX_LISTED);
}

export function deleteChat(path: string): void {
    trashEntry(path);
    const log = chatLogPath(path);
    if (GLib.file_test(log, GLib.FileTest.EXISTS)) trashEntry(log);
}
