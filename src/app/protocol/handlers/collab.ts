// Collaboration: the pull request list, the token dialog's Test button, and the review of one pull request (CollabController,
// PullReviewController). A pull request is named by its number and must be one the core listed; the merge method is one of
// the three the forges have.

import { RequestError } from '../messages.js';
import { StaleAsk } from '../collab.js';
import type { MergeMethod } from '../../../forge/types.js';
import { num, str, type HandlerContext } from './context.js';

const METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

export function collabHandlers({ wire, session, frontend }: HandlerContext): void {
    const panel = frontend.collabPanel, review = frontend.pullView;

    wire.on('act.collab.open', p => {
        const pull = session.collab.pulls.find(c => c.number === num(p.number, 'number'));
        if (!pull) throw new RequestError('stale', 'that pull request is no longer in the list');
        panel.onOpen(pull);
    });
    wire.on('act.collab.refresh', () => { panel.onRefresh(); });
    wire.on('act.collab.server', () => { panel.onServer(); });
    wire.on('act.collab.send', () => { panel.onSend(); });

    // The Test button of the token dialog: the sentence for the user, or the reason it failed.
    wire.on('act.collab.testToken', async p => {
        try {
            return { message: await frontend.collabDialogs.test(num(p.ask, 'ask'), typeof p.token === 'string' ? p.token.trim() : '') };
        } catch (e) {
            if (e instanceof StaleAsk) throw new RequestError('stale', e.message);
            throw new RequestError('failed', e instanceof Error ? e.message : String(e));
        }
    });

    wire.on('act.pull.close', () => { review.onClose(); });
    wire.on('act.pull.select', p => { review.select(str(p.path, 'path')); });
    wire.on('act.pull.merge', p => {
        const method = p.method as MergeMethod;
        if (!METHODS.includes(method)) throw new RequestError('bad_request', 'method must be merge, squash, or rebase');
        review.onMerge(method);
    });
    wire.on('act.pull.browser', () => { review.onBrowser(); });
    wire.on('act.pull.comment', p => { review.onComment(str(p.text, 'text')); });
    wire.on('act.pull.resolve', () => { review.onResolve(); });
    wire.on('act.pull.finish', () => { review.onFinish(); });
    wire.on('act.pull.abort', () => { review.onAbort(); });
}
