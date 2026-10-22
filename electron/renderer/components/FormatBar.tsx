// The visual editor's toolbar over the text: undo, the kind of the cursor's line, the inline formats, the lists, and
// what can be inserted; in a table, its rows and columns. Every button is a command of the window (app/commands.ts),
// so the toolbar, the menus, the / menu, and the keys do the same thing. What is pressed follows the text at the cursor
// (editor.ts formatAt).

import { COMMANDS } from '../../../src/app/commands.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { Icon, type IconName } from './Icons.js';
import { label as keyLabel } from '../lib/keys.js';
import type { Pane } from '../lib/panes.js';
import { useClient, useStore } from '../lib/useClient.js';

// The kinds of line the style menu sets, with the command that sets each.
const STYLES: { block: string; label: string; icon: IconName; command: string }[] = [
    { block: 'paragraph', label: 'Normal text', icon: 'format-text', command: 'paragraph' },
    { block: 'h1', label: 'Heading 1', icon: 'format-h1', command: 'heading1' },
    { block: 'h2', label: 'Heading 2', icon: 'format-h2', command: 'heading2' },
    { block: 'h3', label: 'Heading 3', icon: 'format-h3', command: 'heading3' },
    { block: 'quote', label: 'Quote', icon: 'format-quote', command: 'quote' },
    { block: 'code', label: 'Code block', icon: 'format-codeblock', command: 'codeblock' },
];

// What the style menu's button says for the kinds it does not set.
const OTHER_BLOCKS: Record<string, string> = {
    h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', bullet: 'Bulleted list', numbered: 'Numbered list', task: 'To-do list', table: 'Table',
};

const titleOf = (id: string, text: string): string => {
    const keys = COMMANDS.find(c => c.id === id)?.keys[0];
    return keys ? `${text} (${keyLabel(keys)})` : text;
};

const IDLE = { block: 'paragraph', marks: [] };

// The toolbar of a pane; what is pressed is what the cursor is in, which only the pane that has the focus has.
export function FormatBar({ pane }: { pane: Pane }) {
    const client = useClient();
    const { panes, format: current } = useStore();
    const format = panes.current === pane.id ? current : IDLE;
    // The commands act on the pane that has the focus, so a button of this one gives it the focus first.
    const run = (id: string) => { client.focusPane(pane.id); client.run(id); client.focusEditor(); };
    const tool = (id: string, text: string, icon: IconName, pressed?: boolean) => (
        <Button key={id} variant="ghost" size="icon-sm" title={titleOf(id, text)} aria-label={text} aria-pressed={pressed}
            // The editor keeps the focus and the selection the command works on.
            onMouseDown={e => e.preventDefault()} onClick={() => run(id)}>
            <Icon name={icon} />
        </Button>
    );
    const marks = new Set(format.marks);
    const style = STYLES.find(s => s.block === format.block);
    const inTable = format.block === 'table', inCode = format.block === 'code';
    return (
        <div className="format-bar" role="toolbar" aria-label="Formatting">
            {tool('undo', 'Undo', 'edit-undo')}
            {tool('redo', 'Redo', 'edit-redo')}
            <span className="sep" aria-hidden="true" />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="style-button" aria-label="Text style" title="Text style">
                        <span className="label-text">{style?.label ?? OTHER_BLOCKS[format.block] ?? 'Normal text'}</span>
                        <Icon name="pan-down" className="text-muted-foreground" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-44" onCloseAutoFocus={e => { e.preventDefault(); client.focusEditor(); }}>
                    {STYLES.map(s => (
                        <DropdownMenuItem key={s.block} onSelect={() => { client.focusPane(pane.id); client.run(s.command); }} aria-checked={s.block === format.block} role="menuitemradio">
                            <Icon name={s.icon} />{s.label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <span className="sep" aria-hidden="true" />
            {tool('bold', 'Bold', 'format-bold', marks.has('bold'))}
            {tool('italic', 'Italic', 'format-italic', marks.has('italic'))}
            {tool('strike', 'Strikethrough', 'format-strike', marks.has('strike'))}
            {tool('inline-code', 'Inline Code', 'format-code', marks.has('code'))}
            {tool('link', 'Insert Link', 'format-link', marks.has('link'))}
            <span className="sep" aria-hidden="true" />
            {tool('ulist', 'Bulleted List', 'list-bullet', format.block === 'bullet')}
            {tool('olist', 'Numbered List', 'list-numbered', format.block === 'numbered')}
            {tool('tasklist', 'To-do List', 'list-todo', format.block === 'task')}
            <span className="sep" aria-hidden="true" />
            {inTable ? (
                <>
                    {tool('table-row-below', 'Add Row Below', 'table-row')}
                    {tool('table-col-right', 'Add Column to the Right', 'table-column')}
                    {tool('table-delete-row', 'Delete Row', 'list-remove')}
                    {tool('table-delete-col', 'Delete Column', 'edit-clear')}
                </>
            ) : (
                <>
                    {!inCode && tool('table', 'Insert Table', 'x-office-spreadsheet')}
                    {!inCode && tool('image', 'Insert Image', 'insert-image')}
                    {!inCode && tool('divider', 'Insert Divider', 'insert-divider')}
                </>
            )}
        </div>
    );
}
