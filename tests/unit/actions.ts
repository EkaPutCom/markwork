// The registry of app/commands.ts mapped onto GTK accelerators (src/actions.ts).

import { COMMANDS } from '../../src/app/commands.js';
import { gtkAccelerators } from '../../src/actions.js';
import { section, test, eq } from '../framework.js';

// The accelerators the actions had before the commands became data.
const EXPECTED: Record<string, string[]> = {
    'new': ['<Control>n'], 'close-tab': ['<Control>w'], 'home': ['<Alt>Home'], 'journal': ['<Control><Alt>j'], 'journal-capture': ['<Control><Shift>j'],
    'next-tab': ['<Control>Page_Down', '<Control>Tab'], 'prev-tab': ['<Control>Page_Up', '<Control><Shift>Tab', '<Control><Shift>ISO_Left_Tab'],
    'open': ['<Control>o'], 'open-folder': ['<Control><Shift>o'], 'save': ['<Control>s'], 'undo': ['<Control>z'], 'redo': ['<Control><Shift>z', '<Control>y'],
    'kanban-view': ['<Control><Shift>b'], 'save-as': ['<Control><Shift>s'], 'export-html': ['<Control><Shift>e'], 'quit': ['<Control>q'],
    'preferences': ['<Control>comma'], 'command-palette': ['<Control><Shift>p'], 'shortcuts': ['<Control>question'], 'find': ['<Control>f'],
    'replace': ['<Control>h'], 'search-files': ['<Control><Shift>f'], 'replace-files': ['<Control><Shift>h'], 'bold': ['<Control>b'], 'italic': ['<Control>i'],
    'strike': ['<Alt><Shift>5', '<Control><Shift>x'], 'inline-code': ['<Control>grave'], 'highlight': ['<Control><Shift>h'], 'link': ['<Control>k'],
    'image': ['<Control><Shift>i'], 'codeblock': ['<Control><Shift>k'], 'table': ['<Control>t'], 'table-format': ['<Control><Shift>t'],
    'quote': ['<Control><Shift>q'], 'ulist': ['<Control><Shift>bracketright'], 'olist': ['<Control><Shift>bracketleft'],
    'heading0': ['<Control>0'], 'heading6': ['<Control>6'], 'sidebar': ['<Control>backslash', '<Control><Shift>1'], 'chat': ['<Control><Shift>a'],
    'focus': ['F8'], 'typewriter': ['F9'], 'source': ['<Control>slash'], 'dark': ['<Control><Shift>d'],
};
const NONE = ['journal-summary', 'zoom-image', 'kanban-new', 'inbox-new', 'table-new', 'csv-new', 'fields-edit', 'send-changes', 'autosave', 'about', 'layout', 'open-recent', 'table-row-below'];

export function actionTests(): void {
    section('Commands as GTK accelerators');
    test('every default key becomes the accelerator the action had', () => {
        for (const [id, accels] of Object.entries(EXPECTED)) eq(gtkAccelerators(COMMANDS.find(c => c.id === id)!.keys), accels, id);
        for (const id of NONE) eq(COMMANDS.find(c => c.id === id)!.keys, [], `${id} has no key`);
        eq(COMMANDS.filter(c => c.keys.length).length, Object.keys(EXPECTED).length + 5, 'a command gained or lost its keys');
    });
}
