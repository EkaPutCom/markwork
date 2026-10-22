// The Visual / Markdown switch: for a pane, whether it shows the document as it looks or as it is written. One in the header
// while there is a single pane, one in the bar of each pane once there are several.

import { Icon } from './Icons.js';
import { layoutOf as declaredLayout } from '../../../src/markdown/layout.js';
import type { Tab } from '../lib/client.js';
import type { Pane } from '../lib/panes.js';
import { useClient, useStore } from '../lib/useClient.js';

// The pages that draw a document's notes (a board, a list, …); with a CSV table they are what Visual shows.
export const STRUCTURED_PAGES = ['board', 'inbox', 'table', 'calendar', 'timeline', 'gallery', 'chart'];

export function EditingMode({ tab, pane }: { tab: Tab; pane: Pane }) {
    const client = useClient();
    const { settings } = useStore();
    // A document that has another form (a board, a list, a table, …, or a CSV file) is Visual in that form and Markdown as
    // its text; an ordinary one is Visual in the visual editor.
    const structured = STRUCTURED_PAGES.includes(tab.page) || tab.page === 'csv' || /\.csv$/i.test(tab.file ?? '') || declaredLayout(tab.mirror.text) !== null;
    const onText = tab.page === 'text';
    const visual = structured ? !onText : settings.visual !== false && !pane.source;
    const markdown = structured ? onText : pane.source;
    // Visual shows the document as it looks; Markdown is the file as it is written (source mode). The commands act on the
    // pane that has the focus, so it gets the focus first.
    const choose = (toMarkdown: boolean) => {
        client.focusPane(pane.id);
        if (toMarkdown) {
            if (structured && !onText) client.run('kanban-view', false);
            client.run('source', true);
        } else {
            if (pane.source) client.run('source', false);
            if (structured) { if (onText) client.run('kanban-view', true); } else client.run('visual', true);
        }
        client.focusEditor();
    };
    return (
        <div className="mode-switch" role="group" aria-label="Editing mode">
            <button type="button" aria-pressed={visual} title="Visual: the document as it looks" onClick={() => choose(false)}>
                <Icon name="mode-visual" /><span className="label-text">Visual</span>
            </button>
            <button type="button" aria-pressed={markdown} title="Markdown: the file as it is written, with all its syntax (Ctrl+/)" onClick={() => choose(true)}>
                <Icon name="mode-markdown" /><span className="label-text">Markdown</span>
            </button>
        </div>
    );
}
