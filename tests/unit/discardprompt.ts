// The GTK window's discard question (ui/discard.ts). It goes with the GTK frontend (docs/design/hapus-gtk.md).

import { discardPrompt } from '../../src/ui/discard.js';
import { section, test, eq, contains } from '../framework.js';

export function discardPromptTests(): void {
    section('Discarding uncommitted changes: the GTK question');
    test('the question names the file and says what happens to it', () => {
        contains(discardPrompt('modified', '/x/notes.md').heading, 'notes.md');
        contains(discardPrompt('modified', '/x/notes.md').detail, 'cannot be undone');
        contains(discardPrompt('untracked', '/x/notes.md').detail, 'Trash');
        eq(discardPrompt('deleted', '/x/notes.md').accept, 'Restore');
    });
}
