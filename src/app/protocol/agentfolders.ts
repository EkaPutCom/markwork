import type { FolderAgentView, FolderAgentState, FolderChatEvent } from '../folderpanel';
import type { ProposalAnswer, ProposalAsk } from '../assistant';
import type { Wire } from './messages';
import { savedChatView } from './chat';
import type { SavedChat } from '../../agent/transcript';
import { ProtocolChatPanel } from './chat';
import { Asks } from './asks';

export class ProtocolAgentFolders implements FolderAgentView {
    private readonly panels = new Map<string, ProtocolChatPanel>();
    constructor(private readonly wire: Wire) {}
    show(state: FolderAgentState): void { this.wire.notify('agent.folders', { state }); }
    history(id: string, chat: SavedChat): void { this.wire.notify('agent.history', { session: id, chat: savedChatView(chat) }); }
    event(id: string, event: FolderChatEvent): void { this.wire.notify('agent.chat', { session: id, event }); }
    private panel(id: string): ProtocolChatPanel {
        let panel = this.panels.get(id);
        if (!panel) {
            const wire: Wire = {
                notify: (ev, payload) => this.wire.notify(ev, { ...payload, folderSession: id }),
                request: (op, payload, cancel) => this.wire.request(op, { ...payload, folderSession: id }, cancel),
            };
            panel = new ProtocolChatPanel(wire, new Asks(wire));
            this.panels.set(id, panel);
        }
        return panel;
    }
    review(id: string, ask: ProposalAsk): Promise<ProposalAnswer> { return this.panel(id).review(ask); }
    cancelReview(id: string, ask: number): void { this.panels.get(id)?.cancelReview(ask); }
}

export type { FolderAgentState, FolderChatEvent } from '../folderpanel';
