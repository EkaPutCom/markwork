// The Visual / Markdown switch: for a pane, whether it shows the document as it looks or as it is written. One, in the header: it
// shows and sets the mode of the pane that has the focus.

import { Icon } from './Icons';
import { Kbd } from '../ui/kbd';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { layoutOf as declaredLayout } from '../../../src/markdown/layout';
import type { Tab } from '../lib/client';
import type { Pane } from '../lib/panes';
import { useClient, useStore } from '../lib/useClient';

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
    // A click on the mode already chosen still gives the editor the focus back, so the items act on click and the group
    // only shows the state.
    const item = (toMarkdown: boolean, label: string, hint: string, shortcut?: string) => (
        <Tooltip>
            <TooltipTrigger asChild>
                <ToggleGroupItem value={toMarkdown ? 'code' : 'visual'} onClick={() => choose(toMarkdown)}
                    className="rounded-md border border-transparent px-2 text-ui text-muted-foreground hover:bg-transparent hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm dark:aria-checked:border-input dark:aria-checked:bg-input/30">
                    <Icon name={toMarkdown ? 'mode-markdown' : 'mode-visual'} /><span className="label-text">{label}</span>
                </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{hint}{shortcut && <Kbd>{shortcut}</Kbd>}</TooltipContent>
        </Tooltip>
    );
    return (
        <ToggleGroup type="single" size="xs" value={visual ? 'visual' : markdown ? 'code' : ''} aria-label="Editing mode"
            className="mode-switch flex-none gap-0.5 rounded-lg bg-muted p-0.5">
            {item(false, 'Visual', 'The document as it looks')}
            {item(true, 'Code', 'The file as it is written, with all its syntax', 'Ctrl+/')}
        </ToggleGroup>
    );
}
