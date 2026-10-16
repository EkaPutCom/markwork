// The Assistant panel on the right side: a chat with a model (DeepSeek) that knows the manuscript contents.
// The panel only draws: the conversation's life cycle (sending, stopping, saving, reopening, undo) is in
// agent/chatcontroller.ts, which tells the panel what to show through ChatView. The window provides the manuscript
// through `host`. Context composition is in agent/context.ts, and calling the model goes through the Provider.
//
//   ┌ ASSISTANT               ⌫ ⚙ ┐
//   │ (messages, newest below)     │
//   │ Context · ≈12k tokens ▾      │
//   │ [type a question…      ] [➤] │
//   └──────────────────────────────┘

import { journalText } from '../agent/journal.js';
import { WorkList } from './worklist.js';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import type { KeyStore } from '../agent/apikey.js';
import type { BuiltContext, ContextOptions } from '../agent/context.js';
import { ChatController, type ChatControllerHost, type ChatView, type TurnOutcome, type TurnView } from '../agent/chatcontroller.js';
import type { Provider, Usage } from '../agent/provider.js';
import type { ChatSession, ProposalResult } from '../agent/session.js';
import type { Change } from '../agent/changes.js';
import type { ProposalViewer } from './proposalviewer.js';
import { ChatSettings } from './chatsettings.js';
import { ChatHistoryList } from './chathistory.js';
import { ContextPreview, describeContext, fmtTokens } from './chatcontext.js';
import { ProposalCards } from './proposalcard.js';
import { LogViewer } from './logviewer.js';
import { actionBar, TurnStatus } from './chatturn.js';
import { chatMarkup } from '../markdown/chatmarkup.js';
import { escapeMarkup, type MarkupColors } from '../markdown/pango.js';
import type { Palette } from '../colors.js';
import { childrenOf, onKeyPress, uiTemplate } from '../gtkutil.js';
import template from './chat.ui?raw';
import { _, fmt, ngettext } from '../i18n.js';
import type { Cancellable } from '../cancel.js';

// What the panel needs to know from the window: the controller's host plus a parent for its windows.
export interface ChatHost extends ChatControllerHost {
    window?(): Gtk.Window | null;                                           // parent of the proposal review and log windows
    insertText?(text: string): boolean;                                     // put text into the open note, at the cursor
}

const SUGGESTIONS = [
    _('Summarize this document in a few points'),
    _('What is unfinished or out of sync in this folder?'),
    _('Draft a plan for the next steps from my notes'),
];

const usageText = (u: Usage, toolCalls: number, applied = 0): string => [
    fmt(u.cached ? _('{prompt} in ({cached} from cache)') : _('{prompt} in'), { prompt: fmtTokens(u.prompt), cached: fmtTokens(u.cached) }),
    fmt(_('{completion} out'), { completion: fmtTokens(u.completion) }),
    ...toolCalls ? [fmt(ngettext('{count} lookup', '{count} lookups', toolCalls), { count: toolCalls })] : [],
    ...applied ? [fmt(ngettext('{count} change applied', '{count} changes applied', applied), { count: applied })] : [],
].join(' · ');

interface Bubble {
    label: Gtk.Label;
    text: string;
    markdown: boolean;
}

export class ChatPanel extends Gtk.Box implements ChatView {
    static {
        GObject.registerClass({
            GTypeName: 'MarkworkChatPanel',
            Template: uiTemplate(template),
            Children: [
                'input', 'sendButton', 'messages', 'scroller', 'contextButton', 'settingsButton', 'historyButton',
                'saveCheck', 'keyEntry', 'keyStatus', 'modelDrop', 'thinkingCheck', 'contextList', 'chatList',
            ],
            InternalChildren: [
                'clearButton', 'logButton', 'historyPopover', 'settingsPopover', 'contextPopover', 'saveKeyButton', 'forgetKeyButton',
                'contextDocument', 'contextSelection', 'contextProject',
            ],
        }, this);
    }
    // Widgets declared in chat.ui.
    declare readonly input: Gtk.TextView;
    declare readonly sendButton: Gtk.Button;
    declare readonly messages: Gtk.Box;
    declare readonly scroller: Gtk.ScrolledWindow;
    declare readonly contextButton: Gtk.MenuButton;
    declare readonly settingsButton: Gtk.MenuButton;
    declare readonly historyButton: Gtk.MenuButton;
    declare readonly saveCheck: Gtk.CheckButton;
    declare readonly keyEntry: Gtk.Entry;
    declare readonly keyStatus: Gtk.Label;
    declare readonly modelDrop: Gtk.DropDown;
    declare readonly thinkingCheck: Gtk.CheckButton;
    declare private readonly contextList: Gtk.Box;
    declare private readonly chatList: Gtk.Box;
    declare private readonly _clearButton: Gtk.Button;
    declare private readonly _logButton: Gtk.Button;
    declare private readonly _historyPopover: Gtk.Popover;
    declare private readonly _settingsPopover: Gtk.Popover;
    declare private readonly _contextPopover: Gtk.Popover;
    declare private readonly _saveKeyButton: Gtk.Button;
    declare private readonly _forgetKeyButton: Gtk.Button;
    declare private readonly _contextDocument: Gtk.CheckButton;
    declare private readonly _contextSelection: Gtk.CheckButton;
    declare private readonly _contextProject: Gtk.CheckButton;

    readonly controller = new ChatController(this);
    private chatHost: ChatHost = { active: () => null, selection: () => '', files: () => [], root: () => null };


    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private readonly bubbles: Bubble[] = [];
    readonly empty: Gtk.Box;           // initial hint; shown while the conversation is empty
    logViewer: LogViewer | null = null;   // the agent log monitor window, if open
    private renderTimer = 0;
    private dark = false;
    private cardsBox: Gtk.Box | null = null;   // where the proposal cards of the running turn live
    readonly settings: ChatSettings;   // API key, model, thinking mode, saving conversations
    private readonly contextPart: ContextPreview;
    private readonly proposals: ProposalCards;
    private stickIdle = 0;
    private stick = true;            // stay stuck to the bottom as long as the user has not scrolled up
    private summaryTimer = 0;

    constructor() {
        super();
        this._clearButton.connect('clicked', () => this.reset());
        this._logButton.connect('clicked', () => this.showLog());
        new ChatHistoryList(this.historyButton, this._historyPopover, this.chatList, this.controller, path => this.openChat(path), message => this.addNote(message, true));
        this.settings = new ChatSettings({
            popover: this._settingsPopover, keyEntry: this.keyEntry, keyStatus: this.keyStatus, saveKeyButton: this._saveKeyButton,
            forgetKeyButton: this._forgetKeyButton, modelDrop: this.modelDrop, thinkingCheck: this.thinkingCheck, saveCheck: this.saveCheck,
        }, this.controller);
        this.proposals = new ProposalCards({
            controller: this.controller,
            window: () => this.host.window?.() ?? null,
            dark: () => this.dark,
            note: (text, error) => this.addNote(text, error),
        });

        // Messages
        this.empty = this.buildEmptyState();
        this.messages.append(this.empty);
        const vadj = this.scroller.get_vadjustment();
        // Scrolling inside the "changed" signal (emitted during layout allocation) changes its value, but the viewport does not
        // apply it: the contents show cut off by a few lines with an invisible footer. That is why it scrolls at the next idle.
        vadj.connect('changed', () => {
            if (!this.stick || this.stickIdle) return;
            this.stickIdle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                this.stickIdle = 0;
                if (this.stick) vadj.set_value(vadj.get_upper() - vadj.get_page_size());
                return GLib.SOURCE_REMOVE;
            });
        });
        vadj.connect('value-changed', () => { this.stick = vadj.get_upper() - vadj.get_page_size() - vadj.get_value() < 24; });

        // Context: which choices are sent.
        this.contextPart = new ContextPreview({
            button: this.contextButton, popover: this._contextPopover, list: this.contextList,
            checks: [[this._contextDocument, 'activeDocument'], [this._contextSelection, 'selection'], [this._contextProject, 'project']],
        }, () => this.options, () => this.previewContext(), () => this.budget);

        // Input. CAPTURE phase: before the TextView itself inserts a new line for Enter.
        onKeyPress(this.input, (keyval, state) => this.onInputKey(keyval, state), Gtk.PropagationPhase.CAPTURE);
        this.input.buffer.connect('changed', () => { this.queueContextSummary(); this.updateSendButton(); });
        this.sendButton.connect('clicked', () => this.busy ? this.stop() : void this.send());
        this.updateSendButton();
        // The panel may already be open since the window was created (GSettings), without notify::show-sidebar: compute when shown.
        this.connect('map', () => this.updateContextSummary());
    }

    // Send: the primary button (suggested-action), disabled while the message box is empty. Stop: a plain button, always enabled.
    private updateSendButton(): void {
        const busy = this.busy;
        this.sendButton.set_icon_name(busy ? 'media-playback-stop-symbolic' : 'go-up-symbolic');
        if (busy) this.sendButton.add_css_class('destructive-action'); else this.sendButton.remove_css_class('destructive-action');
        this.sendButton.set_tooltip_text(busy ? _('Stop') : _('Send (Enter)'));
        this.sendButton.update_property([Gtk.AccessibleProperty.LABEL], [busy ? _('Stop') : _('Send')]);
        if (busy) this.sendButton.remove_css_class('suggested-action');
        else this.sendButton.add_css_class('suggested-action');
        this.sendButton.set_sensitive(busy || !!this.input.buffer.text.trim());
    }

    get widget(): Gtk.Widget {
        return this;
    }

    // Window closed: stop the requests and timers that are still running.
    destroy(): void {
        this.stop();
        this.logViewer?.window.destroy();
        if (this.renderTimer) GLib.source_remove(this.renderTimer);
        this.renderTimer = 0;
        if (this.summaryTimer) GLib.source_remove(this.summaryTimer);
        this.summaryTimer = 0;
        if (this.stickIdle) GLib.source_remove(this.stickIdle);
        this.stickIdle = 0;
    }

    // The conversation state lives in the controller; these pass through for the window and tests.
    get session(): ChatSession { return this.controller.session; }
    get host(): ChatHost { return this.chatHost; }
    set host(host: ChatHost) { this.chatHost = host; this.controller.host = host; }
    get makeProvider(): (key: string) => Provider { return this.controller.makeProvider; }
    set makeProvider(make: (key: string) => Provider) { this.controller.makeProvider = make; }
    get keyStore(): KeyStore { return this.controller.keyStore; }
    set keyStore(store: KeyStore) { this.controller.keyStore = store; }
    get model(): string { return this.controller.model; }   // sent to the API as is; setModel() normalizes it
    set model(model: string) { this.controller.model = model; }
    get saveChats(): boolean { return this.controller.saveChats; }
    set saveChats(save: boolean) { this.controller.saveChats = save; }
    get options(): ContextOptions { return this.controller.options; }
    set options(options: ContextOptions) { this.controller.options = options; }
    get budget(): number { return this.controller.budget; }
    set budget(budget: number) { this.controller.budget = budget; }
    get busy(): boolean { return this.controller.busy; }
    get viewer(): ProposalViewer | null { return this.proposals.viewer; }   // the review window waiting for a decision

    setPalette(palette: Palette): void {
        this.dark = palette.dark;
        this.proposals.viewer?.setDark(palette.dark);
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        for (const b of this.bubbles) this.render(b);
    }

    // The settings popover with the API key, e.g. for a feature elsewhere that needs the key.
    openSettings(): void {
        this.settingsButton.get_popover()?.popup();
    }

    focusInput(): void {
        this.input.grab_focus();
    }

    // ---------- Conversation ----------

    reset(): void {
        this.controller.reset();
        this.clearMessages();
        this.updateContextSummary();
    }

    private clearMessages(): void {
        this.bubbles.length = 0;
        for (const child of childrenOf(this.messages)) if (child !== this.empty) this.messages.remove(child);
        this.empty.show();
    }

    stop(): void {
        this.controller.stop();
    }

    // Open (or focus) the agent log monitor window.
    showLog(): void {
        if (this.logViewer?.window.get_realized()) { this.logViewer.show(); return; }
        this.logViewer = new LogViewer(this.host.window?.() ?? null, this.session.trace);
        this.logViewer.show();
    }

    // Fill the input box and (optionally) send right away; used by the suggestion buttons and tests.
    ask(text: string, send = true): Promise<void> {
        this.input.buffer.set_text(text, -1);
        return send ? this.send() : Promise.resolve();
    }

    send(): Promise<void> {
        return this.controller.send(this.input.buffer.text);
    }

    // ---------- ChatView: what the controller shows ----------

    noKey(): void {
        this.addNote('There is no DeepSeek API key yet. Open the settings (gear icon), paste the key, then send again.', true);
        this.settingsButton.get_popover()?.popup();
    }

    saveFailed(error: string): void {
        this.addNote(fmt(_('Conversation history was not saved: {error}'), { error }), true);
    }

    busyChanged(busy: boolean): void {
        this.updateSendButton();
        if (!busy) this.updateContextSummary();
    }

    startTurn(question: string): TurnView {
        this.input.buffer.set_text('', -1);
        this.empty.hide();
        this.addUser(question);
        const answer = this.addAssistant(question);
        this.cardsBox = answer.cards;
        this.stick = true;
        let reasoning = '';
        return {
            context: built => {
                this.contextPart.setSummary(built);
                answer.status.setContext(describeContext(built));
            },
            text: delta => { answer.status.writing(); answer.bubble.text += delta; this.queueRender(answer.bubble); },
            reasoning: delta => {
                reasoning += delta;
                answer.status.setReasoning(reasoning.trim());
            },
            step: step => answer.status.step(step),
            work: (work, running, elapsed) => {
                answer.work.update(work, running, elapsed);
                answer.work.widget.show();
            },
            end: (outcome: TurnOutcome) => {
                this.render(answer.bubble);
                answer.actions.set_visible(!!answer.bubble.text.trim());
                if ('error' in outcome) {
                    answer.status.finish('failed');
                    answer.footer.set_markup(`<span foreground="#c9372c">${escapeMarkup(outcome.error)}</span>`);
                    answer.footer.show();
                    if (!answer.bubble.text) answer.bubble.label.hide();
                    return;
                }
                answer.status.finish(outcome.cancelled ? 'stopped' : 'done', !!answer.bubble.text.trim());
                if (!outcome.cancelled && outcome.usage) answer.footer.set_text(usageText(outcome.usage, outcome.toolCalls, outcome.applied));
                answer.footer.set_visible(!!answer.footer.get_text());
            },
        };
    }

    // ---------- History on disk ----------

    // Show a saved conversation and continue from there: the next turns are appended to the same file.
    openChat(path: string): boolean {
        const chat = this.controller.open(path);
        if (!chat) {
            this.addNote('The conversation file could not be read.', true);
            return false;
        }
        this.clearMessages();
        this.empty.hide();
        for (const turn of chat.turns) {
            if (turn.role === 'user') {
                this.addUser(turn.content);
            } else {
                const answer = this.addAssistant();
                answer.bubble.text = turn.content;
                this.render(answer.bubble);
            }
        }
        if (this.session.events.length) {
            this.addNote(journalText(this.session.events));
            for (const event of this.session.events.filter(e => e.changes.length).slice(-20)) this.messages.append(this.proposals.historyRow(event));
        }
        if (this.session.work) {
            const list = new WorkList();
            list.update(this.session.work, false);
            this.messages.append(list.widget);
            if (this.session.work.status !== 'complete') {
                const resume = new Gtk.Button({ label: _('Resume work'), halign: Gtk.Align.START });
                resume.connect('clicked', () => { resume.set_sensitive(false); void this.ask('Resume the saved work. Read the actual contents, check the journal, and do not repeat changes that were already applied.'); });
                this.messages.append(resume);
            }
        }
        this.stick = true;
        this.updateContextSummary();
        return true;
    }

    // ---------- Context ----------

    // Builds the context for the text being typed, without sending anything.
    previewContext(): BuiltContext {
        return this.controller.preview(this.input.buffer.text);
    }

    // Building the context touches the whole project, so the summary is only updated while the panel is visible
    // and after typing pauses for a moment.
    queueContextSummary(): void {
        if (this.summaryTimer || this.busy || !this.widget.get_mapped()) return;
        this.summaryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 400, () => {
            this.summaryTimer = 0;
            this.updateContextSummary();
            return GLib.SOURCE_REMOVE;
        });
    }

    updateContextSummary(): void {
        if (this.busy) return;
        this.contextPart.setSummary(this.previewContext());
    }

    // ---------- Messages ----------

    private buildEmptyState(): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8 });
        const intro = new Gtk.Label({
            label: _('Ask or request help with anything about your work. The assistant reads the open document and relevant excerpts from other files in the folder.'),
            xalign: 0, wrap: true, max_width_chars: 38,
        });
        intro.add_css_class('side-meta');
        box.append(intro);
        for (const text of SUGGESTIONS) {
            const button = new Gtk.Button({ label: text, halign: Gtk.Align.START });
            (button.get_child() as Gtk.Label).set_wrap(true);
            (button.get_child() as Gtk.Label).set_xalign(0);
            (button.get_child() as Gtk.Label).set_max_width_chars(34);
            button.connect('clicked', () => { this.input.buffer.set_text(text, -1); this.input.grab_focus(); });
            box.append(button);
        }
        return box;
    }

    private bubble(markdown: boolean, cls: string): Bubble {
        const label = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, wrap_mode: 2, selectable: true, max_width_chars: 40, use_markup: true });
        label.add_css_class(cls);
        const bubble = { label, text: '', markdown };
        this.bubbles.push(bubble);
        return bubble;
    }

    private render(b: Bubble): void {
        b.label.set_markup(b.markdown ? chatMarkup(b.text, this.colors) : escapeMarkup(b.text));
    }

    // Consecutive updates while an answer streams in are merged; the markup is re-parsed at most ±15 times per second.
    private queueRender(b: Bubble): void {
        if (this.renderTimer) return;
        this.renderTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 65, () => {
            this.renderTimer = 0;
            this.render(b);
            return GLib.SOURCE_REMOVE;
        });
    }

    private addUser(text: string): void {
        const b = this.bubble(false, 'chat-user');
        b.text = text;
        this.render(b);
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_start: 28 });
        row.add_css_class('chat-user-box');
        row.append(b.label);
        this.messages.append(row);
    }

    // The parts of one answer. question = a live turn (it gets the status card and can be retried); without it, a saved answer.
    private addAssistant(question?: string) {
        const bubble = this.bubble(true, 'chat-assistant');
        const status = new TurnStatus(() => { if (question) void this.ask(question); });
        const work = new WorkList();
        work.widget.hide();
        // Proposal cards of agent changes: between the status and the answer, in the order they happened.
        const cards = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, visible: false });
        const actions = actionBar({
            text: () => bubble.text,
            insert: this.host.insertText ? text => this.host.insertText?.(text) ?? false : undefined,
            retry: () => { if (question) void this.ask(question); },
            log: () => this.showLog(),
        });
        actions.set_visible(false);
        const footer = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true, visible: false, use_markup: true });
        footer.add_css_class('side-meta');
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        row.append(status.widget);
        row.append(work.widget);
        row.append(cards);
        row.append(bubble.label);
        row.append(actions);
        row.append(footer);
        footer.hide();
        this.messages.append(row);
        if (question) status.begin();
        return { bubble, status, work, cards, actions, footer };
    }

    // Change proposal: a card in the panel and the review window (see ProposalCards).
    review(change: Change | Change[], apply: (change: Change | Change[]) => string | null, cancelled: Cancellable): Promise<ProposalResult> {
        const { widget, start } = this.proposals.card(change, apply, cancelled);
        this.empty.hide();
        (this.cardsBox ?? this.messages).append(widget);
        this.cardsBox?.show();
        this.stick = true;
        return start();
    }

    private addNote(text: string, error = false, cssClass = 'side-meta'): void {
        const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        l.add_css_class(error ? 'chat-error' : cssClass);
        l.show();
        this.empty.hide();
        this.messages.append(l);
    }

    // Enter sends; Shift+Enter is a new line.
    onInputKey(keyval: number, state: number): boolean {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || state & Gdk.ModifierType.SHIFT_MASK) return false;
        if (!this.busy) void this.send();
        return true;
    }
}
