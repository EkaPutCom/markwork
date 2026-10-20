// Data shared by the model tests and the GUI tests.

// The standard kanban board for the model tests and the GUI tests.
export const BOARD = [
    '---', 'layout: board', '---', '',
    '## Plan', '',
    '- [ ] Write report #important [due:: 2026-10-20]', '  note one', '', '  note two',
    '- [ ] Send invitations', '',
    '## In Progress', '', '**Active**', '', '- [ ] Design logo', '',
    '## Done', '', '- [x] Book venue', '- Plain item', '', '***', '',
    '%% kanban:settings', '```', '{"kanban":true}', '```', '%%', '',
].join('\n');

// The standard inbox for the model tests and the GUI tests.
export const INBOX = [
    '---', 'layout: list', 'fields:', '  created: date = now', '---', '',
    '# Inbox', '',
    'A place to capture ideas.', '',
    '- SQLite idea #idea [created:: 2026-10-07 14:22]', '  note one', '', '  note two',
    '- Read HIG article #read #gnome [created:: 2026-10-07 13:32]',
    '- Item without time', '',
    'Plain closing', '',
].join('\n');
