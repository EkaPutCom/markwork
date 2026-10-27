// The Search panel: a query to run, a hit to open, and a replacement to make everywhere (SearchController).

import { RequestError } from '../messages';
import type { SearchQuery } from '../../search';
import { num, str, type HandlerContext } from './context';

export function searchHandlers({ wire, frontend }: HandlerContext): void {
    wire.on('act.search.run', p => {
        const q = p.query as Partial<SearchQuery> | undefined;
        if (!q || typeof q.text !== 'string') throw new RequestError('bad_request', 'query is missing');
        frontend.search.onSearch({
            text: q.text, include: String(q.include ?? ''), exclude: String(q.exclude ?? ''),
            caseSensitive: q.caseSensitive === true, wholeWord: q.wholeWord === true, regex: q.regex === true,
        });
    });
    wire.on('act.search.openHit', p => { frontend.search.onOpenHit(str(p.file, 'file'), num(p.index, 'index')); });
    // The answer comes after the user has been asked (ask.search.confirm) and the files are written.
    wire.on('act.search.replaceAll', async p => { await frontend.search.onReplaceAll(str(p.replacement, 'replacement')); });
}
