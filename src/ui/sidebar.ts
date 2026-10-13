// Left sidebar: a rail of icons (Files, Search, Outline, History, Pull requests) that picks the panel beside it.
// The sidebar itself does not know the contents of its panels; they are supplied by the window.
// Wrapped in Adw.OverlaySplitView: a fixed-width sidebar on the left, the rest for content.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { pack } from '../gtkutil.js';
import { _ } from '../i18n.js';

export type SidebarPage = 'files' | 'search' | 'outline' | 'history' | 'collab';

const WIDTH = 300;               // rail (40) + panel

export class Sidebar {
    readonly widget: Adw.OverlaySplitView;
    readonly panel: Gtk.Box;
    readonly stack: Gtk.Stack;
    readonly railButtons = new Map<SidebarPage, Gtk.ToggleButton>();
    onPageChanged: (page: SidebarPage) => void = () => {};

    constructor(files: Gtk.Widget, search: Gtk.Widget, outline: Gtk.Widget, history: Gtk.Widget, collab: Gtk.Widget) {
        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 100, vexpand: true, hexpand: true });
        const pages: [SidebarPage, Gtk.Widget, string, string][] = [
            ['files', files, 'folder-symbolic', _('Files')],
            ['search', search, 'system-search-symbolic', _('Search')],
            ['outline', outline, 'view-list-symbolic', _('Outline')],
            ['history', history, 'document-open-recent-symbolic', _('History')],
            ['collab', collab, 'network-workgroup-symbolic', _('Pull requests')],
        ];
        const rail = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 8, margin_start: 4, margin_end: 4 });
        rail.add_css_class('sidebar-rail');
        let first: Gtk.ToggleButton | null = null;
        for (const [page, widget, icon, tooltip] of pages) {
            this.stack.add_named(widget, page);
            const button = new Gtk.ToggleButton({ icon_name: icon, tooltip_text: tooltip });
            button.add_css_class('flat');
            if (first) button.set_group(first); else first = button;
            button.connect('toggled', () => { if (button.active) this.setPage(page); });
            this.railButtons.set(page, button);
            rail.append(button);
        }
        this.stack.connect('notify::visible-child-name', () => {
            this.syncRail();
            this.onPageChanged(this.page);
        });

        this.panel = new Gtk.Box();
        this.panel.add_css_class('sidebar');
        this.panel.hexpand = false;   // the split view sets the width; the contents must not ask for more
        this.panel.append(rail);
        this.panel.append(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }));
        pack(this.panel, this.stack, true);

        // Fixed width: the sidebar contents (title, entry fields) must not make it expand.
        this.widget = new Adw.OverlaySplitView({
            sidebar: this.panel, min_sidebar_width: WIDTH, max_sidebar_width: WIDTH,
            enable_show_gesture: false, enable_hide_gesture: false,
        });
        this.syncRail();
    }

    private syncRail(): void {
        const button = this.railButtons.get(this.page);
        if (button && !button.active) button.active = true;
    }

    setContent(content: Gtk.Widget): void {
        this.widget.set_content(content);
    }

    get page(): SidebarPage {
        return (this.stack.visible_child_name ?? 'files') as SidebarPage;
    }

    setPage(page: SidebarPage): void {
        this.stack.visible_child_name = page;
    }

    get visible(): boolean {
        return this.widget.show_sidebar;
    }

    setVisible(visible: boolean): void {
        this.widget.set_show_sidebar(visible);
    }
}
