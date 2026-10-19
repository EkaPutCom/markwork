// The Search panel over the protocol: the results go out as `view.search` whenever the controller shows them, and what the
// user did comes back as `act.search.run`, `.openHit`, and `.replaceAll` (docs/design/protocol.md 6.5).

import type { SearchResults, SearchView } from '../search.js';
import type { Wire } from './messages.js';

export class ProtocolSearch implements SearchView {
    onSearch: SearchView['onSearch'] = () => {};
    onOpenHit: SearchView['onOpenHit'] = () => {};
    onReplaceAll: SearchView['onReplaceAll'] = () => {};

    constructor(private readonly wire: Wire) {}

    showResults(results: SearchResults): void {
        this.wire.notify('view.search', { results });
    }
}
