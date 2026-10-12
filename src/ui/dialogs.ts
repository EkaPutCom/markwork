// Standard dialogs: file chooser, save confirmation, error message, about.
// Dialogs use libadwaita (Adw.Dialog, Adw.AlertDialog), are modal, and return a Promise
// that resolves when answered (modal() in gtkutil.ts). There is no nested main loop: the caller
// continues through after()/await, so other handlers do not run in the middle of them.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { attachWikiCompleter } from '../editor/wikicomplete.js';
import { childrenOf, modal, onKeyPress } from '../gtkutil.js';
import { APP_ID, APP_NAME, APP_VERSION } from '../config.js';
import { composeItem, itemMeta } from '../markdown/inbox.js';
import { fieldInputText, parseValue, setField, type FieldDef, type FieldType } from '../markdown/fields.js';
import { AGENT_NAME, CARD_SCHEMA, composeCard, DUE_INPUT, splitCard, withDueDate } from '../markdown/kanban.js';
import type { HarnessAsk, HarnessReply } from '../agent/harness.js';
import { _, fmt, ngettext } from '../i18n.js';

type FilterSetup = [label: string, setup: (filter: Gtk.FileFilter) => void];

export const FILTERS = {
    markdown: [_('Markdown'), f => ['*.md', '*.markdown', '*.mdown', '*.txt'].forEach(p => f.add_pattern(p))],
    image: [_('Images'), f => f.add_mime_type('image/*')],
    html: [_('HTML'), f => f.add_pattern('*.html')],
    all: [_('All files'), f => f.add_pattern('*')],
} satisfies Record<string, FilterSetup>;

export type FilterName = keyof typeof FILTERS;

export interface ChooseFileOptions {
    title: string;
    save?: boolean;
    selectFolder?: boolean;     // choose a folder, not a file
    filters?: FilterName[];
    name?: string | null;       // suggested file name (save dialog)
    folder?: string | null;     // initial folder
}

// Returns the chosen path, or null if cancelled.
export function chooseFile(parent: Gtk.Window, { title, save = false, selectFolder = false, filters = [], name = null, folder = null }: ChooseFileOptions): Promise<string | null> {
    const dialog = new Gtk.FileDialog({ title, modal: true });
    if (filters.length) {
        const list = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
        for (const key of filters) {
            const [label, setup]: FilterSetup = FILTERS[key];
            const filter = new Gtk.FileFilter();
            filter.set_name(label);
            setup(filter);
            list.append(filter);
        }
        dialog.set_filters(list);
        dialog.set_default_filter(list.get_item(0) as Gtk.FileFilter);
    }
    if (folder) dialog.set_initial_folder(Gio.File.new_for_path(folder));
    if (name) dialog.set_initial_name(name);
    // The GTK 4 save dialog (and the portal) already asks before overwriting a file.
    return modal<string | null>(finish => {
        const done = (pick: () => Gio.File | null) => {
            try {
                finish(pick()?.get_path() ?? null);
            } catch {
                finish(null);   // cancelled (Gtk.DialogError.DISMISSED) or failed
            }
        };
        if (selectFolder) dialog.select_folder(parent, null, (_d, res) => done(() => dialog.select_folder_finish(res)));
        else if (save) dialog.save(parent, null, (_d, res) => done(() => dialog.save_finish(res)));
        else dialog.open(parent, null, (_d, res) => done(() => dialog.open_finish(res)));
    });
}

// The window where a dialog is shown: the given parent, or the first visible window.
// An Adw.Dialog is always attached to a window; without any window there is nothing it can be shown on.
function hostWindow(parent: Gtk.Window | null): Gtk.Window | null {
    return parent ?? (Gtk.Window.list_toplevels().find(t => t instanceof Gtk.Window && t.get_visible()) as Gtk.Window | undefined) ?? null;
}

// The dialog currently shown with the title `title` (for screenshots and tests), or null.
// An Adw.Dialog is not a window itself, so it does not appear in Gtk.Window.list_toplevels().
export function findDialog(title: string): Adw.Dialog | null {
    for (const top of Gtk.Window.list_toplevels()) {
        if (!(top instanceof Adw.ApplicationWindow)) continue;
        const dialog = top.get_visible_dialog();
        if (dialog instanceof Adw.Dialog && dialog.title === title) return dialog;
    }
    return null;
}

// All Gtk.Entry under `widget`.
function entriesIn(widget: Gtk.Widget): Gtk.Entry[] {
    return childrenOf(widget).flatMap(child => child instanceof Gtk.Entry ? [child] : entriesIn(child));
}

// A modal dialog (Adw.Dialog) containing `content` and a row of buttons below it; returns the index of the pressed button,
// or `cancel` if closed (Escape). The `preferred` button becomes the default button
// (Enter in an entry with activates_default). `accept(i)` = false keeps the dialog
// open (for example an invalid entry). Without a parent window: treated as cancelled.
//
// The dialog is attached to the parent window and closed with force_close() once done, so
// nothing is left behind when the process exits.
async function modalWindow(parent: Gtk.Window | null, title: string, width: number, content: Gtk.Widget, buttons: string[],
    cancel: number, preferred: number, accept: (index: number) => boolean = () => true): Promise<number> {
    const host = hostWindow(parent);
    if (!host) return cancel;
    const dialog = new Adw.Dialog({ title, content_width: width });
    const actions = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 16, margin_bottom: 12, margin_start: 16, margin_end: 16 });
    box.append(content);
    box.append(actions);
    const view = new Adw.ToolbarView({ content: box });
    view.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(view);
    const answer = await modal<number>(finish => {
        buttons.forEach((label, i) => {
            const button = new Gtk.Button({ label });
            if (i === preferred) {
                button.add_css_class('suggested-action');
                dialog.set_default_widget(button);
            }
            button.connect('clicked', () => { if (accept(i)) finish(i); });
            actions.append(button);
        });
        // Enter in an entry presses the default button. Adw.Dialog passes Enter to the default widget only
        // through its own path; this makes the behavior the same for every entry.
        for (const entry of entriesIn(content)) {
            if (entry.activates_default) entry.connect('activate', () => (dialog.get_default_widget() as Gtk.Button | null)?.emit('clicked'));
        }
        dialog.connect('closed', () => finish(cancel));
        dialog.present(host);
        // Initial focus on the default button, unless an entry has already grabbed it.
        if (!(dialog.get_focus() instanceof Gtk.Text)) dialog.get_default_widget()?.grab_focus();
    });
    dialog.force_close();
    return answer;
}

// A short message with several buttons (Adw.AlertDialog). `destructive` = the index of the dangerous
// button (red); the other `preferred` button is highlighted as a suggestion.
function alert(parent: Gtk.Window | null, message: string, detail: string | null, buttons: string[], cancel: number, preferred: number, destructive = -1): Promise<number> {
    const host = hostWindow(parent);
    if (!host) return Promise.resolve(cancel);
    const dialog = new Adw.AlertDialog({ heading: message, body: detail ?? '' });
    buttons.forEach((label, i) => {
        dialog.add_response(String(i), label);
        if (i === destructive) dialog.set_response_appearance(String(i), Adw.ResponseAppearance.DESTRUCTIVE);
        else if (i === preferred && buttons.length > 1) dialog.set_response_appearance(String(i), Adw.ResponseAppearance.SUGGESTED);
    });
    dialog.set_default_response(String(preferred));
    dialog.set_close_response(String(cancel));
    return modal<number>(finish => {
        dialog.connect('response', (_d, id) => finish(Number(id)));
        dialog.present(host);
    });
}

export async function askSaveChanges(parent: Gtk.Window, documentName: string): Promise<'save' | 'discard' | 'cancel'> {
    const answer = await alert(parent, fmt(_('Save changes to “{name}”?'), { name: documentName }), _('Changes will be lost if they are not saved.'),
        [_("Don't Save"), _('Cancel'), _('Save')], 1, 2, 0);
    return answer === 2 ? 'save' : answer === 0 ? 'discard' : 'cancel';
}

export async function showError(parent: Gtk.Window | null, message: string): Promise<void> {
    await alert(parent, message, null, [_('Close')], 0, 0);
}

export function showAbout(parent: Gtk.Window): void {
    const dialog = new Adw.AboutDialog({
        application_name: APP_NAME, version: APP_VERSION, application_icon: APP_ID,
        developer_name: 'Eka Putra', license_type: Gtk.License.MIT_X11,
        comments: _('Markdown workspace for humans and AI agents, built with GTK 4, libadwaita, and GJS.'),
        website: 'https://markwork.ekaput.com/', support_url: 'https://markwork.ekaput.com/docs/',
        developers: ['Eka Putra'], copyright: '© 2026 Eka Putra',
        // Translators: replace with your name (one per line), e.g. "Name <email>".
        translator_credits: _('translator-credits'),
    });
    dialog.present(parent);
}

// A modal form window: contents on top, Cancel/`accept` buttons at the bottom. `validate` is called
// when the primary button is pressed; false = the window stays open. true = accepted.
export async function formDialog(parent: Gtk.Window | null, title: string, width: number, content: Gtk.Widget, accept: string, validate: () => boolean = () => true): Promise<boolean> {
    return await modalWindow(parent, title, width, content, [_('Cancel'), accept], 0, 1, i => i === 0 || validate()) === 1;
}

// ---------- Dialogs for the kanban board ----------

export interface CardDraft {
    text: string;
    notes: string[];
}

// Due date field: text (can still be typed, e.g. with a time) and a calendar button next to it.
// The calendar opens on the date in the field (or today); choosing a date fills the field and closes the calendar.
export interface DueField {
    widget: Gtk.Widget;
    entry: Gtk.Entry;
    button: Gtk.MenuButton;
    calendar: Gtk.Calendar;
}

export function dueField(text: string): DueField {
    const entry = new Gtk.Entry({ text, activates_default: true, hexpand: true, placeholder_text: _('YYYY-MM-DD') });
    entry.connect('changed', () => entry.remove_css_class('error'));
    const calendar = new Gtk.Calendar();
    const today = new Gtk.Button({ label: _('Today'), hexpand: true });
    const clear = new Gtk.Button({ label: _('Clear'), hexpand: true });
    const actions = new Gtk.Box({ spacing: 6 });
    actions.append(today);
    actions.append(clear);
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    content.append(calendar);
    content.append(actions);
    const popover = new Gtk.Popover({ child: content });
    const button = new Gtk.MenuButton({ icon_name: 'x-office-calendar-symbolic', tooltip_text: _('Pick a date'), popover });

    // When opening, the calendar points at the date in the field; `syncing` prevents that choice from writing back to the field.
    let syncing = false;
    popover.connect('show', () => {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(entry.text.trim());
        const date = match ? GLib.DateTime.new_local(+match[1], +match[2], +match[3], 0, 0, 0) : null;
        syncing = true;
        calendar.select_day(date ?? GLib.DateTime.new_now_local());
        syncing = false;
    });
    const pick = (date: GLib.DateTime) => {
        entry.text = withDueDate(entry.text, date.format('%Y-%m-%d')!);
        popover.popdown();
    };
    calendar.connect('day-selected', () => { if (!syncing) pick(calendar.get_date()); });
    today.connect('clicked', () => pick(GLib.DateTime.new_now_local()));
    clear.connect('clicked', () => { entry.text = ''; popover.popdown(); });

    const widget = new Gtk.Box({ spacing: 0 });
    widget.add_css_class('linked');
    widget.append(entry);
    widget.append(button);
    return { widget, entry, button, calendar };
}

// One edit control for a schema field: a drop-down for a select with options, a calendar field for a date, an entry
// for the rest. `text()` is what the user chose or typed; an empty text removes the field.
interface FieldControl { def: FieldDef; widget: Gtk.Widget; entry: Gtk.Entry | null; text(): string }

const FIELD_HINT: Record<FieldType, () => string> = {
    text: () => '', number: () => _('A number'), select: () => _('Comma-separated options'), date: () => _('YYYY-MM-DD'),
    progress: () => _('3/5 or 60%'), person: () => _('A name'), agent: () => _('e.g. pi'), link: () => _('[[Note]]'),
};

function fieldControl(def: FieldDef, current: string): FieldControl {
    if (def.type === 'select' && !def.multiple && def.options.length) {
        // A value the schema does not list stays selectable, so opening and saving the dialog does not lose it.
        const choices = ['', ...def.options, ...(current && !def.options.includes(current) ? [current] : [])];
        const dropdown = new Gtk.DropDown({ model: Gtk.StringList.new(choices.map(c => c || '—')), selected: Math.max(0, choices.indexOf(current)), hexpand: true });
        return { def, widget: dropdown, entry: null, text: () => choices[dropdown.selected] ?? '' };
    }
    if (def.type === 'date') {
        const due = dueField(current);
        return { def, widget: due.widget, entry: due.entry, text: () => due.entry.text };
    }
    const entry = new Gtk.Entry({ text: current, activates_default: true, hexpand: true, placeholder_text: FIELD_HINT[def.type]() });
    entry.connect('changed', () => entry.remove_css_class('error'));
    return { def, widget: entry, entry, text: () => entry.text };
}

// The first control whose text does not fit its field (marked and focused), or null.
function firstInvalid(controls: FieldControl[]): FieldControl | null {
    const bad = controls.find(c => c.entry && c.text().trim() !== '' && !parseValue(c.def, c.text().trim()).ok) ?? null;
    bad?.entry?.add_css_class('error');
    bad?.entry?.grab_focus();
    return bad;
}

const applyFields = (text: string, controls: FieldControl[]): string => controls.reduce((t, c) => setField(t, c.def, c.text()), text);

// One labelled control per field of `schema` (except the keys in `skip`) in `box`, filled from `text`.
function addFieldRows(box: Gtk.Box, schema: FieldDef[], skip: readonly string[], text: string): FieldControl[] {
    const controls = schema.filter(f => !skip.includes(f.key)).map(f => fieldControl(f, fieldInputText(text, f)));
    for (const control of controls) {
        box.append(new Gtk.Label({ label: control.def.key, xalign: 0 }));
        box.append(control.widget);
    }
    return controls;
}

// Edit card dialog: title (one line), the fields of the board's schema, and notes (multiple lines).
// Returns the new contents, or null if cancelled.
// listNotes: Markdown files in the work folder, for suggestions when typing [[ in the notes.
export async function editCardDialog(parent: Gtk.Window | null, card: CardDraft, heading = _('Edit Card'), listNotes?: () => string[], schema: FieldDef[] = []): Promise<CardDraft | null> {
    const parts = splitCard(card.text);
    const title = new Gtk.Entry({ text: parts.title, activates_default: true, hexpand: true });
    const tags = new Gtk.Entry({ text: parts.tags.join(' '), activates_default: true, hexpand: true, placeholder_text: _('tag1 tag2') });
    const dueInput = dueField(parts.due);
    const due = dueInput.entry;
    const agent = new Gtk.Entry({ text: parts.agent ?? '', activates_default: true, hexpand: true, placeholder_text: _('e.g. pi (empty = not assigned)') });
    agent.connect('changed', () => agent.remove_css_class('error'));
    const notes = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    notes.buffer.set_text(card.notes.join('\n'), -1);
    const frame = new Gtk.ScrolledWindow({ min_content_height: 140, has_frame: true, hexpand: true, vexpand: true });
    frame.set_child(notes);
    const completer = listNotes ? attachWikiCompleter(notes, listNotes) : null;

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    box.append(new Gtk.Label({ label: _('Title'), xalign: 0 }));
    box.append(title);
    box.append(new Gtk.Label({ label: _('Tags (separated by spaces)'), xalign: 0 }));
    box.append(tags);
    box.append(new Gtk.Label({ label: _('Due'), xalign: 0 }));
    box.append(dueInput.widget);
    box.append(new Gtk.Label({ label: _('Assigned to'), xalign: 0 }));
    box.append(agent);
    const controls = addFieldRows(box, schema, CARD_SCHEMA.map(f => f.key), card.text);
    box.append(new Gtk.Label({ label: listNotes ? _('Notes · [[Name]] links another note as agent context') : _('Notes'), xalign: 0, wrap: true }));
    box.append(frame);

    // Ctrl+Enter saves from the notes field (a plain Enter makes a new line).
    onKeyPress(notes, (keyval, state) => {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || !(state & Gdk.ModifierType.CONTROL_MASK)) return false;
        (notes.get_ancestor(Adw.Dialog.$gtype) as Adw.Dialog | null)?.get_default_widget()?.activate();
        return true;
    }, Gtk.PropagationPhase.CAPTURE);

    // The due date must be empty or in date format; otherwise the dialog stays open.
    const accepted = await formDialog(parent, heading, 440, box, _('Save'), () => {
        const name = agent.text.trim().replace(/^@+/, '').toLowerCase();
        if (name && !AGENT_NAME.test(name)) {
            agent.add_css_class('error');
            agent.grab_focus();
            return false;
        }
        if (due.text.trim() && !DUE_INPUT.test(due.text.trim())) {
            due.add_css_class('error');
            due.grab_focus();
            return false;
        }
        return firstInvalid(controls) === null;
    });
    completer?.destroy();
    if (!accepted) return null;
    const [start, end] = notes.buffer.get_bounds();
    return {
        text: applyFields(composeCard({ title: title.text, tags: tags.text.split(/[\s,]+/), due: due.text, agent: agent.text }, card.text), controls),
        notes: notes.buffer.get_text(start, end, true).replace(/\s+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l !== ''),
    };
}

// Edit an inbox note: title, tags, and notes. `item.text` null = a new note.
export async function editNoteDialog(parent: Gtk.Window | null, item: CardDraft, heading = _('Edit Note'), listNotes?: () => string[], schema: FieldDef[] = []): Promise<CardDraft | null> {
    const meta = itemMeta(item.text);
    const title = new Gtk.Entry({ text: meta.title, activates_default: true, hexpand: true, placeholder_text: _('Idea, link, or quick note') });
    const tags = new Gtk.Entry({ text: meta.tags.join(' '), activates_default: true, hexpand: true, placeholder_text: _('tag1 tag2') });
    const notes = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    notes.buffer.set_text(item.notes.join('\n'), -1);
    const frame = new Gtk.ScrolledWindow({ min_content_height: 140, has_frame: true, hexpand: true, vexpand: true });
    frame.set_child(notes);
    const completer = listNotes ? attachWikiCompleter(notes, listNotes) : null;

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    box.append(new Gtk.Label({ label: _('Title'), xalign: 0 }));
    box.append(title);
    box.append(new Gtk.Label({ label: _('Tags (separated by spaces)'), xalign: 0 }));
    box.append(tags);
    const controls = addFieldRows(box, schema, ['created'], item.text);
    box.append(new Gtk.Label({ label: _('Notes'), xalign: 0 }));
    box.append(frame);

    // Ctrl+Enter saves from the notes field (a plain Enter makes a new line).
    onKeyPress(notes, (keyval, state) => {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || !(state & Gdk.ModifierType.CONTROL_MASK)) return false;
        (notes.get_ancestor(Adw.Dialog.$gtype) as Adw.Dialog | null)?.get_default_widget()?.activate();
        return true;
    }, Gtk.PropagationPhase.CAPTURE);

    const accepted = await formDialog(parent, heading, 440, box, _('Save'), () => {
        if (!title.text.trim()) {
            title.add_css_class('error');
            title.grab_focus();
            return false;
        }
        return firstInvalid(controls) === null;
    });
    completer?.destroy();
    if (!accepted) return null;
    const [start, end] = notes.buffer.get_bounds();
    return {
        text: applyFields(composeItem(title.text, tags.text.split(/[\s,]+/), item.text), controls),
        notes: notes.buffer.get_text(start, end, true).replace(/\s+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l !== ''),
    };
}

// Asks for one line of text. null if cancelled. accept = the label of the confirm button (a verb), default "OK".
export async function promptDialog(parent: Gtk.Window | null, options: { title: string; label: string; value?: string; accept?: string }): Promise<string | null> {
    const entry = new Gtk.Entry({ text: options.value ?? '', activates_default: true });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    box.append(new Gtk.Label({ label: options.label, xalign: 0 }));
    box.append(entry);
    const accepted = await formDialog(parent, options.title, 360, box, options.accept ?? _('OK'));
    const value = entry.text.trim();
    return accepted && value ? value : null;
}

// What to do with the notes of a section that is deleted: keep them (they go to the section above), delete them too, or
// cancel. Asked only for a section that has notes.
export async function deleteSectionDialog(parent: Gtk.Window | null, title: string, count: number): Promise<'keep' | 'delete' | null> {
    const answer = await alert(parent, fmt(_('Delete the section “{title}”?'), { title }),
        fmt(ngettext('It has {count} note.', 'It has {count} notes.', count), { count }),
        [_('Cancel'), _('Keep the Notes'), _('Delete the Notes')], 0, 1, 2);
    return answer === 1 ? 'keep' : answer === 2 ? 'delete' : null;
}

// Merging changes the shared repository for everybody, so it is asked first, with what will happen spelled out.
export async function mergeDialog(parent: Gtk.Window | null, title: string, detail: string): Promise<boolean> {
    return await alert(parent, title, detail, [_('Cancel'), _('Merge')], 0, 1) === 1;
}

export async function confirmDialog(parent: Gtk.Window | null, message: string, detail?: string): Promise<boolean> {
    return await alert(parent, message, detail ?? null, [_('Cancel'), _('Delete')], 0, 1, 1) === 1;
}

// ---------- Dialogs for the external harness ----------

// Long text (a question or the harness's last answer) that can be selected and scrolled.
function quoted(text: string, maxHeight = 240): Gtk.Widget {
    // Can be selected with the mouse to copy, but does not receive keyboard focus: a label's first focus selects
    // all of its text and steals focus from the answer box.
    const label = new Gtk.Label({ label: text, xalign: 0, yalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true, focusable: false, max_width_chars: 60 });
    const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: maxHeight, has_frame: true });
    label.margin_start = label.margin_end = label.margin_top = label.margin_bottom = 8;
    scroller.set_child(label);
    return scroller;
}

function textArea(prefill = ''): { widget: Gtk.Widget; text: () => string; view: Gtk.TextView } {
    const view = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    view.buffer.set_text(prefill, -1);
    const frame = new Gtk.ScrolledWindow({ min_content_height: 90, has_frame: true, hexpand: true, vexpand: true });
    frame.set_child(view);
    const text = () => { const [a, b] = view.buffer.get_bounds(); return view.buffer.get_text(a, b, true); };
    return { widget: frame, text, view };
}

// The field for the answer, appended to box: a text area (question, editor), an entry (input), or radio buttons
// (select); a confirmation has none. focus = the widget that should take the keyboard focus.
function answerField(ask: HarnessAsk, box: Gtk.Box): { value: () => string; focus: Gtk.Widget | null } {
    if (ask.kind === 'question' || ask.kind === 'editor') {
        const area = textArea(ask.prefill);
        box.append(new Gtk.Label({ label: ask.kind === 'question' ? _('Your answer') : _('Contents'), xalign: 0 }));
        box.append(area.widget);
        return { value: area.text, focus: area.view };
    }
    if (ask.kind === 'input') {
        const entry = new Gtk.Entry({ placeholder_text: ask.message, activates_default: true, hexpand: true });
        box.append(entry);
        return { value: () => entry.text, focus: entry };
    }
    if (ask.kind === 'select') {
        const options = ask.options.map((label, i) => new Gtk.CheckButton({ label, active: i === 0 }));
        options.forEach((o, i) => { if (i) o.set_group(options[0]); box.append(o); });
        return { value: () => ask.options[options.findIndex(o => o.active)] ?? '', focus: null };
    }
    return { value: () => '', focus: null };
}

// Answer a harness request. null = "Later" (the harness keeps waiting).
export async function harnessAskDialog(parent: Gtk.Window | null, ask: HarnessAsk, agent: string): Promise<HarnessReply | null> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    const heading = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 60 });
    heading.set_markup(`<b>${GLib.markup_escape_text(ask.title, -1)}</b>`);
    box.append(heading);
    if (ask.message && ask.kind !== 'input') box.append(quoted(ask.message, ask.kind === 'question' ? 320 : 160));

    const { value, focus } = answerField(ask, box);
    if (ask.timeout) {
        const hint = new Gtk.Label({ label: fmt(_('{agent} uses its default answer if not answered within {seconds} seconds.'), { agent, seconds: Math.round(ask.timeout / 1000) }), xalign: 0, wrap: true });
        hint.add_css_class('dim-label');
        box.append(hint);
    }

    // modalWindow focuses the default button after the window is shown; the entry box takes it back afterwards.
    if (focus) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { focus!.grab_focus(); return GLib.SOURCE_REMOVE; });
    const title = fmt(_('Answer {agent}'), { agent });
    if (ask.kind === 'confirm') {
        const i = await modalWindow(parent, title, 460, box, [_('Later'), _('Deny'), _('Allow')], 0, 2);
        return i === 0 ? null : { confirmed: i === 2 };
    }
    const skip = ask.kind === 'question' ? _('End without replying') : _('Skip');
    const send = ask.kind === 'select' ? _('Choose') : _('Send');
    const i = await modalWindow(parent, title, 520, box, [_('Later'), skip, send], 0, 2, k => k !== 2 || !!value().trim() || ask.kind === 'editor');
    return i === 0 ? null : i === 1 ? { cancelled: true } : { value: value() };
}

// Free text for the harness (steering while working, a reply after finishing). context = the harness's last answer.
export async function harnessTextDialog(parent: Gtk.Window | null, options: { title: string; label: string; context?: string }): Promise<string | null> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    if (options.context) {
        box.append(new Gtk.Label({ label: _('Last answer'), xalign: 0 }));
        box.append(quoted(options.context));
    }
    box.append(new Gtk.Label({ label: options.label, xalign: 0 }));
    const area = textArea();
    box.append(area.widget);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { area.view.grab_focus(); return GLib.SOURCE_REMOVE; });
    const accepted = await modalWindow(parent, options.title, 520, box, [_('Cancel'), _('Send')], 0, 1, i => i === 0 || !!area.text().trim()) === 1;
    return accepted ? area.text().trim() : null;
}
