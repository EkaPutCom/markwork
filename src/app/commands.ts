// Application action names for the command palette, shared by every frontend (GTK registers the actions themselves in
// actions.ts).

import { _ } from '../i18n.js';

// Names shown in the command palette (Ctrl+Shift+P), in the order displayed when the search is empty.
// Actions not listed here (e.g. each heading or table command) do not appear in the palette.
export const COMMAND_LABELS: Record<string, string> = {
    'new': _('New Document'), 'open': _('Open File…'), 'open-folder': _('Open Folder…'), 'save': _('Save'), 'save-as': _('Save As…'),
    'export-html': _('Export HTML…'), 'home': _('Home'),
    'journal': _("Today's Journal"), 'journal-capture': _('Add to Journal…'), 'journal-summary': _('Summarize Journal with Assistant'), 'close-tab': _('Close Tab'), 'next-tab': _('Next Tab'), 'prev-tab': _('Previous Tab'),
    'find': _('Find'), 'replace': _('Find and Replace'), 'search-files': _('Search in All Notes'), 'replace-files': _('Replace in All Notes'), 'undo': _('Undo'), 'redo': _('Redo'),
    'bold': _('Bold'), 'italic': _('Italic'), 'strike': _('Strikethrough'), 'inline-code': _('Inline Code'), 'highlight': _('Highlight'), 'link': _('Insert Link'),
    'image': _('Insert Image…'), 'zoom-image': _('Zoom Image'), 'codeblock': _('Insert Code Block'), 'table': _('Insert Table'),
    'quote': _('Quote'), 'ulist': _('Bulleted List'), 'olist': _('Numbered List'),
    'table-row-below': _('Table: Add Row Below'), 'table-row-above': _('Table: Add Row Above'), 'table-delete-row': _('Table: Delete Row'),
    'table-col-right': _('Table: Add Column to the Right'), 'table-col-left': _('Table: Add Column to the Left'), 'table-delete-col': _('Table: Delete Column'),
    'table-align-left': _('Table: Align Left'), 'table-align-center': _('Table: Align Center'), 'table-align-right': _('Table: Align Right'),
    'table-format': _('Table: Tidy Up'),
    'kanban-new': _('New Kanban Board'), 'inbox-new': _('New Inbox'), 'table-new': _('New Table'), 'kanban-view': _('Board/List/Table View'), 'fields-edit': _('Fields…'), 'send-changes': _('Send Changes as Pull Request…'),
    'sidebar': _('Sidebar'), 'chat': _('Assistant'), 'source': _('Source Mode'), 'focus': _('Focus Mode'), 'typewriter': _('Typewriter Mode'),
    'dark': _('Dark Mode'), 'autosave': _('Autosave'), 'preferences': _('Preferences'), 'shortcuts': _('Keyboard Shortcuts'), 'about': _('About Markwork'), 'quit': _('Quit'),
    'command-palette': _('Command Palette'),
};
