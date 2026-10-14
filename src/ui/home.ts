// The Home page: a dedicated tab summarizing what can be continued today.
//
//   Good morning, Eka
//   Wednesday, October 7, 2026
//
//   Continue            ┌ estuary ───┐ ┌ markwork ────┐      one card per folder
//                       │ arch.md    │ │ roadmap.md │
//                       └────────────┘ └────────────┘
//   Journal             ┌ Today's journal  2 notes · 4 activities  [+] ┐
//   Agent               ┌ pi · Fix checkout   Waiting for your answer  ┐
//   Due dates           ┌ ☐ Implement search   Markwork · Today          ┐
//   Inbox               ┌ inbox.md                 5 unprocessed       ┐
//   Recent files        ┌ journal/2026-10-06.md        2 hours ago     ┐
//
// This component only draws the data supplied by the window (render) and reports through callbacks;
// it does not read files itself. The Agent and Inbox sections only show when they have contents.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { dayPart, type DayPart, type InboxCount, type Task } from '../markdown/home.js';
import type { RunStatus } from '../agent/harness.js';
import type { ConnectionState } from '../agent/daemon/connection.js';
import { ageLabel } from './inbox.js';
import { removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';

const MAX_WIDTH = 720;
// The Continue cards fill a full row in a wide window; in a narrow window the FlowBox folds them.
export const RESUME_CARDS = 3;
// Home is a summary: the remaining due dates are hidden behind a single row (and drawing dozens of rows is expensive too).
const SHOWN_TASKS = 7;

// One file in a Continue card or in the Recent files list.
export interface HomeEntry {
    path: string;
    title: string;      // card: folder name; list: file name
    subtitle: string;   // card: file name; list: relative folder
    time: number;       // Unix seconds
}

export interface HomeRun {
    id: number;
    agent: string;
    title: string;
    status: RunStatus;
}

// The machine agents run on (not shown when they run as children of this window), and whether it can be reached.
export interface HomeAgentHost {
    label: string;
    state: ConnectionState;
    detail: string;
}

export interface HomeJournal {
    exists: boolean;    // today's journal file already exists
    notes: number;      // bullets in the Notes section
    activity: number;   // activities recorded today (log), including those not yet in the file
}

export interface HomeData {
    now: Date;
    name: string | null;          // the user's first name, null = a greeting without a name
    workspace: string | null;     // work folder; null = none yet, due dates and the inbox cannot be read
    resume: HomeEntry[];
    recent: HomeEntry[];
    tasks: Task[];
    runs: HomeRun[];
    agentHost: HomeAgentHost | null;
    inboxes: InboxCount[];
    journal: HomeJournal | null;  // null = no work folder
}

export class HomeView {
    readonly widget: Gtk.ScrolledWindow;
    onOpenFile: (path: string) => void = () => {};
    onOpenTask: (task: Task) => void = () => {};
    // true = successfully written to the board; false = the checkbox is put back.
    onToggleTask: (task: Task, done: boolean) => boolean = () => false;
    onOpenRun: (id: number) => void = () => {};
    onOpenInbox: (file: string) => void = () => {};
    onOpenFolder: () => void = () => {};
    onNewDocument: () => void = () => {};
    onOpenJournal: () => void = () => {};
    onCaptureJournal: () => void = () => {};

    private readonly page: Gtk.Box;
    private data: HomeData | null = null;
    private allTasks = false;   // the user opened all due dates; lasts until the window is closed

    constructor() {
        this.page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 32, margin_bottom: 32, margin_start: 16, margin_end: 16 });
        const clamp = new Adw.Clamp({ maximum_size: MAX_WIDTH, tightening_threshold: 560, child: this.page, valign: Gtk.Align.START });
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, hexpand: true, child: clamp });
        this.widget.add_css_class('home-view');
    }

    render(data: HomeData): void {
        this.data = data;
        removeChildren(this.page);
        if (!data.workspace && !data.resume.length && !data.recent.length) {
            this.page.append(this.welcome(data));
            return;
        }
        this.page.append(this.header(data));
        if (data.resume.length) this.addSection(_('Continue'), this.resumeCards(data));
        if (data.journal) this.addSection(_('Journal'), this.list([this.journalRow(data.journal)]));
        if (data.runs.length || data.agentHost) this.addSection(_('Agent'), this.list([...(data.agentHost ? [this.hostRow(data.agentHost)] : []), ...data.runs.map(run => this.runRow(run))]));
        this.addSection(_('Due dates'), this.taskList(data));
        if (data.inboxes.length) this.addSection(_('Inbox'), this.list(data.inboxes.map(inbox => this.inboxRow(inbox))));
        if (data.recent.length) this.addSection(_('Recent files'), this.list(data.recent.map(entry => this.recentRow(entry, data.now))));
    }

    // ---------- Sections ----------

    private greeting(data: HomeData): string {
        const part: DayPart = dayPart(data.now.getHours());
        const { name } = data;
        if (!name) return { morning: _('Good morning'), midday: _('Good afternoon'), afternoon: _('Good afternoon'), evening: _('Good evening') }[part];
        const text = { morning: _('Good morning, {name}'), midday: _('Good afternoon, {name}'), afternoon: _('Good afternoon, {name}'), evening: _('Good evening, {name}') }[part];
        return fmt(text, { name });
    }

    private header(data: HomeData): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_bottom: 8 });
        const title = new Gtk.Label({ label: this.greeting(data), xalign: 0, wrap: true });
        title.add_css_class('title-1');
        const date = new Gtk.Label({ label: data.now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), xalign: 0, wrap: true });
        date.add_css_class('dim-label');
        box.append(title);
        box.append(date);
        return box;
    }

    // There is no work folder or file history yet: point to the first two steps.
    private welcome(data: HomeData): Gtk.Widget {
        const buttons = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER });
        const folder = new Gtk.Button({ label: _('Open Folder…') });
        folder.add_css_class('pill');
        folder.add_css_class('suggested-action');
        folder.connect('clicked', () => this.onOpenFolder());
        const doc = new Gtk.Button({ label: _('New Document') });
        doc.add_css_class('pill');
        doc.connect('clicked', () => this.onNewDocument());
        buttons.append(folder);
        buttons.append(doc);
        return new Adw.StatusPage({
            icon_name: 'user-home-symbolic', title: this.greeting(data), child: buttons,
            description: _('Open a work folder to see the latest files, kanban due dates, and the inbox here.'),
        });
    }

    private addSection(title: string, child: Gtk.Widget): void {
        const label = new Gtk.Label({ label: title, xalign: 0, margin_top: 16, accessible_role: Gtk.AccessibleRole.HEADING });
        label.add_css_class('heading');
        this.page.append(label);
        this.page.append(child);
    }

    private list(rows: Gtk.Widget[]): Gtk.ListBox {
        const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        list.add_css_class('boxed-list');
        for (const row of rows) list.append(row);
        return list;
    }

    private row(title: string, subtitle = ''): Adw.ActionRow {
        // Card titles and file names may contain "&" or "<": show them as is, not as markup.
        const row = new Adw.ActionRow({ title, subtitle, use_markup: false, activatable: true });
        row.set_title_lines(2);
        row.set_subtitle_lines(1);
        return row;
    }

    private suffix(text: string, style: string | null = 'dim-label'): Gtk.Label {
        const label = new Gtk.Label({ label: text, valign: Gtk.Align.CENTER });
        if (style) label.add_css_class(style);
        return label;
    }

    // ---------- Continue ----------

    private resumeCards(data: HomeData): Gtk.Widget {
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, min_children_per_line: 1, max_children_per_line: RESUME_CARDS,
            column_spacing: 12, row_spacing: 12,
        });
        for (const entry of data.resume) {
            const folder = new Gtk.Label({ label: entry.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            folder.add_css_class('heading');
            const file = new Gtk.Label({ label: entry.subtitle, xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE });
            const time = new Gtk.Label({ label: ageLabel(new Date(entry.time * 1000), data.now), xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            time.add_css_class('dim-label');
            time.add_css_class('caption');
            const icon = new Gtk.Image({ icon_name: 'folder-documents-symbolic', halign: Gtk.Align.START, margin_bottom: 4 });
            icon.add_css_class('dim-label');
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });
            box.append(icon);
            box.append(folder);
            box.append(file);
            box.append(time);
            const card = new Gtk.Button({ child: box, width_request: 150 });
            card.add_css_class('card');
            card.add_css_class('home-card');
            card.set_tooltip_text(entry.path);
            card.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Continue {file} in {folder}'), { file: entry.subtitle, folder: entry.title })]);
            card.connect('clicked', () => this.onOpenFile(entry.path));
            // Keyboard focus goes straight to the button, not to the wrapping FlowBox child.
            flow.append(new Gtk.FlowBoxChild({ child: card, focusable: false }));
        }
        return flow;
    }

    // ---------- Journal ----------

    private journalRow(journal: HomeJournal): Adw.ActionRow {
        const parts: string[] = [];
        if (journal.notes) parts.push(fmt(ngettext('{n} note', '{n} notes', journal.notes), { n: journal.notes }));
        if (journal.activity) parts.push(fmt(ngettext('{n} activity', '{n} activities', journal.activity), { n: journal.activity }));
        const subtitle = parts.length ? parts.join(' · ') : journal.exists ? _('No notes yet') : _('Not written yet');
        const row = this.row(_("Today's journal"), subtitle);
        row.add_prefix(new Gtk.Image({ icon_name: 'x-office-calendar-symbolic' }));
        const capture = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Add to Journal…') });
        capture.add_css_class('flat');
        capture.update_property([Gtk.AccessibleProperty.LABEL], [_('Add to Journal…')]);
        capture.connect('clicked', () => this.onCaptureJournal());
        row.add_suffix(capture);
        row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        row.connect('activated', () => this.onOpenJournal());
        return row;
    }

    // ---------- Agent ----------

    // Where agents run and whether that machine answers. The state is written out, not only shown by an icon or a color.
    private hostRow(host: HomeAgentHost): Adw.ActionRow {
        const trouble = host.state === 'waiting' || host.state === 'failed';
        const detail = host.detail.trim();
        const [text, style] = host.state === 'ready' ? [_('Connected'), 'success']
            : host.state === 'waiting' ? [_('Trying again'), 'warning']
            : host.state === 'failed' ? [_('Cannot connect'), 'error']
            : [_('Connecting…'), 'dim-label'];
        const row = this.row(fmt(_('Agents run on {machine}'), { machine: host.label }), trouble ? detail : '');
        row.set_activatable(false);
        row.set_subtitle_lines(2);
        row.add_prefix(new Gtk.Image({ icon_name: trouble ? 'network-error-symbolic' : 'network-server-symbolic' }));
        row.add_suffix(this.suffix(text, style));
        return row;
    }

    private runRow(run: HomeRun): Adw.ActionRow {
        const row = this.row(run.title, run.agent);
        const [text, style] = run.status === 'waiting' ? [_('Waiting for your answer'), 'warning']
            : run.status === 'queued' ? [_('Queued'), 'dim-label']
            : [_('Working'), 'accent'];
        row.add_suffix(this.suffix(text, style));
        row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        row.connect('activated', () => this.onOpenRun(run.id));
        return row;
    }

    // ---------- Due dates ----------

    private dueText(task: Task): [string, string] {
        if (task.status === 'overdue') return [fmt(ngettext('{n} day overdue', '{n} days overdue', -task.days), { n: -task.days }), 'error'];
        if (task.status === 'today') return [_('Today'), 'warning'];
        return [task.days === 1 ? _('Tomorrow') : _('Day after tomorrow'), 'dim-label'];
    }

    private taskList(data: HomeData): Gtk.Widget {
        if (!data.workspace) {
            const row = this.row(_('Open a work folder to see due dates from kanban boards'));
            row.add_suffix(new Gtk.Image({ icon_name: 'folder-open-symbolic' }));
            row.connect('activated', () => this.onOpenFolder());
            return this.list([row]);
        }
        if (!data.tasks.length) {
            const row = new Adw.ActionRow({ title: _('Nothing is due until the day after tomorrow'), activatable: false });
            row.add_css_class('dim-label');
            return this.list([row]);
        }
        const shown = this.allTasks ? data.tasks : data.tasks.slice(0, SHOWN_TASKS);
        const rows: Gtk.Widget[] = shown.map(task => this.taskRow(task));
        const hidden = data.tasks.length - shown.length;
        if (hidden > 0) {
            const more = new Adw.ActionRow({ title: fmt(ngettext('Show {n} more task', 'Show {n} more tasks', hidden), { n: hidden }), activatable: true });
            more.add_suffix(new Gtk.Image({ icon_name: 'pan-down-symbolic' }));
            more.connect('activated', () => {
                this.allTasks = true;
                // Deferred: this row is destroyed along with Home when it is redrawn.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this.data) this.render(this.data);
                    return GLib.SOURCE_REMOVE;
                });
            });
            rows.push(more);
        }
        return this.list(rows);
    }

    private taskRow(task: Task): Adw.ActionRow {
        const board = task.file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
        const row = this.row(task.title, task.project ? `${task.project} · ${board}` : board);
        const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER });
        check.add_css_class('selection-mode');
        check.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Mark done: {title}'), { title: task.title })]);
        let reverting = false;
        check.connect('toggled', () => {
            if (reverting) return;
            const done = check.active;
            if (!this.onToggleTask(task, done)) {
                reverting = true;
                check.active = !done;
                reverting = false;
                return;
            }
            // The row stays in place until Home is redrawn, so a mistaken check can be undone.
            if (done) row.add_css_class('dim-label'); else row.remove_css_class('dim-label');
        });
        row.add_prefix(check);
        const [text, style] = this.dueText(task);
        row.add_suffix(this.suffix(text, style));
        row.connect('activated', () => this.onOpenTask(task));
        return row;
    }

    // ---------- Inbox and recent files ----------

    private inboxRow(inbox: InboxCount): Adw.ActionRow {
        const row = this.row(inbox.file);
        row.add_prefix(new Gtk.Image({ icon_name: 'mail-unread-symbolic' }));
        row.add_suffix(this.suffix(fmt(ngettext('{n} unprocessed', '{n} unprocessed', inbox.open), { n: inbox.open })));
        row.connect('activated', () => this.onOpenInbox(inbox.file));
        return row;
    }

    private recentRow(entry: HomeEntry, now: Date): Adw.ActionRow {
        const row = this.row(entry.title, entry.subtitle);
        row.set_title_lines(1);
        row.set_tooltip_text(entry.path);
        row.add_prefix(new Gtk.Image({ icon_name: 'text-x-generic-symbolic' }));
        row.add_suffix(this.suffix(ageLabel(new Date(entry.time * 1000), now)));
        row.connect('activated', () => this.onOpenFile(entry.path));
        return row;
    }
}
