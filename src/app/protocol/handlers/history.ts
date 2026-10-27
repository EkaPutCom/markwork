// The History tab and the history viewers: what the user did in them (HistoryController). A file or a hash must be one the
// controller showed (it checks), and a viewer is named by the number it gave.

import { RequestError } from '../messages';
import { num, str, type HandlerContext } from './context';

const strings = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) throw new RequestError('bad_request', `${what} must be a list of strings`);
    return v as string[];
};

export function historyHandlers({ wire, session, frontend, onDispose }: HandlerContext): void {
    const tab = frontend.historyTab, viewers = frontend.historyViewers;

    // The history is read only while its tab is shown (AppSession.sidebarShown): the panel's page is a setting the core keeps.
    const { settings } = session;
    const shown = () => session.sidebarShown(settings.sidebar ? settings.sidebarPage : null, settings.timelineOpen);
    onDispose(settings.onChanged(['sidebar', 'sidebar-page', 'timeline-open'], shown));

    wire.on('act.history.refresh', () => { tab.onRefresh(); });
    wire.on('act.history.more', () => { tab.onMore(); });
    wire.on('act.history.open', p => { tab.onOpen(str(p.hash, 'hash')); });
    wire.on('act.history.openChanges', p => { tab.onOpenChanges(str(p.path, 'path')); });
    // The answer is an error to show, or null once the commit is made.
    wire.on('act.history.commit', async p => ({ error: await tab.onCommit(strings(p.files, 'files'), str(p.message, 'message')) }));
    wire.on('act.history.discard', async p => ({ outcome: await tab.onDiscard(str(p.path, 'path')) }));
    // The message streams as `history.messageText` notices; the reply is how the writing ended.
    wire.on('act.history.write', async p => ({ result: await tab.onWrite(strings(p.files, 'files')) }));
    wire.on('act.history.stopWriting', () => { tab.onStopWriting(); });

    wire.on('act.historyViewer.commit', async p => ({ error: await viewers.onCommit(num(p.viewer, 'viewer'), str(p.message, 'message')) }));
    wire.on('act.historyViewer.discard', async p => ({ outcome: await viewers.onDiscard(num(p.viewer, 'viewer')) }));
    wire.on('act.historyViewer.write', async p => ({ result: await viewers.onWrite(num(p.viewer, 'viewer')) }));
    wire.on('act.historyViewer.stopWriting', p => { viewers.onStopWriting(num(p.viewer, 'viewer')); });
    wire.on('act.historyViewer.closed', p => { viewers.onClosed(num(p.viewer, 'viewer')); });
}
