// Agent activity monitor window: the tree of each turn (model rounds, reasoning, tools) on the left, everything
// about the selected step on the right. Updates itself while the agent works; only reads a LogSource (a replica of the core's AgentTrace).

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import { type TraceEvent, type TraceKind } from '../agent/trace.js';
import type { LogSource } from '../agent/tracefeed.js';
import { formatMs, traceTree, type TraceNode } from '../agent/tracetree.js';
import { LOG_HEADERS, settledNewest, visibleSteps } from '../agent/logrows.js';
import { onKeyPress } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
import { LogDetail } from './logdetail.js';

const KIND_ICON: Record<TraceKind, string> = {
    turn: 'user-available-symbolic', round: 'media-playlist-repeat-symbolic', reasoning: 'format-justify-left-symbolic', text: 'document-edit-symbolic',
    tool: 'utilities-terminal-symbolic', usage: 'view-list-symbolic', note: 'media-playback-stop-symbolic', error: 'dialog-warning-symbolic',
};
const KIND_FILTER = (): [string, TraceKind[]][] => [[_('All'), []], [_('Tools'), ['tool']], [_('Reasoning'), ['reasoning']], [_('Model'), ['round', 'text']]];
const HEADER = LOG_HEADERS;

function rowLabel(e: TraceEvent): string {
    if (e.kind === 'round') return fmt(_('Round {n}'), { n: e.round ?? '' });
    if (e.kind === 'reasoning') return _('Reasoning');
    if (e.kind === 'text') return _('Answer');
    return e.title.replace(/^(New turn|Tool): /, '');
}

const rowMeta = (e: TraceEvent): string => e.ms !== undefined ? formatMs(e.ms) : e.status === 'running' ? '…' : e.time.slice(11);

interface Row {
    row: Gtk.ListBoxRow;
    chevron: Gtk.Button | null;
    label: Gtk.Label;
    meta: Gtk.Label;
    node: TraceNode;
}

export class LogViewer {
    readonly window: Adw.Window;
    readonly list: Gtk.ListBox;
    private readonly scroller: Gtk.ScrolledWindow;
    private readonly summary: Gtk.Label;
    readonly detail = new LogDetail();
    private readonly rows = new Map<number, Row>();
    private readonly collapsed = new Set<number>();
    private nodes: TraceNode[] = [];
    private filter: TraceKind[] = [];
    private selected: number | null = null;
    private manual = false;   // the user picked a step: stop following the newest one
    private following = false;   // a selection made by refresh(), not by the user
    private timer = 0;
    private stick = true;
    private stickIdle = 0;

    constructor(parent: Gtk.Window | null, private readonly trace: LogSource, title = _('Agent log')) {
        this.window = new Adw.Window({ transient_for: parent, default_width: 980, default_height: 660, title });
        const header = new Adw.HeaderBar();

        const copy = new Gtk.Button({ label: _('Copy all'), tooltip_text: _('Copy the whole log as text') });
        copy.connect('clicked', () => this.window.get_clipboard().set(this.trace.text()));
        const clear = new Gtk.Button({ label: _('Clear'), tooltip_text: _('Clear the log view (the conversation is not affected)') });
        clear.connect('clicked', () => { this.selected = null; this.manual = false; this.trace.clear(); });
        header.pack_start(copy);
        header.pack_start(clear);

        const filters = new Gtk.Box({ spacing: 4, margin_start: 10, margin_end: 10, margin_top: 8, margin_bottom: 8 });
        let first: Gtk.ToggleButton | null = null;
        for (const [label, kinds] of KIND_FILTER()) {
            const button = new Gtk.ToggleButton({ label, active: !first });
            if (first) button.set_group(first); else first = button;
            button.connect('toggled', () => { if (button.active) { this.filter = kinds; this.applyVisibility(); } });
            filters.append(button);
        }
        this.summary = new Gtk.Label({ xalign: 1, hexpand: true });
        this.summary.add_css_class('dim-label');
        filters.append(this.summary);

        this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
        this.list.add_css_class('navigation-sidebar');
        this.list.connect('row-selected', (_l, row) => this.select(row ? this.seqOf(row) : null, true));
        this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, min_content_width: 260 });
        this.scroller.set_child(this.list);
        this.followBottom();

        const paned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL, position: 320, shrink_start_child: false, shrink_end_child: false, vexpand: true });
        paned.set_start_child(this.scroller);
        paned.set_end_child(this.detail.widget);
        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        body.append(filters);
        body.append(new Gtk.Separator());
        body.append(paned);
        const view = new Adw.ToolbarView({ content: body });
        view.add_top_bar(header);
        this.window.set_content(view);

        this.trace.onChange = () => this.queueRefresh();
        this.window.connect('unrealize', () => this.dispose());
        onKeyPress(this.window, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            this.window.destroy();
            return true;
        });
        this.refresh();
    }

    // Same as the Assistant panel: scrolling inside "changed" is not applied by the viewport, so it is deferred to idle.
    private followBottom(): void {
        const vadj = this.scroller.get_vadjustment();
        vadj.connect('changed', () => {
            if (!this.stick || this.stickIdle) return;
            this.stickIdle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                this.stickIdle = 0;
                if (this.stick) vadj.set_value(vadj.get_upper() - vadj.get_page_size());
                return GLib.SOURCE_REMOVE;
            });
        });
        vadj.connect('value-changed', () => { this.stick = vadj.get_upper() - vadj.get_page_size() - vadj.get_value() < 24; });
    }

    private dispose(): void {
        if (this.timer) GLib.source_remove(this.timer);
        if (this.stickIdle) GLib.source_remove(this.stickIdle);
        this.timer = this.stickIdle = 0;
        this.trace.onChange = () => {};
    }

    show(): void {
        this.stick = true;
        this.manual = false;
        this.window.present();
    }

    // Reasoning streams dozens of times per second; the view only needs to be updated a few times.
    private queueRefresh(): void {
        if (this.timer) return;
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => { this.timer = 0; this.refresh(); return GLib.SOURCE_REMOVE; });
    }

    private seqOf(row: Gtk.ListBoxRow): number | null {
        for (const [seq, r] of this.rows) if (r.row === row) return seq;
        return null;
    }

    private select(seq: number | null, byUser: boolean): void {
        if (byUser && seq !== null && seq !== this.selected && !this.following) this.manual = seq !== this.settledNewest();
        this.selected = seq;
        this.showDetail();
    }

    private settledNewest(): number | null {
        return settledNewest(this.nodes, new Set([...this.rows].filter(([, r]) => r.row.get_visible()).map(([seq]) => seq)));
    }

    private showDetail(): void {
        this.detail.show(this.selected !== null ? this.nodes.find(n => n.event.seq === this.selected)?.event ?? null : null, this.nodes);
    }

    private makeRow(node: TraceNode): Row {
        const box = new Gtk.Box({ spacing: 6, margin_start: 4 + node.depth * 14, margin_top: 2, margin_bottom: 2 });
        const header = HEADER.has(node.event.kind);
        let chevron: Gtk.Button | null = null;
        if (header) {
            chevron = Gtk.Button.new_from_icon_name('pan-down-symbolic');
            chevron.add_css_class('flat');
            chevron.add_css_class('circular');
            chevron.connect('clicked', () => this.toggle(node.event.seq));
            box.append(chevron);
        } else box.append(new Gtk.Box({ width_request: 34 }));
        if (node.event.kind !== 'round') box.append(new Gtk.Image({ icon_name: KIND_ICON[node.event.kind] }));
        const label = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: 3 });
        const meta = new Gtk.Label({ xalign: 1 });
        meta.add_css_class('dim-label');
        meta.add_css_class('caption');
        box.append(label);
        box.append(meta);
        const row = new Gtk.ListBoxRow({ child: box });
        this.list.append(row);
        return { row, chevron, label, meta, node };
    }

    private toggle(seq: number): void {
        if (!this.collapsed.delete(seq)) this.collapsed.add(seq);
        this.applyVisibility();
    }

    private refresh(): void {
        const events = this.trace.events;
        // Events were trimmed or the log was cleared: rebuild from the start.
        const first = events[0]?.seq;
        for (const [seq, row] of [...this.rows]) {
            if (first === undefined || seq < first || this.rows.size > events.length) {
                this.list.remove(row.row);
                this.rows.delete(seq);
            }
        }
        this.nodes = traceTree(events);
        for (const node of this.nodes) this.updateRow(node);
        this.applyVisibility();
        const tools = events.filter(e => e.kind === 'tool').length;
        const rounds = events.filter(e => e.kind === 'round').length;
        this.summary.set_text(events.length ? fmt(_('{rounds} model rounds · {tools} tool calls'), { rounds, tools }) : _('No activity yet. Send a question to the Assistant.'));
        this.followNewest();
    }

    private updateRow(node: TraceNode): void {
        const { event } = node;
        const row = this.rows.get(event.seq) ?? this.rows.set(event.seq, this.makeRow(node)).get(event.seq)!;
        row.node = node;
        const text = rowLabel(event) + (event.status === 'failed' ? ` — ${_('failed')}` : '');
        if (row.label.get_text() !== text) row.label.set_text(text);
        const meta = rowMeta(event);
        if (row.meta.get_text() !== meta) row.meta.set_text(meta);
        if (event.status === 'failed') row.label.add_css_class('error'); else row.label.remove_css_class('error');
        if (event.kind === 'turn') row.label.add_css_class('heading');
    }

    // Until the user picks something, the detail follows the newest step; otherwise it only refreshes its own contents.
    private followNewest(): void {
        const newest = this.settledNewest();
        if (!this.manual && newest !== null && newest !== this.selected) {
            this.following = true;
            this.list.select_row(this.rows.get(newest)!.row);
            this.following = false;
        } else this.showDetail();
    }

    // Which steps show is decided by logrows.ts; this sets the rows and the chevrons.
    private applyVisibility(): void {
        const shown = visibleSteps(this.nodes, this.filter, this.collapsed);
        for (const n of this.nodes) {
            const row = this.rows.get(n.event.seq);
            if (!row) continue;
            row.row.set_visible(shown.has(n.event.seq));
            row.chevron?.set_icon_name(this.collapsed.has(n.event.seq) ? 'pan-end-symbolic' : 'pan-down-symbolic');
        }
    }
}
