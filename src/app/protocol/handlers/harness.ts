// Agents: the menu of a card and what it runs, the log window of a run, and the review of a card's worktree (HarnessController,
// HarnessReviewController). A card is named by its place and its text and must be the one the core holds; a run by its number
// and must have a log window open; a file or a line of the review must be one the page was sent.

import { RequestError } from '../messages';
import { ProtocolReviewView } from '../harness';
import { num, str, type HandlerContext } from './context';

const flag = (v: unknown, what: string): boolean => {
    if (typeof v !== 'boolean') throw new RequestError('bad_request', `${what} must be true or false`);
    return v;
};

export function harnessHandlers({ wire, session, frontend }: HandlerContext): void {
    const board = frontend.agentBoard, logs = frontend.runLogs, review = frontend.reviewView;

    // The menu of a card: asked for when it opens. The entries are the harness controller's, each chosen by its token.
    wire.on('act.card.menu', async p => {
        const column = num(p.column, 'column'), index = num(p.index, 'index');
        const current = session.views.currentBoard();
        const card = current.columns[column]?.cards[index];
        if (!card || card.text !== str(p.text, 'text')) throw new RequestError('stale', 'that card is no longer there');
        if (!board.agentsEnabled) return { entries: [] };
        return { entries: await board.onCardMenu(card, { column, index }) };
    });
    wire.on('act.card.run', p => { board.onRunMenu(num(p.token, 'token')); });

    const open = (run: unknown): number => {
        const id = num(run, 'run');
        if (!logs.isOpen(id)) throw new RequestError('stale', 'that log is not open');
        return id;
    };
    wire.on('act.runlog.clear', p => { logs.onClear(open(p.run)); });
    wire.on('act.runlog.closed', p => { logs.closed(num(p.run, 'run')); });

    wire.on('act.review.close', () => { review.onClose(); });
    wire.on('act.review.select', p => {
        const index = num(p.index, 'index');
        if (!review.hasFile(index)) throw new RequestError('stale', 'that file is not in the list');
        review.onSelect(index);
    });
    wire.on('act.review.include', p => {
        const index = num(p.index, 'index');
        if (!review.hasFile(index)) throw new RequestError('stale', 'that file is not in the list');
        review.onInclude(index, flag(p.included, 'included'));
    });
    wire.on('act.review.finish', p => {
        const action = ProtocolReviewView.finish(p.action);
        if (!action) throw new RequestError('bad_request', 'action must be merge, squash, keep, or discard');
        review.onFinish(action);
    });
    wire.on('act.review.pullRequest', () => { review.onPullRequest(); });
    wire.on('act.review.reply', () => { review.onReply(); });
    wire.on('act.review.folder', () => { review.onFolder(); });
    wire.on('act.review.terminal', () => { review.onTerminal(); });
    wire.on('act.review.tab', p => {
        const tab = ProtocolReviewView.tab(p.tab);
        if (!tab) throw new RequestError('bad_request', 'tab must be changes, summary, or log');
        review.onTab(tab);
    });
    wire.on('act.review.log', () => { review.onLog(); });
    wire.on('act.review.banner', () => { review.onBanner(); });
    wire.on('act.review.comment', p => {
        const line = num(p.line, 'line');
        if (!review.hasLine(line)) throw new RequestError('stale', 'that line is not in the diff');
        const text = str(p.text, 'text').trim();
        if (!text) throw new RequestError('bad_request', 'the comment is empty');
        review.onComment(line, text);
    });
}
