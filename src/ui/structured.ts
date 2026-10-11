// What the calendar, timeline, gallery, and chart views have in common with the table: they show the same model as a
// board or a list (markdown/kanban.ts), keep it, and write every change back through commit() → onChange, so the
// Markdown text stays the single source of truth. A view only has to draw (render()) and call commit().

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import { boardSchema, updateCard, type Board, type Position } from '../markdown/kanban.js';
import { captureItem } from '../markdown/inbox.js';
import { readItem, type FieldDef } from '../markdown/fields.js';
import type { WikiLink } from '../markdown/wikilink.js';
import type { Palette } from '../colors.js';
import type { MarkupColors } from '../markdown/pango.js';
import { editNoteDialog, type CardDraft } from './dialogs.js';
import { after, type Awaitable } from '../gtkutil.js';
import { _ } from '../i18n.js';

// What the window needs from a view of a document: the model in, the changes out.
export interface StructuredView {
    readonly widget: Gtk.Widget;
    onChange: (board: Board) => void;
    onOpenNote: (link: WikiLink) => void;
    listNotes: (() => string[]) | null;
    setBoard(board: Board): void;
    getBoard(): Board;
    commit(board: Board): void;
    setPalette(palette: Palette): void;
}

export interface NoteDialogs {
    editNote(parent: Gtk.Window | null, item: CardDraft, title?: string, listNotes?: () => string[], schema?: FieldDef[]): Awaitable<CardDraft | null>;
}

// A date "YYYY-MM-DD" in the format of GLib.DateTime ("%B %Y", "%a", "%e %b").
export function formatDate(date: string, pattern: string): string {
    const [y, m, d] = date.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 0, 0, 0)?.format(pattern) ?? date;
}

export abstract class LayoutView implements StructuredView {
    abstract readonly widget: Gtk.Widget;
    onChange: (board: Board) => void = () => {};
    dialogs: NoteDialogs = { editNote: editNoteDialog };
    now: () => Date = () => new Date();
    today: () => string = () => GLib.DateTime.new_now_local().format('%Y-%m-%d') ?? '';
    onOpenNote: (link: WikiLink) => void = () => {};
    listNotes: (() => string[]) | null = null;

    protected board: Board = { head: [], columns: [], footer: [] };
    protected colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    protected dragFrom: Position | null = null;
    private renderQueued = false;
    private readonly heading: { title: Gtk.Label; description: Gtk.Label };

    constructor(private readonly fallbackTitle: string) {
        const title = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true });
        title.add_css_class('title-1');
        const description = new Gtk.Label({ xalign: 0, wrap: true, visible: false });
        description.add_css_class('dim-label');
        this.heading = { title, description };
    }

    // ---------- Model ----------

    getBoard(): Board {
        return this.board;
    }

    // Replace the contents (document opened or undo) without calling onChange.
    setBoard(board: Board): void {
        if (board.head.join('\n') !== this.board.head.join('\n')) this.headChanged();
        this.board = board;
        this.schemaKey = null;
        this.render();
    }

    // The head (frontmatter and title) is different: forget what the view chose by itself (a zoom, a month).
    protected headChanged(): void {}

    commit(next: Board): void {
        if (next === this.board) return;
        this.board = next;
        this.schemaKey = null;
        this.queueRender();
        this.onChange(next);
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        this.render();
    }

    // The fields of the document (what its frontmatter declares), read again only when the board changes.
    private schemaKey: string | null = null;
    private schemaCache: FieldDef[] = [];
    schema(): FieldDef[] {
        if (this.schemaKey === null || this.schemaKey !== this.board.head.join('\n')) {
            this.schemaKey = this.board.head.join('\n');
            this.schemaCache = boardSchema(this.board);
        }
        return this.schemaCache;
    }

    protected get parent(): Gtk.Window | null {
        const top = this.widget.get_root();
        return top instanceof Gtk.Window ? top : null;
    }

    abstract render(): void;

    // Deferred to idle: the change comes from a click or a drag on a widget that is about to be destroyed.
    queueRender(): void {
        if (this.renderQueued) return;
        this.renderQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.renderQueued = false;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Heading ----------

    // The title and the description of the page: the first `#` heading after the frontmatter and the text under it.
    protected headerBox(...actions: Gtk.Widget[]): Gtk.Box {
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
        titles.append(this.heading.title);
        titles.append(this.heading.description);
        const header = new Gtk.Box({ spacing: 12 });
        header.append(titles);
        for (const action of actions) header.append(action);
        return header;
    }

    protected updateHeading(): void {
        const lines = [...this.board.head];
        if (lines[0]?.trim() === '---') {
            const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
            lines.splice(0, close < 0 ? lines.length : close + 1);
        }
        const at = lines.findIndex(l => /^#\s+\S/.test(l));
        const rest = (at >= 0 ? lines.slice(at + 1) : lines).map(l => l.trim()).filter(Boolean).join(' ');
        this.heading.title.set_label(at >= 0 ? lines[at].replace(/^#\s+/, '').trim() : this.fallbackTitle);
        this.heading.description.set_label(rest);
        this.heading.description.set_visible(!!rest);
    }

    protected newNoteButton(run: () => void): Gtk.Button {
        const add = new Gtk.Button({ icon_name: 'list-add-symbolic', label: _('New Note'), valign: Gtk.Align.START });
        add.set_tooltip_text(_('Add a note with a title, fields, and notes'));
        add.connect('clicked', run);
        return add;
    }

    // ---------- Notes ----------

    protected cardAt(at: Position) {
        return this.board.columns[at.column]?.cards[at.index];
    }

    protected titleOf(at: Position): string {
        const card = this.cardAt(at);
        return card ? readItem(card.text, this.schema()).title : '';
    }

    // A new note through the dialog; `prepare` can put something in the text first (a date, for example).
    showAddNote(prepare: (text: string) => string = text => text, text = ''): void {
        void after(this.dialogs.editNote(this.parent, { text, notes: [] }, _('New Note'), this.listNotes ?? undefined, this.schema()), draft => {
            if (draft?.text) this.commit(captureItem(this.board, prepare(draft.text), this.now(), draft.notes));
        });
    }

    editItem(at: Position): void {
        const item = this.cardAt(at);
        if (!item) return;
        void after(this.dialogs.editNote(this.parent, { text: item.text, notes: item.notes }, undefined, this.listNotes ?? undefined, this.schema()), result => {
            // The document can change while the dialog is open; the same note is found again through its position.
            if (result?.text && this.cardAt(at)?.text === item.text) this.commit(updateCard(this.board, at, { text: result.text, notes: result.notes }));
        });
    }

    // ---------- Drag and drop: a note onto a day, a bar, or a place ----------

    // A note can be dragged by `widget`.
    protected attachDrag(widget: Gtk.Widget, at: Position): void {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', () => {
            this.dragFrom = at;
            // The icon of a note; a widget as the drag icon triggers a Gtk-CRITICAL when the drag ends in GTK 4.14.
            const icon = Gtk.IconTheme.get_for_display(widget.get_display()).lookup_icon('text-x-generic-symbolic', null, 32,
                widget.get_scale_factor(), Gtk.TextDirection.NONE, 0 as Gtk.IconLookupFlags);
            source.set_icon(icon, 0, 0);
            return Gdk.ContentProvider.new_for_value(`${at.column}.${at.index}`);
        });
        source.connect('drag-end', () => { this.dragFrom = null; });
        widget.add_controller(source);
    }

    // `widget` accepts a dragged note: `drop` gets its position and returns whether it did something. `hover` is told
    // when a note is over the widget and when it leaves.
    protected acceptDrop(widget: Gtk.Widget, drop: (at: Position) => boolean, hover: (over: boolean) => void = () => {}): void {
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
        target.set_gtypes([GObject.TYPE_STRING]);
        target.connect('enter', () => {
            hover(this.dragFrom !== null);
            return this.dragFrom ? Gdk.DragAction.MOVE : 0 as Gdk.DragAction;
        });
        target.connect('motion', () => this.dragFrom ? Gdk.DragAction.MOVE : 0 as Gdk.DragAction);
        target.connect('leave', () => hover(false));
        target.connect('drop', () => {
            hover(false);
            const from = this.dragFrom;
            return from !== null && drop(from);
        });
        widget.add_controller(target);
    }

    protected chip(text: string, ...classes: string[]): Gtk.Label {
        const chip = new Gtk.Label({ label: text, valign: Gtk.Align.CENTER });
        for (const cls of ['inbox-field', ...classes]) if (cls) chip.add_css_class(cls);
        return chip;
    }
}
