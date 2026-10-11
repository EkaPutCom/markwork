// The view of `layout: gallery` documents (markdown/gallery.ts): a card with a cover for every note.
//
//   Design references                         [Search…]  (Small | Medium | Large)  [+ New Note]
//   ┌────────┐ ┌────────┐ ┌────────┐
//   │ cover  │ │ cover  │ │ cover  │
//   │ Title  │ │ Title  │ │ Title  │
//   │ #tag   │ │ #tag   │ │ #tag   │
//
// A click on a card edits the note, the ✕ on its cover deletes it. The search entry hides the cards that do not match.
// A cover image path is read relative to the folder of the document (`baseDir`). Every change goes through commit().

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { CARD_WIDTH, GALLERY_SIZES, galleryCards, gallerySize, type GalleryCard, type GallerySize } from '../markdown/gallery.js';
import { displayValue, readItem } from '../markdown/fields.js';
import { onChipClick, removeChildren } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';
import { LayoutView } from './structured.js';

const SIZE_LABEL: Record<GallerySize, string> = { small: 'Small', medium: 'Medium', large: 'Large' };

export class GalleryView extends LayoutView {
    readonly widget: Gtk.ScrolledWindow;
    // The folder of the open document, for cover images with a relative path (filled in by the window).
    baseDir: () => string | null = () => null;
    private sizeOverride: GallerySize | null = null;
    private query = '';
    private readonly flow: Gtk.FlowBox;
    private readonly empty: Gtk.Label;
    private readonly sizeButtons = new Map<GallerySize, Gtk.ToggleButton>();
    private syncing = false;
    private shown = new Map<Gtk.FlowBoxChild, string>();   // the text each card is searched by

    constructor() {
        super(_('Gallery'));
        const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        page.append(this.headerBox(this.newNoteButton(() => this.showAddNote())));

        const search = new Gtk.SearchEntry({ placeholder_text: _('Search notes…'), hexpand: true });
        search.update_property([Gtk.AccessibleProperty.LABEL], [_('Search the notes of the gallery')]);
        search.connect('search-changed', () => { this.query = search.text.trim().toLowerCase(); this.flow.invalidate_filter(); });
        const sizes = new Gtk.Box({ spacing: 0 });
        sizes.add_css_class('linked');
        let first: Gtk.ToggleButton | null = null;
        for (const size of GALLERY_SIZES) {
            const button = new Gtk.ToggleButton({ label: _(SIZE_LABEL[size]) });
            if (first) button.set_group(first); else first = button;
            button.connect('toggled', () => { if (button.active && !this.syncing) { this.sizeOverride = size; this.render(); } });
            this.sizeButtons.set(size, button);
            sizes.append(button);
        }
        const bar = new Gtk.Box({ spacing: 8 });
        bar.append(search);
        bar.append(sizes);
        page.append(bar);

        this.flow = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, column_spacing: 12, row_spacing: 12, valign: Gtk.Align.START, max_children_per_line: 30, min_children_per_line: 1 });
        this.flow.set_filter_func(child => !this.query || (this.shown.get(child) ?? '').includes(this.query));
        page.append(this.flow);
        this.empty = new Gtk.Label({ label: _('The gallery is empty. Add a note to get the first card.'), xalign: 0 });
        this.empty.add_css_class('dim-label');
        page.append(this.empty);
        this.widget = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true, child: page });
        this.widget.add_css_class('gallery-view');
    }

    protected override headChanged(): void {
        this.sizeOverride = null;
    }

    private size(): GallerySize {
        return this.sizeOverride ?? gallerySize(this.board);
    }

    render(): void {
        this.updateHeading();
        const size = this.size();
        this.syncing = true;
        this.sizeButtons.get(size)?.set_active(true);
        this.syncing = false;
        removeChildren(this.flow);
        this.shown = new Map();
        const cards = galleryCards(this.board, this.schema());
        this.empty.set_visible(cards.length === 0);
        for (const card of cards) {
            const child = new Gtk.FlowBoxChild({ child: this.card(card, CARD_WIDTH[size]), focusable: false, halign: Gtk.Align.START });
            this.shown.set(child, `${card.title} ${card.snippet} ${card.tags.join(' ')}`.toLowerCase());
            this.flow.append(child);
        }
    }

    private card(card: GalleryCard, width: number): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: width, valign: Gtk.Align.START });
        box.add_css_class('card');
        box.add_css_class('gallery-card');
        box.set_overflow(Gtk.Overflow.HIDDEN);
        const cover = new Gtk.Overlay({ child: this.cover(card, width) });
        const remove = new Gtk.Button({ icon_name: 'window-close-symbolic', halign: Gtk.Align.END, valign: Gtk.Align.START, margin_top: 4, margin_end: 4, tooltip_text: _('Delete note') });
        remove.add_css_class('circular');
        remove.add_css_class('osd');
        remove.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Delete note: {title}'), { title: card.title })]);
        remove.connect('clicked', () => this.deleteNoteConfirm(card.at));
        cover.add_overlay(remove);
        box.append(cover);

        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 8, margin_bottom: 10, margin_start: 10, margin_end: 10 });
        const title = new Gtk.Label({ label: card.title, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: Pango.EllipsizeMode.END });
        title.add_css_class('heading');
        text.append(title);
        if (card.snippet) {
            const snippet = new Gtk.Label({ label: card.snippet, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 2, ellipsize: Pango.EllipsizeMode.END });
            snippet.add_css_class('dim-label');
            snippet.add_css_class('caption');
            text.append(snippet);
        }
        text.append(this.chips(card));
        box.append(text);
        onChipClick(text, () => this.editItem(card.at));
        onChipClick(cover, () => this.editItem(card.at));
        box.set_tooltip_text(_('Click to edit'));
        return box;
    }

    // The cover: the image if it can be read, else a block of color (or an empty one for a note without a tag).
    private cover(card: GalleryCard, width: number): Gtk.Widget {
        const height = Math.round(width * 0.45);
        const block = new Gtk.Box({ width_request: width, height_request: height });
        block.add_css_class('gallery-cover');
        block.add_css_class(card.cover.kind === 'color' ? `gallery-cover-${card.cover.index}` : card.cover.kind === 'image' ? 'gallery-cover-missing' : 'gallery-cover-none');
        if (card.cover.kind !== 'image') return block;
        const path = card.cover.path.startsWith('/') ? card.cover.path : GLib.build_filenamev([this.baseDir() ?? '', card.cover.path]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return block;
        // The picture lies over the block, which gives the size: a picture's own size must not widen the card.
        const picture = Gtk.Picture.new_for_filename(path);
        picture.set_content_fit(Gtk.ContentFit.COVER);
        picture.set_can_shrink(true);
        picture.add_css_class('gallery-cover-image');
        picture.update_property([Gtk.AccessibleProperty.LABEL], [card.title]);
        const overlay = new Gtk.Overlay({ child: block });
        overlay.add_overlay(picture);
        overlay.set_overflow(Gtk.Overflow.HIDDEN);
        return overlay;
    }

    // The tags and the fields that have a value, as chips.
    private chips(card: GalleryCard): Gtk.Widget {
        const flow = new Gtk.Box({ spacing: 4, halign: Gtk.Align.START });
        const wrap = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 4, row_spacing: 4, max_children_per_line: 6, can_target: false, focusable: false });
        const add = (label: Gtk.Widget) => wrap.append(new Gtk.FlowBoxChild({ child: label, focusable: false }));
        for (const tag of card.tags) {
            const chip = new Gtk.Label({ label: `#${tag}` });
            chip.add_css_class('inbox-tag');
            add(chip);
        }
        const item = readItem(card.card.text, this.schema());
        for (const def of this.schema()) {
            const parsed = item.fields[def.key];
            if (def.key === 'cover' || !parsed?.ok) continue;
            const text = displayValue(def, parsed.value);
            const color = def.type === 'select' && !Array.isArray(parsed.value) ? def.colors?.[String(parsed.value)] : undefined;
            add(this.chip(def.type === 'select' || def.type === 'progress' ? text : `${def.key}: ${text}`, color ? `opt-${color}` : ''));
        }
        flow.append(wrap);
        return flow;
    }
}
