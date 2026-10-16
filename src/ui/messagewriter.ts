// The sparkle button next to a commit message box: the assistant writes the message from the files about to be
// committed (agent/commitmessage.ts, connected by the window). The text streams into the box; the button turns
// into Stop meanwhile and the owner locks the rest of the commit form. The result is only put in the box,
// selected, for the user to check; Ctrl+Z right after puts back what was there before.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { WriteResult } from '../agent/commitmessage.js';
import { onKeyPress } from '../gtkutil.js';
import type { MessageBox } from './messagebox.js';
import { _, fmt, ngettext } from '../i18n.js';
import { Cancellable } from '../cancel.js';

export const SPARKLE_ICON = 'com.ekaput.Markwork-sparkle-symbolic';

export type WriteMessage = (files: string[], onText: (message: string) => void, cancellable: Cancellable) => Promise<WriteResult>;

// A status line under a commit form: plain or an error, optionally with markup (a link).
export function setStatus(label: Gtk.Label, text: string, error = false, markup = false): void {
    if (markup) label.set_markup(text); else label.set_text(text);
    if (error) label.add_css_class('error'); else label.remove_css_class('error');
    label.set_visible(!!text);
}

// Adw.Spinner (libadwaita 1.6+); Gtk.Spinner for older system libadwaita.
function spinner(): Gtk.Widget {
    const AdwSpinner = (Adw as any).Spinner as (new () => Gtk.Widget) | undefined;
    return AdwSpinner ? new AdwSpinner() : new Gtk.Spinner({ spinning: true });
}

export class MessageWriter {
    readonly button: Gtk.Button;
    onBusy: (busy: boolean) => void = () => {};     // lock or unlock the rest of the form
    onOpenSettings: () => void = () => {};          // the "no API key" link
    private readonly pages: Gtk.Stack;
    private cancellable: Cancellable | null = null;
    private before: string | null = null;           // the text Ctrl+Z restores, while the box still holds the written message
    private written = '';
    private writeMessage: WriteMessage | null = null;
    private held = false;                           // a commit is running: no new message until it ends

    // files: what would be committed now. idleTip: the button's tooltip when it can write.
    constructor(private readonly box: MessageBox, private readonly status: Gtk.Label,
        private readonly files: () => string[], private readonly idleTip: string) {
        this.pages = new Gtk.Stack({ hhomogeneous: true, vhomogeneous: true });
        this.pages.add_named(new Gtk.Image({ icon_name: SPARKLE_ICON }), 'idle');
        const busy = new Gtk.Overlay({ child: spinner() });
        busy.add_overlay(new Gtk.Image({ icon_name: 'media-playback-stop-symbolic', pixel_size: 8 }));
        this.pages.add_named(busy, 'busy');
        this.button = new Gtk.Button({ child: this.pages, visible: false, valign: Gtk.Align.CENTER });
        this.button.connect('clicked', () => this.busy ? this.stop() : void this.run());
        this.status.connect('activate-link', () => { this.onOpenSettings(); return true; });
        onKeyPress(box.view, (keyval, state) => this.undo(keyval, state), Gtk.PropagationPhase.CAPTURE);
        box.onChanged(() => { if (!this.busy && box.text !== this.written) this.before = null; });
        this.update();
    }

    get busy(): boolean { return this.cancellable !== null; }

    // Set by the window; null = no assistant, and the button stays hidden.
    get write(): WriteMessage | null { return this.writeMessage; }
    set write(write: WriteMessage | null) { this.writeMessage = write; this.update(); }

    // Set by the owner while it commits, so a message written meanwhile cannot unlock Commit halfway.
    get locked(): boolean { return this.held; }
    set locked(locked: boolean) { this.held = locked; this.update(); }

    // The checked files or the assistant changed: show, enable, and describe the button.
    update(): void {
        this.button.set_visible(this.write !== null);
        const can = this.files().length > 0 && !this.held;
        this.button.set_sensitive(this.busy || can);
        const tip = this.busy ? _('Stop writing') : this.held ? _('Committing…') : can ? this.idleTip : _('Check the files to describe first');
        this.button.set_tooltip_text(tip);
        this.button.update_property([Gtk.AccessibleProperty.LABEL], [this.busy ? _('Stop writing') : _('Write the message with the assistant')]);
    }

    stop(): void {
        this.cancellable?.cancel();
    }

    private async run(): Promise<void> {
        const files = this.files();
        if (!this.write || !files.length || this.busy || this.held) return;
        const before = this.box.text;
        this.cancellable = new Cancellable();
        this.setBusy(true);
        setStatus(this.status, files.length === 1
            ? fmt(_('Writing from the changes in {name}…'), { name: GLib.path_get_basename(files[0]) })
            : fmt(ngettext('Writing from the changes in {n} file…', 'Writing from the changes in {n} files…', files.length), { n: files.length }));
        let result: WriteResult;
        try {
            result = await this.write(files, message => { this.box.text = message; }, this.cancellable);
        } catch (e) {
            result = { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) };
        } finally {
            this.cancellable = null;
            this.setBusy(false);
        }
        this.finish(result, before, files.length);
    }

    private finish(result: WriteResult, before: string, count: number): void {
        if (!result.ok) {
            this.box.text = before;
            if (result.reason === 'no-key') {
                setStatus(this.status, `${GLib.markup_escape_text(_('There is no DeepSeek API key yet.'), -1)} <a href="settings">${GLib.markup_escape_text(_('Open the Assistant settings'), -1)}</a>`, true, true);
            } else {
                setStatus(this.status, fmt(_('Could not write a message: {message}. The box keeps what you typed.'), { message: result.message.replace(/[.\s]+$/, '') }), true);
            }
            return;
        }
        if (!result.message) {
            this.box.text = before;
            return setStatus(this.status, result.cancelled ? _('Stopped before any text was written') : _('The assistant returned no message; try again'), !result.cancelled);
        }
        this.box.text = result.message;
        this.before = before;
        this.written = result.message;
        this.box.grabFocus();
        this.box.selectAll();
        setStatus(this.status, result.cancelled ? _('Stopped; the message so far was kept. Check it before committing.')
            : result.shortened ? fmt(ngettext('Written from {n} file; the changes were too long to send whole, so they were shortened. Check the message.',
                'Written from {n} files; the changes were too long to send whole, so the largest were shortened. Check the message.', count), { n: count })
                : fmt(ngettext('Written by the assistant from {n} file. Check it before committing.',
                    'Written by the assistant from {n} files. Check it before committing.', count), { n: count }));
    }

    private setBusy(busy: boolean): void {
        this.pages.visible_child_name = busy ? 'busy' : 'idle';
        this.box.sensitive = !busy;
        this.update();
        this.onBusy(busy);
    }

    // GTK's own undo does not record text set by the program, so the step back to the user's text is kept here.
    private undo(keyval: number, state: number): boolean {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0 && (state & Gdk.ModifierType.SHIFT_MASK) === 0;
        if (!ctrl || (keyval !== Gdk.KEY_z && keyval !== Gdk.KEY_Z) || this.before === null) return false;
        if (this.box.text !== this.written) return false;
        const before = this.before;
        this.before = null;
        this.box.text = before;
        this.box.cursorToEnd();
        return true;
    }
}
