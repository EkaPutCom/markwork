// The Assistant panel: what the user did in it (docs/design/protocol.md 6.5). The panel's `on*` actions are the controller's
// (app/assistant.ts); this file checks what arrives and passes it on. A path to a saved conversation must be one the
// core listed, and a proposal is named by the number the core gave it, never sent back as changes.

import { RequestError } from '../messages.js';
import type { ContextOptions } from '../../../agent/context.js';
import type { UndoTarget } from '../../assistant.js';
import { savedChatView } from '../chat.js';
import { num, str, type HandlerContext } from './context.js';

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
    const panel = frontend.chat;

    // The frontend connected (or came back): the settings the panel shows and the agent log as it is now.
    wire.on('act.chat.sync', () => ({ settings: panel.shown, models: panel.models, events: [...session.assistant.chat.session.trace.events] }));

    // The reply comes when the turn is over; the turn itself is told by `chat.*` notices.
    wire.on('act.chat.send', async p => { await panel.onSend(str(p.text, 'text')); });
    wire.on('act.chat.stop', () => { panel.onStop(); });
    wire.on('act.chat.reset', () => { panel.onReset(); });
    wire.on('act.chat.preview', async p => ({ built: await panel.onPreview(str(p.draft, 'draft')) }));
    wire.on('act.chat.options', p => { panel.onOptions(optionsOf(p.options)); });
    wire.on('act.chat.clearLog', () => { panel.onClearLog(); });

    wire.on('act.chat.chats', async () => ({ chats: await panel.onChats() }));
    const listed = async (path: string): Promise<string> => {
        if (!(await panel.onChats())?.some(c => c.path === path)) throw new RequestError('stale', 'that conversation is not in the list');
        return path;
    };
    wire.on('act.chat.open', async p => {
        const chat = await panel.onOpenChat(await listed(str(p.path, 'path')));
        return { chat: chat ? savedChatView(chat) : null };
    });
    wire.on('act.chat.delete', async p => ({ error: await panel.onDeleteChat(await listed(str(p.path, 'path'))) }));

    wire.on('act.proposal.apply', async p => {
        const chosen = p.chosen === null || p.chosen === undefined ? null : Array.isArray(p.chosen) ? p.chosen.map(i => num(i, 'chosen')) : undefined;
        if (chosen === undefined) throw new RequestError('bad_request', 'chosen must be a list of numbers');
        return { error: await panel.onApply(num(p.ask, 'ask'), chosen) };
    });
    wire.on('act.chat.undo', async p => ({ error: await panel.onUndo(targetOf(p.target)) }));
    wire.on('act.chat.insert', async p => ({ inserted: await panel.onInsert(str(p.text, 'text')) }));

    wire.on('act.chat.model', p => { panel.onModel(str(p.model, 'model')); });
    wire.on('act.chat.thinking', p => { panel.onThinking(flag(p.thinking, 'thinking')); });
    wire.on('act.chat.save', p => { panel.onSaveChats(flag(p.save, 'save')); });

    // The API key: its source, saved, or forgotten. The key itself is never sent back.
    wire.on('act.chat.key', async p => {
        switch (p.action) {
            case 'status': return { source: await panel.onKeyStatus() };
            case 'save': {
                const key = str(p.key, 'key').trim();
                if (!key) throw new RequestError('bad_request', 'the key is empty');
                return { source: await panel.onSaveKey(key) };
            }
            case 'forget': await panel.onForgetKey(); return { source: null };
            default: throw new RequestError('bad_request', 'action must be status, save, or forget');
        }
    });
}
