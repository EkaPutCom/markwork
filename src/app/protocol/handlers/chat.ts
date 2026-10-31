// The Assistant panel: what the user did in it (docs/design/protocol.md 6.5). The panel's `on*` actions are the controller's
// (app/assistant.ts); this file checks what arrives and passes it on. A path to a saved conversation must be one the
// core listed, and a proposal is named by the number the core gave it, never sent back as changes.

import { RequestError } from '../messages';
import type { ContextOptions } from '../../../agent/context';
import type { UndoTarget } from '../../assistant';
import { savedChatView } from '../chat';
import { num, str, type HandlerContext } from './context';

const flag = (v: unknown, what: string): boolean => {
    if (typeof v !== 'boolean') throw new RequestError('bad_request', `${what} must be true or false`);
    return v;
};

function optionsOf(value: unknown): ContextOptions {
    const o = value as Partial<ContextOptions> | undefined;
    return { activeDocument: flag(o?.activeDocument, 'activeDocument'), selection: flag(o?.selection, 'selection'), project: flag(o?.project, 'project') };
}

function targetOf(value: unknown): UndoTarget {
    const t = value as { ask?: unknown; event?: unknown } | undefined;
    if (typeof t?.ask === 'number') return { ask: t.ask };
    if (typeof t?.event === 'string') return { event: t.event };
    throw new RequestError('bad_request', 'target is missing');
}

export function chatHandlers({ wire, session, frontend }: HandlerContext): void {
    const selected = (p: Record<string, unknown>) => {
        if (typeof p.folderSession === 'string') {
            const entry = session.agentFolders.find(p.folderSession);
            return { panel: entry.panel, chat: entry.assistant.chat, folder: entry };
        }
        return { panel: frontend.chat, chat: session.assistant.chat, folder: null };
    };
    const panel = (p: Record<string, unknown>) => selected(p).panel;

    // The frontend connected (or came back): the settings the panel shows and the agent log as it is now.
    wire.on('act.chat.sync', p => {
        const choice = selected(p);
        return { settings: choice.panel.shown, models: choice.panel.models, events: choice.folder?.background?.active ? [...choice.folder.panel.trace.events] : [...choice.chat.session.trace.events],
            chat: choice.folder ? savedChatView(choice.folder.panel.busy && choice.folder.panel.base ? choice.folder.panel.base : session.agentFolders.snapshot(choice.folder.id)) : undefined,
            folderEvents: choice.folder?.panel.events, busy: choice.chat.busy || choice.folder?.panel.busy === true };
    });

    // The reply comes when the turn is over; the turn itself is told by `chat.*` notices.
    wire.on('act.chat.send', async p => { await panel(p).onSend(str(p.text, 'text')); });
    wire.on('act.chat.stop', p => { panel(p).onStop(); });
    wire.on('act.chat.reset', p => { panel(p).onReset(); });
    wire.on('act.chat.preview', async p => ({ built: await panel(p).onPreview(str(p.draft, 'draft')) }));
    wire.on('act.chat.options', p => { panel(p).onOptions(optionsOf(p.options)); });
    wire.on('act.chat.clearLog', p => { panel(p).onClearLog(); });

    wire.on('act.chat.chats', async p => ({ chats: await panel(p).onChats() }));
    const listed = async (path: string, p: Record<string, unknown>): Promise<string> => {
        if (!(await panel(p).onChats())?.some(c => c.path === path)) throw new RequestError('stale', 'that conversation is not in the list');
        return path;
    };
    wire.on('act.chat.open', async p => {
        const chat = await panel(p).onOpenChat(await listed(str(p.path, 'path'), p));
        return { chat: chat ? savedChatView(chat) : null };
    });
    wire.on('act.chat.delete', async p => ({ error: await panel(p).onDeleteChat(await listed(str(p.path, 'path'), p)) }));

    wire.on('act.proposal.apply', async p => {
        const chosen = p.chosen === null || p.chosen === undefined ? null : Array.isArray(p.chosen) ? p.chosen.map(i => num(i, 'chosen')) : undefined;
        if (chosen === undefined) throw new RequestError('bad_request', 'chosen must be a list of numbers');
        return { error: await panel(p).onApply(num(p.ask, 'ask'), chosen) };
    });
    wire.on('act.chat.undo', async p => ({ error: await panel(p).onUndo(targetOf(p.target)) }));
    wire.on('act.chat.insert', async p => ({ inserted: await panel(p).onInsert(str(p.text, 'text')) }));

    wire.on('act.chat.model', p => { panel(p).onModel(str(p.model, 'model')); });
    wire.on('act.chat.thinking', p => { panel(p).onThinking(flag(p.thinking, 'thinking')); });
    wire.on('act.chat.save', p => { panel(p).onSaveChats(flag(p.save, 'save')); });

    // The API key: its source, saved, or forgotten. The key itself is never sent back.
    wire.on('act.chat.key', async p => {
        switch (p.action) {
            case 'status': return { source: await panel(p).onKeyStatus() };
            case 'save': {
                const key = str(p.key, 'key').trim();
                if (!key) throw new RequestError('bad_request', 'the key is empty');
                return { source: await panel(p).onSaveKey(key) };
            }
            case 'forget': await panel(p).onForgetKey(); return { source: null };
            default: throw new RequestError('bad_request', 'action must be status, save, or forget');
        }
    });
}
