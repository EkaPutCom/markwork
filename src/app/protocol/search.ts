// The Search panel over the protocol: the results go out as `view.search` whenever the controller shows them, and what the
// user did comes back as `act.search.run`, `.openHit`, and `.replaceAll` (docs/design/protocol.md 6.5).

import type { SearchQuery, SearchResults, SearchView } from '../search';
import type { Wire } from './messages';

// What the panel's fields hold and what a search found, as they cross the wire (the renderer takes them from here).
export type { SearchQuery, SearchResults };

export class ProtocolSearch implements SearchView {
    onSearch: SearchView['onSearch'] = () => {};
    onOpenHit: SearchView['onOpenHit'] = () => {};
    onReplaceAll: SearchView['onReplaceAll'] = async () => {};

    constructor(private readonly wire: Wire) {}

    showResults(results: SearchResults): void {
        this.wire.notify('view.search', { results });
    }
}
