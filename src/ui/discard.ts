// Asking before the uncommitted changes of a file are thrown away (History tab, the changes window).

import type Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import type { ChangeKind } from '../gitlog.js';
import { _, fmt } from '../i18n.js';
import { decideDialog } from './dialogs.js';

// What the question says. A new file is moved to the Trash (it can be brought back); the changes to a tracked file cannot.
export function discardPrompt(kind: ChangeKind, path: string): { heading: string; detail: string; accept: string } {
    const name = GLib.path_get_basename(path);
    if (kind === 'untracked' || kind === 'added') {
        return { heading: fmt(_('Delete the new file “{name}”?'), { name }), detail: _('The file is not in the last commit. It will be moved to the Trash.'), accept: _('Move to Trash') };
    }
    if (kind === 'deleted') {
        return { heading: fmt(_('Restore “{name}”?'), { name }), detail: _('The file comes back as it is in the last commit.'), accept: _('Restore') };
    }
    return { heading: fmt(_('Discard the changes to “{name}”?'), { name }), detail: _('The file goes back to the last commit. This cannot be undone.'), accept: _('Discard Changes') };
}

export function askDiscard(parent: Gtk.Window | null, kind: ChangeKind, path: string): Promise<boolean> {
    const { heading, detail, accept } = discardPrompt(kind, path);
    return decideDialog(parent, heading, detail, accept, true);
}
