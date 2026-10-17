// The two new parts of a live answer in the Assistant panel: a status card that replaces the many gray lines
// (context, lookups, thinking) with one line of progress that opens into the details, and the row of actions
// under a finished answer.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import type { ToolStep } from '../agent/session.js';
import { formatMs } from '../agent/tracetree.js';
import { _, fmt, ngettext } from '../i18n.js';
import { after, type Awaitable } from '../gtkutil.js';

type Phase = 'thinking' | 'step' | 'writing' | 'done' | 'stopped' | 'failed';
const RUNNING: ReadonlySet<Phase> = new Set(['thinking', 'step', 'writing']);
const PHASE_ICON: Partial<Record<Phase, string>> = { done: 'object-select-symbolic', stopped: 'media-playback-pause-symbolic', failed: 'dialog-warning-symbolic' };

interface StepRow { label: Gtk.Label; spinner: Gtk.Spinner; check: Gtk.Image }

export class TurnStatus {
    readonly widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, visible: false });
    private readonly icon = new Gtk.Image();
    private readonly spinner = new Gtk.Spinner({ spinning: true });
    private readonly label = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: 3 });
    private readonly time = new Gtk.Label();
    private readonly arrow = new Gtk.Image({ icon_name: 'pan-end-symbolic' });
    private readonly retry = new Gtk.Button({ label: _('Retry'), visible: false, valign: Gtk.Align.CENTER, margin_end: 6 });
    private readonly revealer = new Gtk.Revealer();
    private readonly context = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true, visible: false });
    private readonly steps = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    private readonly thinking = new Gtk.Expander({ label: _('Thinking process'), visible: false });
    private readonly thinkingText = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
    private readonly rows = new Map<string, StepRow>();
    private phase: Phase = 'thinking';
    private started = 0;
    private timer = 0;
    private lookups = 0;

    constructor(onRetry: () => void) {
        this.widget.add_css_class('chat-status');
        const head = new Gtk.ToggleButton({ has_frame: false, hexpand: true });
        head.add_css_class('chat-status-head');
        const line = new Gtk.Box({ spacing: 8 });
        this.icon.set_visible(false);
        this.time.add_css_class('side-meta');
        for (const w of [this.spinner, this.icon, this.label, this.time, this.arrow]) line.append(w);
        head.set_child(line);
        head.connect('toggled', () => {
            this.revealer.set_reveal_child(head.active);
            this.arrow.set_from_icon_name(head.active ? 'pan-down-symbolic' : 'pan-end-symbolic');
        });
        this.retry.add_css_class('flat');
        this.retry.connect('clicked', onRetry);
        const top = new Gtk.Box();
        top.append(head);
        top.append(this.retry);

        this.context.add_css_class('side-meta');
        this.thinkingText.add_css_class('chat-thinking');
        this.thinking.set_child(this.thinkingText);
        const details = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_start: 12, margin_end: 12, margin_bottom: 8 });
        for (const w of [this.context, this.steps, this.thinking]) details.append(w);
        this.revealer.set_child(details);
        this.widget.append(top);
        this.widget.append(this.revealer);
        this.widget.connect('unrealize', () => this.stopTimer());
    }

    // The turn starts: show the card with "Thinking…" and the clock.
    begin(): void {
        this.started = GLib.get_monotonic_time();
        this.setPhase('thinking', _('Thinking…'));
        this.widget.set_visible(true);
        this.tick();
        this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => { this.tick(); return GLib.SOURCE_CONTINUE; });
    }

    private tick(): void {
        this.time.set_text(formatMs(Math.round(this.elapsedMs() / 1000) * 1000));
    }

    private elapsedMs(): number {
        return Math.round((GLib.get_monotonic_time() - this.started) / 1000);
    }

    private stopTimer(): void {
        if (this.timer) GLib.source_remove(this.timer);
        this.timer = 0;
    }

    private setPhase(phase: Phase, text: string): void {
        this.phase = phase;
        const running = RUNNING.has(phase);
        this.spinner.set_visible(running);
        this.spinner.set_spinning(running && this.widget.get_mapped());
        const icon = PHASE_ICON[phase];
        this.icon.set_visible(!!icon);
        if (icon) this.icon.set_from_icon_name(icon);
        for (const c of ['stopped', 'failed']) this.widget.remove_css_class(c);
        if (phase === 'stopped' || phase === 'failed') this.widget.add_css_class(phase);
        this.icon.remove_css_class('done-icon');
        if (phase === 'done') this.icon.add_css_class('done-icon');
        if (this.label.get_text() !== text) this.label.set_text(text);
    }

    setContext(text: string): void {
        this.context.set_text(text);
        this.context.set_visible(true);
    }

    setReasoning(text: string): void {
        this.thinking.set_visible(true);
        this.thinkingText.set_text(text);
        if (this.phase === 'step') this.setPhase('thinking', _('Thinking…'));
    }

    writing(): void {
        if (this.phase === 'thinking' || this.phase === 'step') this.setPhase('writing', _('Writing the answer…'));
    }

    // Called twice per lookup (start and finish) with the same id.
    step(step: ToolStep): void {
        let row = this.rows.get(step.id);
        if (!row) {
            row = this.addRow();
            this.rows.set(step.id, row);
            this.lookups++;
        }
        const finished = !!step.summary;
        row.label.set_text(finished ? `${step.label} → ${step.summary}` : `${step.label}…`);
        row.spinner.set_visible(!finished);
        row.spinner.set_spinning(!finished);
        row.check.set_visible(finished);
        if (RUNNING.has(this.phase)) this.setPhase(finished ? 'thinking' : 'step', finished ? _('Thinking…') : `${step.label} · ${fmt(_('step {n}'), { n: this.lookups })}`);
    }

    private addRow(): StepRow {
        const box = new Gtk.Box({ spacing: 6 });
        const spinner = new Gtk.Spinner({ spinning: true });
        const check = new Gtk.Image({ icon_name: 'object-select-symbolic', visible: false });
        const label = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 42, selectable: true, hexpand: true });
        label.add_css_class('chat-step');
        check.add_css_class('chat-step');
        for (const w of [spinner, check, label]) box.append(w);
        this.steps.append(box);
        return { label, spinner, check };
    }

    // The turn ended: the card shows the outcome, and the clock stops.
    finish(phase: 'done' | 'stopped' | 'failed', answered = true): void {
        this.stopTimer();
        this.tick();
        for (const row of this.rows.values()) { row.spinner.set_spinning(false); row.spinner.set_visible(false); }
        const n = this.lookups;
        const texts = {
            done: n ? fmt(ngettext('{count} lookup', '{count} lookups', n), { count: n }) : _('Answered'),
            stopped: n ? fmt(_('Stopped after step {n}'), { n }) : answered ? _('Stopped') : _('Stopped before any answer'),
            failed: _('Something went wrong'),
        };
        this.setPhase(phase, texts[phase]);
        this.retry.set_visible(phase !== 'done');
        this.widget.set_visible(true);
    }
}

export interface ActionHandlers {
    text(): string;                              // the answer, as Markdown
    insert?(text: string): Awaitable<boolean>;   // put the answer into the open note
    retry(): void;
    log(): void;
}

function actionButton(icon: string, label: string, onClick: (content: Adw.ButtonContent) => void): Gtk.Button {
    const content = new Adw.ButtonContent({ icon_name: icon, label });
    const button = new Gtk.Button({ child: content });
    button.add_css_class('flat');
    button.connect('clicked', () => onClick(content));
    return button;
}

// Copy, Insert into note, Retry, Log: under a finished answer.
export function actionBar(handlers: ActionHandlers): Gtk.Box {
    const bar = new Gtk.Box({ spacing: 2 });
    bar.add_css_class('chat-actions');
    bar.append(actionButton('edit-copy-symbolic', _('Copy'), content => {
        content.get_clipboard().set(handlers.text());
        content.set_label(_('Copied'));
    }));
    if (handlers.insert) {
        const insert = handlers.insert;
        bar.append(actionButton('insert-text-symbolic', _('Insert into note'), content => {
            void after(insert(handlers.text()), done => content.set_label(done ? _('Inserted') : _('Open a note first')));
        }));
    }
    bar.append(actionButton('view-refresh-symbolic', _('Retry'), () => handlers.retry()));
    bar.append(actionButton('utilities-terminal-symbolic', _('Log'), () => handlers.log()));
    return bar;
}
