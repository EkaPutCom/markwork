// Git conflict markers as a choice, like a merge conflict in a code editor: each side gets a background color, and a row of
// buttons above the conflict keeps the current lines, the incoming lines, or both.
//
//   Current  = the lines between `<<<<<<<` and `=======` (what the folder has)
//   Incoming = the lines between `=======` and `>>>>>>>` (what is being merged in)
//
// The row of buttons is a widget attached above empty space inside the text (see overlays.ts), the same way tables and code
// blocks are drawn; the space is the top padding of the `<<<<<<<` line, so the document contents do not change. A choice
// replaces the whole conflict, markers included, in one undo step. The parsing is in conflicts.ts.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import type { Palette } from '../colors.js';
import { _, fmt } from '../i18n.js';
import { iterAtLine, lineSpanOffsets } from '../gtkutil.js';
import { findConflicts, resolution, roles, type Choice, type Conflict, type Role } from '../markdown/conflicts.js';
import { OverlaySlots } from './overlays.js';
import { setTagGroup, type Range } from './tagsync.js';

const BAR_HEIGHT = 34;   // the room above the `<<<<<<<` line for the buttons

// [light, dark] background of each role. The head lines are a step stronger than the lines of their side.
const COLORS: Record<Role, [string, string]> = {
    current: ['#e1f3e6', '#1e3a2a'],
    currentHead: ['#bfe3ca', '#2b5a3e'],
    incoming: ['#dde9fa', '#1e344f'],
    incomingHead: ['#b9d3f3', '#2b4d78'],
    neutral: ['#ececee', '#34363b'],
};

const ROLES = Object.keys(COLORS) as Role[];

const CHOICES: { choice: Choice; label: () => string; tip: (c: Conflict) => string }[] = [
    { choice: 'current', label: () => _('Accept Current'), tip: c => fmt(_('Keep the lines from {name} and drop the other side'), { name: c.current || _('the current side') }) },
    { choice: 'incoming', label: () => _('Accept Incoming'), tip: c => fmt(_('Keep the lines from {name} and drop the other side'), { name: c.incoming || _('the incoming side') }) },
    { choice: 'both', label: () => _('Accept Both'), tip: () => _('Keep both sides, the current lines first') },
];

export class ConflictLayer {
    conflicts: Conflict[] = [];

    private readonly buffer: Gtk.TextBuffer;
    private readonly slots: OverlaySlots;
    private readonly tags = {} as Record<Role, Gtk.TextTag>;
    private readonly gap: Gtk.TextTag;
    private widgets: (Gtk.Box | null)[] = [];
    private lines: readonly string[] = [];
    private key = '';
    private adjustment: Gtk.Adjustment | null = null;
    private relayoutQueued = false;
    private destroyed = false;
    private placed: string[] = [];   // where each button row is, "x,y"

    constructor(private readonly view: Gtk.TextView) {
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);
        const table = this.buffer.get_tag_table();
        for (const role of ROLES) {
            this.tags[role] = new Gtk.TextTag({ name: `conflict-${role}` });
            table.add(this.tags[role]);
        }
        this.gap = new Gtk.TextTag({ name: 'conflict-gap', pixels_above_lines: BAR_HEIGHT });
        table.add(this.gap);
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
        adj.connect('value-changed', () => this.queueRelayout());
    }

    setPalette(palette: Palette): void {
        for (const role of ROLES) this.tags[role].paragraph_background = COLORS[role][palette.dark ? 1 : 0];
        // `=======` is also Markdown's ==highlight== syntax; the divider must not light up yellow.
        this.tags.neutral.background = COLORS.neutral[palette.dark ? 1 : 0];
    }

    // The marker lines sit at the left edge of the text, not indented like the quote that `>>>>>>>` would be in Markdown.
    // Margins are absolute, so they follow the editor margin (see setTagMargins()).
    setMargin(margin: number): void {
        for (const role of ['currentHead', 'incomingHead', 'neutral'] as const) this.tags[role].left_margin = margin;
    }

    // The text changed (or was highlighted again): find the conflicts and bring the colors, the room, and the buttons along.
    // force = the whole text was replaced, so the tags are gone even if the conflicts are on the same lines.
    update(text: string, lines: readonly string[], force = false): void {
        this.lines = lines;
        if (!this.conflicts.length && !text.includes('<<<<<<<')) return;   // nothing before, no marker now (one native search)
        const found = findConflicts(lines);
        const key = found.map(c => `${c.start}.${c.base}.${c.mid}.${c.end}`).join(' ');
        this.conflicts = found;
        if (force || key !== this.key) {
            this.key = key;
            this.sync();
        }
        this.queueRelayout();
    }

    // Colors the lines and reserves the room above each conflict. The buttons are built again for the conflicts as they are
    // now (their tooltips name the two sides), so every row goes back to the pool.
    private sync(): void {
        const iter = this.buffer.get_start_iter();
        const wanted = new Map<Gtk.TextTag, Range[]>();
        const add = (tag: Gtk.TextTag, first: number, last: number) => {
            const [start, , end] = lineSpanOffsets(iter, first, last);
            if (!wanted.has(tag)) wanted.set(tag, []);
            wanted.get(tag)!.push([start, end]);
        };
        for (const [line, role] of roles(this.conflicts)) add(this.tags[role], line, line);
        for (const c of this.conflicts) add(this.gap, c.start, c.start);
        setTagGroup(this.buffer, [...ROLES.map(r => this.tags[r]), this.gap], wanted);
        for (const widget of this.widgets) if (widget) this.slots.release(widget);
        this.widgets = [];
        this.placed = [];
    }

    // ---------- Choosing ----------

    // Replaces conflict `index` with the choice, in one undo step.
    choose(index: number, choice: Choice): void {
        const c = this.conflicts[index];
        if (!c) return;
        const buf = this.buffer;
        const replacement = resolution(this.lines, c, choice);
        const atEnd = c.end >= buf.get_line_count() - 1;
        const from = iterAtLine(buf, c.start);
        const to = atEnd ? buf.get_end_iter() : iterAtLine(buf, c.end + 1);
        const text = replacement.join('\n') + (!atEnd && replacement.length ? '\n' : '');
        buf.begin_user_action();
        buf.delete(from, to);
        buf.insert(from, text, -1);
        buf.end_user_action();
        buf.place_cursor(from);
        this.view.grab_focus();
    }

    // ---------- Buttons ----------

    private build(index: number): Gtk.Box {
        const bar = new Gtk.Box({ spacing: 2, valign: Gtk.Align.START });
        bar.add_css_class('conflict-bar');
        const c = this.conflicts[index];
        for (const { choice, label, tip } of CHOICES) {
            const button = new Gtk.Button({ label: label(), tooltip_text: tip(c) });
            button.add_css_class('flat');
            button.add_css_class('caption');
            button.connect('clicked', () => this.choose(index, choice));
            bar.append(button);
        }
        const slot = this.slots.acquire();
        slot.append(bar);
        this.widgets[index] = slot;
        return slot;
    }

    queueRelayout(): void {
        if (this.destroyed || this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            if (!this.destroyed) this.relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Only the conflicts on screen get buttons (see CodeLayer.relayout()).
    relayout(): void {
        if (!this.conflicts.length) return;
        const x = this.view.get_left_margin();
        const rect = this.view.get_visible_rect();
        const first = this.view.get_line_at_y(rect.y)[0].get_line();
        const last = this.view.get_line_at_y(rect.y + rect.height)[0].get_line();
        this.conflicts.forEach((c, i) => {
            const visible = c.end >= first && c.start <= last;
            if (visible && !this.widgets[i]) this.build(i);
            const slot = this.widgets[i];
            if (!slot) return;
            slot.set_visible(visible);
            if (!visible) return;
            const y = this.view.get_line_yrange(iterAtLine(this.buffer, c.start))[0];
            const at = `${x},${y}`;
            if (at === this.placed[i]) return;
            this.placed[i] = at;
            this.slots.place(slot, x, y);
        });
    }
}
