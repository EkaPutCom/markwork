// The History tab and the history viewer windows over the protocol (docs/design/protocol.md 6.5 and 7): what the controller
// shows becomes `view.history`, `view.historyChanges`, `history.messageText` and the `view.historyViewer.*` notices, the
// discard question becomes the ask `ask.discard`, and what the user did comes back as `act.history.*` and
// `act.historyViewer.*` (handlers/history.ts). A viewer is named by the number the core gave it.

import type { ChangeKind, Commit, DiffLine } from '../../base/gitlog';
import type { WriteResult } from '../../agent/commitmessage';
import type { ChangedFile, DiscardOutcome, HistoryChanges, HistoryDialogs, HistoryLog, HistoryTabView, HistoryText, HistoryViewerSpec, HistoryViewersView } from '../history';
import type { Asks } from './asks';
import type { Wire } from './messages';

// What the renderer takes from here (types only).
export type { ChangeKind, ChangedFile, Commit, DiffLine, DiscardOutcome, HistoryChanges, HistoryLog, HistoryText, HistoryViewerSpec, WriteResult };

export class ProtocolHistoryTab implements HistoryTabView {
    onRefresh: HistoryTabView['onRefresh'] = () => {};
    onMore: HistoryTabView['onMore'] = () => {};
    onOpen: HistoryTabView['onOpen'] = () => {};
    onOpenChanges: HistoryTabView['onOpenChanges'] = () => {};
    onCommit: HistoryTabView['onCommit'] = () => Promise.resolve('committing is not available');
    onDiscard: HistoryTabView['onDiscard'] = () => Promise.resolve({ error: 'discarding is not available' });
    onWrite: HistoryTabView['onWrite'] = () => Promise.resolve({ ok: false, reason: 'failed', message: 'writing is not available' });
    onStopWriting: HistoryTabView['onStopWriting'] = () => {};

    constructor(private readonly wire: Wire) {}

    showLog(log: HistoryLog): void { this.wire.notify('view.history', { ...log }); }
    showChanges(changes: HistoryChanges): void { this.wire.notify('view.historyChanges', { ...changes }); }
    messageText(text: string): void { this.wire.notify('history.messageText', { text }); }
}

export class ProtocolHistoryViewers implements HistoryViewersView {
    onCommit: HistoryViewersView['onCommit'] = () => Promise.resolve('committing is not available');
    onDiscard: HistoryViewersView['onDiscard'] = () => Promise.resolve('declined');
    onWrite: HistoryViewersView['onWrite'] = () => Promise.resolve({ ok: false, reason: 'failed', message: 'writing is not available' });
    onStopWriting: HistoryViewersView['onStopWriting'] = () => {};
    onClosed: HistoryViewersView['onClosed'] = () => {};

    constructor(private readonly wire: Wire) {}

    open(viewer: number, spec: HistoryViewerSpec): void { this.wire.notify('view.historyViewer.open', { viewer, file: spec.file, commit: spec.commit }); }
    showDiff(viewer: number, diff: HistoryText): void { this.wire.notify('view.historyViewer.diff', { viewer, diff }); }
    showContent(viewer: number, text: string): void { this.wire.notify('view.historyViewer.content', { viewer, text }); }
    messageText(viewer: number, text: string): void { this.wire.notify('view.historyViewer.messageText', { viewer, text }); }
    close(viewer: number): void { this.wire.notify('view.historyViewer.close', { viewer }); }
}

// "Throw these changes away?": the frontend writes the sentence from the kind and the file; the answer is yes or no.
export class ProtocolHistoryDialogs implements HistoryDialogs {
    constructor(private readonly asks: Asks) {}

    discard(kind: ChangeKind, path: string, viewer: number | null): Promise<boolean> {
        return this.asks.ask('ask.discard', { kind, path, viewer }, r => r.answer === true, false);
    }
}
