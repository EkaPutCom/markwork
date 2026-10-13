// Colors, fonts, and CSS of the app for light and dark mode.
// The editor text tag colors are set separately in editor/tags.ts (paintTags).

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { FONT_MONO, FONT_TEXT } from '../config.js';
import { PALETTES, type Palette } from '../colors.js';
import { OPTION_COLORS, type OptionColor } from '../markdown/fields.js';

// The dark/light choice from the system settings (GNOME: Dark Style), before the app forces one of them.
export const systemPrefersDark = (): boolean => Adw.StyleManager.get_default().dark;

// Document surface colors (editor, tables, text tags) still come from the palette because GtkTextTag and diagram
// rendering need real color values, and the `hidden` tag must be exactly the same as the editor background. The rest
// (sidebar, assistant panel, board, status bar, status colors) use named Adwaita colors, so they
// follow the system accent and high contrast mode without extra CSS.
// The colors of the options of a select, by name: [background, text] of a chip in light and in dark mode. The dot that
// picks a color uses the text color.
const OPTION_CHIP: Record<'light' | 'dark', Record<OptionColor, [string, string]>> = {
    light: {
        red: ['#f8dad8', '#a1241e'], amber: ['#f8e7c8', '#8a5200'], green: ['#d8f0e1', '#176b3b'], blue: ['#dce8fb', '#1f58b8'],
        purple: ['#e6dff7', '#5a3fa8'], teal: ['#d3efee', '#14706f'], pink: ['#f8dbe9', '#a3225f'], gray: ['#e6e6e2', '#4c525b'],
    },
    dark: {
        red: ['#4d2523', '#f4a29c'], amber: ['#473819', '#e8bd6a'], green: ['#1f3d2c', '#7fd6a0'], blue: ['#25395c', '#8db6f7'],
        purple: ['#392f5c', '#bfb0f2'], teal: ['#1d4140', '#7fd4d1'], pink: ['#4d2338', '#f2a3c8'], gray: ['#3a3d42', '#b4b9c2'],
    },
};

// `.opt-red` colors a chip and `.opt-dot-red` a color button, for every name; listed last so they win over the base chip.
const optionCss = (dark: boolean): string => OPTION_COLORS.map(name => {
    const [bg, fg] = OPTION_CHIP[dark ? 'dark' : 'light'][name];
    return `.opt-${name} { background-color: ${bg}; color: ${fg}; } .opt-dot-${name} { background-color: ${fg}; }`;
}).join('\n    ');

const buildCss = (p: Palette): string => `
    .editor, .editor text { background-color: ${p.bg}; color: ${p.fg}; }
    .editor { font-family: ${FONT_TEXT}; font-size: 16px; caret-color: ${p.accent}; }
    .editor text selection { background-color: ${p.sel}; color: ${p.fg}; }
    .sidebar { background-color: @sidebar_bg_color; color: @sidebar_fg_color; }
    .side-title { font-size: 11px; font-weight: bold; letter-spacing: 1px; color: alpha(currentColor, 0.55); }
    .side-drop { background-color: alpha(@accent_bg_color, 0.25); }
    .sidebar-tabs button { padding: 3px 6px; min-width: 0; font-size: 12px; }
    .side-meta { font-size: 11px; color: alpha(currentColor, 0.55); }
    .pull-avatar { border-radius: 50%; color: white; font-weight: bold; font-size: 14px; }
    .pull-avatar-0 { background-color: @blue_4; } .pull-avatar-1 { background-color: @green_5; } .pull-avatar-2 { background-color: @orange_5; }
    .pull-avatar-3 { background-color: @purple_4; } .pull-avatar-4 { background-color: @red_4; } .pull-avatar-5 { background-color: @brown_4; }
    .pull-description { background-color: alpha(@accent_bg_color, 0.08); border-radius: 12px; }
    .chat-input, .chat-input text { background-color: @view_bg_color; color: @view_fg_color; font-size: 13px; }
    .chat-composer { background-color: @view_bg_color; border: 1px solid alpha(currentColor, 0.15); border-radius: 12px; }
    .chat-composer:focus-within { outline: 2px solid alpha(@accent_color, 0.5); outline-offset: -1px; }
    .chat-user { background-color: alpha(@accent_bg_color, 0.16); border-radius: 10px; padding: 8px 10px; font-size: 13px; }
    .chat-assistant { font-size: 13px; }
    .chat-thinking { color: alpha(currentColor, 0.55); font-size: 12px; font-style: italic; }
    /* A popover uses the GTK theme background, not the sidebar background: the sidebar's dim color becomes unreadable there. */
    .chat-pop label { color: @popover_fg_color; }
    .chat-pop label.side-title, .chat-pop label.side-meta { opacity: 0.7; }
    .chat-work { font-size: 13px; }
    .chat-work-goal { font-weight: bold; }
    .work-done { background-color: @success_bg_color; color: @success_fg_color; border-radius: 50%; min-width: 16px; min-height: 16px; }
    .work-pending { border: 1.5px solid alpha(currentColor, 0.45); border-radius: 50%; min-width: 13px; min-height: 13px; margin: 1px; }
    .work-blocked { color: @warning_color; }
    .work-step-done { color: alpha(currentColor, 0.7); }
    .chat-status { background-color: alpha(currentColor, 0.06); border-radius: 10px; }
    .chat-status.stopped { background-color: alpha(@warning_color, 0.18); }
    .chat-status.failed { background-color: alpha(@error_color, 0.14); }
    .chat-status-head { font-size: 12px; padding: 4px 10px; min-height: 0; }
    .chat-status .done-icon { color: @success_color; }
    .chat-actions button { font-size: 12px; min-height: 0; padding: 2px 8px; }
    .chat-step { color: alpha(currentColor, 0.55); font-size: 12px; }
    .chat-proposal { background-color: @card_bg_color; color: @card_fg_color; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .chat-diff { font-family: monospace; font-size: 12px; }
    .log-block { background-color: alpha(currentColor, 0.06); border-radius: 6px; padding: 8px; }
    .chat-error { color: @error_color; font-size: 12px; }
    .history-text, .history-text text { background-color: @view_bg_color; color: @view_fg_color; font-size: 13px; }
    .md-table { border-top: 1px solid alpha(${p.fg}, 0.28); border-left: 1px solid alpha(${p.fg}, 0.28); }
    .md-table-cell { border-right: 1px solid alpha(${p.fg}, 0.28); border-bottom: 1px solid alpha(${p.fg}, 0.28); }
    .md-table-cell label { color: ${p.fg}; font-family: ${FONT_TEXT}; font-size: 15px; }
    .md-codeblock { background-color: ${p.codeBg}; border-radius: 6px; }
    .md-codeblock label { color: ${p.fg}; font-family: ${FONT_MONO}; font-size: 14px; }
    .md-table-head { background-color: ${p.codeBg}; }
    scrolledwindow.kanban-board, scrolledwindow.kanban-board viewport.frame, scrolledwindow.kanban-board viewport, .kanban-row { background-color: @window_bg_color; background-image: none; }
    .kanban-row { padding: 16px; }
    .kanban-column { background-color: alpha(@window_fg_color, 0.06); border-radius: 10px; padding: 10px; }
    .kanban-column-title { font-weight: bold; font-size: 14px; color: @window_fg_color; }
    .kanban-count { color: alpha(@window_fg_color, 0.5); font-size: 12px; }
    scrolledwindow.kanban-board .kanban-column scrolledwindow, scrolledwindow.kanban-board .kanban-column scrolledwindow viewport.frame,
    scrolledwindow.kanban-board .kanban-column scrolledwindow viewport, scrolledwindow.kanban-board .kanban-column scrolledwindow viewport box { background-color: transparent; background-image: none; }
    .kanban-card { background-color: @card_bg_color; color: @card_fg_color; border: 1px solid alpha(@card_fg_color, 0.12); border-radius: 8px; padding: 8px 10px; box-shadow: 0 1px 2px @shade_color; }
    .kanban-card:hover { border-color: @accent_color; }
    .kanban-card-text { font-size: 14px; }
    .kanban-card-done .kanban-card-text { color: alpha(currentColor, 0.5); }
    .kanban-placeholder { background-color: alpha(@accent_bg_color, 0.16); border: 2px dashed @accent_color; border-radius: 8px; }
    .kanban-add-list { background-color: alpha(@window_fg_color, 0.05); border-radius: 10px; padding: 6px; }
    list.inbox-list { background-color: transparent; }
    list.inbox-list > row { background-color: @card_bg_color; color: @card_fg_color; border: 1px solid alpha(@card_fg_color, 0.12); border-radius: 10px; margin-bottom: 8px; }
    list.inbox-list > row:hover { border-color: @accent_color; }
    .inbox-field { border-radius: 9px; padding: 1px 8px; font-size: 11px; background-color: alpha(currentColor, 0.12); color: @card_fg_color; }
    .inbox-field-invalid { background-color: alpha(@warning_bg_color, 0.35); border: 1px dashed @warning_bg_color; }
    .inbox-field-0 { background-color: #4c9a6a; color: #ffffff; } .inbox-field-1 { background-color: #3b7dd8; color: #ffffff; }
    .inbox-field-2 { background-color: #8e5bd6; color: #ffffff; } .inbox-field-3 { background-color: #d6602e; color: #ffffff; }
    .inbox-field-4 { background-color: #c2417a; color: #ffffff; } .inbox-field-5 { background-color: #2f8f99; color: #ffffff; }
    .inbox-field-6 { background-color: #8a7a1c; color: #ffffff; } .inbox-field-7 { background-color: #5e6c84; color: #ffffff; }
    list.inbox-list > row.inbox-section { background-color: transparent; border: none; border-bottom: 2px solid alpha(@accent_color, 0.5); border-radius: 0; margin-top: 12px; margin-bottom: 10px; }
    list.inbox-list > row.inbox-section:hover { border-bottom-color: alpha(@accent_color, 0.5); }
    list.inbox-list > row.inbox-section label { color: @accent_color; font-size: 13px; letter-spacing: 0.5px; }
    list.inbox-list > row.inbox-drop-above { box-shadow: 0 -3px 0 0 @accent_color; }
    list.inbox-list > row.inbox-drop-below { box-shadow: 0 3px 0 0 @accent_color; }
    .table-view { background-color: transparent; }
    .table-cell { padding: 7px 12px; border-bottom: 1px solid alpha(currentColor, 0.12); }
    .table-head { border-bottom: 2px solid alpha(currentColor, 0.2); padding-top: 4px; padding-bottom: 4px; }
    .table-head-button { font-size: 11px; font-weight: bold; letter-spacing: 0.5px; padding: 2px 0; min-height: 0; }
    .table-late { color: @error_color; font-weight: bold; }
    .table-grid progressbar trough, .table-grid progressbar progress { min-height: 6px; }
    .calendar-view, .timeline-chart, .gallery-view, .chart-view { background-color: transparent; }
    .calendar-grid { border: 1px solid alpha(currentColor, 0.15); border-radius: 8px; }
    .calendar-weekday { font-size: 11px; font-weight: bold; padding: 6px 0; background-color: alpha(currentColor, 0.06); }
    .calendar-day { padding: 4px; border-top: 1px solid alpha(currentColor, 0.12); border-left: 1px solid alpha(currentColor, 0.12); }
    .calendar-day-other { opacity: 0.55; }
    .calendar-drop { background-color: alpha(@accent_bg_color, 0.25); }
    .calendar-daynum { font-size: 11px; padding: 0 5px; }
    .calendar-today { background-color: @accent_bg_color; color: @accent_fg_color; border-radius: 9px; font-weight: bold; }
    .calendar-today-text { color: @accent_color; }
    .calendar-event, .calendar-note { font-size: 11px; padding: 1px 6px; border-radius: 4px; border-left: 3px solid @accent_bg_color; background-color: alpha(@accent_bg_color, 0.18); }
    .calendar-event-done { border-left-color: @success_color; background-color: alpha(@success_bg_color, 0.3); text-decoration: line-through; }
    .calendar-event-late { border-left-color: @error_color; background-color: alpha(@error_bg_color, 0.3); }
    .calendar-undated { padding: 8px; border-radius: 10px; background-color: alpha(@window_fg_color, 0.06); }
    .calendar-note { border-left-color: alpha(currentColor, 0.4); background-color: @card_bg_color; padding: 4px 8px; }
    .timeline-chart { border: 1px solid alpha(currentColor, 0.15); border-radius: 8px; }
    .timeline-labels { border-right: 1px solid alpha(currentColor, 0.15); }
    .timeline-label { padding: 0 10px; border-top: 1px solid alpha(currentColor, 0.1); }
    .timeline-head { font-size: 11px; font-weight: bold; background-color: alpha(currentColor, 0.06); padding: 0 10px; }
    .timeline-line { background-color: alpha(currentColor, 0.1); }
    .timeline-today { background-color: @error_color; }
    .timeline-bar { border-radius: 6px; background-color: @accent_bg_color; color: @accent_fg_color; }
    .timeline-bar-done { background-color: @success_bg_color; color: @success_fg_color; }
    .timeline-bar-late { background-color: @error_bg_color; color: @error_fg_color; }
    .timeline-bar-title { font-size: 11px; padding: 0 4px; }
    .timeline-handle { background-color: alpha(black, 0.18); border-radius: 6px; }
    .timeline-fill { background-color: alpha(black, 0.28); border-radius: 6px; }
    .gallery-card { padding: 0; }
    .gallery-cover-none, .gallery-cover-missing { background-color: alpha(currentColor, 0.08); }
    .gallery-cover-0 { background-color: #4c9a6a; } .gallery-cover-1 { background-color: #3b7dd8; }
    .gallery-cover-2 { background-color: #8e5bd6; } .gallery-cover-3 { background-color: #d6602e; }
    .gallery-cover-4 { background-color: #c2417a; } .gallery-cover-5 { background-color: #2f8f99; }
    .gallery-cover-6 { background-color: #8a7a1c; } .gallery-cover-7 { background-color: #5e6c84; }
    .chart-panel, .chart-kpi { padding: 12px; }
    .chart-number { font-size: 26px; font-weight: bold; }
    .chart-ok { color: @success_color; } .chart-late { color: @error_color; }
    .chart-bar { background-color: @accent_bg_color; border-radius: 4px; }
    .chart-stack { border-radius: 6px; }
    .chart-segment { padding: 4px 0; font-size: 11px; font-weight: bold; }
    .inbox-tag { border-radius: 9px; padding: 1px 8px; font-size: 11px; background-color: alpha(@accent_bg_color, 0.18); color: @accent_color; }
    .kanban-chip { border-radius: 9px; padding: 0 8px; font-size: 11px; color: #ffffff; background-color: #6b7280; }
    .kanban-notes { background-color: transparent; color: alpha(currentColor, 0.55); padding: 0 2px; }
    .kanban-card-text link, .kanban-note-link link { color: @accent_color; }
    .kanban-note-link { font-size: 12px; }
    .kanban-field { background-color: alpha(currentColor, 0.12); color: @card_fg_color; }
    .kanban-field-invalid { background-color: alpha(@warning_bg_color, 0.35); color: @card_fg_color; border: 1px dashed @warning_bg_color; }
    .kanban-due { background-color: alpha(currentColor, 0.12); color: @card_fg_color; }
    .kanban-due-overdue { background-color: @error_bg_color; color: @error_fg_color; }
    .kanban-due-today { background-color: @warning_bg_color; color: @warning_fg_color; }
    .kanban-due-soon { background-color: alpha(@warning_bg_color, 0.45); color: @card_fg_color; }
    .kanban-tag-0 { background-color: #4c9a6a; } .kanban-tag-1 { background-color: #3b7dd8; }
    .kanban-tag-2 { background-color: #8e5bd6; } .kanban-tag-3 { background-color: #d6602e; }
    .kanban-tag-4 { background-color: #c2417a; } .kanban-tag-5 { background-color: #2f8f99; }
    .kanban-tag-6 { background-color: #8a7a1c; } .kanban-tag-7 { background-color: #5e6c84; }
    .kanban-agent { background-color: alpha(currentColor, 0.10); color: @card_fg_color; font-weight: bold; }
    .kanban-agent-queued { background-color: alpha(@warning_bg_color, 0.25); color: @card_fg_color; }
    .kanban-agent-working { background-color: @success_bg_color; color: @success_fg_color; }
    .kanban-agent-waiting { background-color: @warning_bg_color; color: @warning_fg_color; }
    .kanban-agent-done { background-color: @accent_bg_color; color: @accent_fg_color; }
    .kanban-agent-failed { background-color: @error_bg_color; color: @error_fg_color; }
    .image-viewer, .image-viewer viewport { background-color: #1c1d20; }
    .image-note { color: ${p.faint}; font-style: italic; font-size: 14px; }
    .statusbar { background-color: ${p.bg}; color: alpha(${p.fg}, 0.55); font-size: 12px; padding: 4px 14px; }
    .opt-chip { border-radius: 9px; padding: 1px 8px; font-size: 11px; font-weight: bold; background-color: alpha(currentColor, 0.12); }
    .opt-dot { min-width: 16px; min-height: 16px; padding: 0; border-radius: 8px; border: 2px solid transparent; }
    .opt-dot-auto { background-color: transparent; border: 2px dashed alpha(currentColor, 0.45); }
    .opt-dot-chosen { border-color: @accent_color; }
    ${optionCss(p.dark)}
`;

let provider: Gtk.CssProvider | null = null;

// The user's chosen accent color (libadwaita ≥ 1.6, GNOME 47+) for text tags and the cursor; older libadwaita
// has no API for it, so the default Adwaita accent in the palette is still used.
function withSystemAccent(palette: Palette, style: Adw.StyleManager): Palette {
    const manager = style as Adw.StyleManager & { get_system_supports_accent_colors?(): boolean; get_accent_color_rgba?(): Gdk.RGBA };
    if (!manager.get_system_supports_accent_colors?.() || !manager.get_accent_color_rgba) return palette;
    const rgba = manager.get_accent_color_rgba();
    // The standalone accent (for text) differs from the accent background; in dark mode Adwaita uses a lighter version.
    const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
    const mix = palette.dark ? 0.35 : 0;
    const lift = (v: number) => v + (1 - v) * mix;
    return { ...palette, accent: `#${hex(lift(rgba.red))}${hex(lift(rgba.green))}${hex(lift(rgba.blue))}` };
}

// Install the CSS for the whole app and tell libadwaita which theme is used;
// null = follow the system theme. Returns the palette so the caller can color the editor tags.
export function applyTheme(dark: boolean | null): Palette {
    const style = Adw.StyleManager.get_default();
    style.set_color_scheme(dark === null ? Adw.ColorScheme.DEFAULT : dark ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT);
    const palette = withSystemAccent(PALETTES[style.get_dark() ? 'dark' : 'light'], style);
    if (!provider) {
        provider = new Gtk.CssProvider();
        const display = Gdk.Display.get_default();
        if (display) Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    provider.load_from_string(buildCss(palette));
    return palette;
}
