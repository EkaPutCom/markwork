// Left sidebar with four tabs: Files (folder tree), Outline (heading list), History (git), and Collaboration (pull requests, icon only).
// The sidebar itself does not know the contents of its tabs; both are supplied by the window.
// Wrapped in Adw.OverlaySplitView: a fixed-width sidebar on the left, the rest for content.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '../i18n.js';

export type SidebarPage = 'files' | 'outline' | 'history' | 'collab';

export class Sidebar {
    readonly widget: Adw.OverlaySplitView;
    readonly panel: Gtk.Box;
    readonly stack: Gtk.Stack;
    onPageChanged: (page: SidebarPage) => void = () => {};

    constructor(files: Gtk.Widget, outline: Gtk.Widget, history: Gtk.Widget, collab: Gtk.Widget) {
        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 100, vexpand: true });
        this.stack.add_titled(files, 'files', _('Files'));
        this.stack.add_titled(outline, 'outline', _('Outline'));
        this.stack.add_titled(history, 'history', _('History'));
        // The fourth tab is an icon: four words do not fit 240 px. The title stays for the tooltip and screen readers.
        const collabPage = this.stack.add_titled(collab, 'collab', _('Pull requests'));
        collabPage.set_icon_name('network-workgroup-symbolic');
        this.stack.connect('notify::visible-child-name', () => this.onPageChanged(this.page));

        const switcher = new Gtk.StackSwitcher({ stack: this.stack, halign: Gtk.Align.CENTER, margin_top: 10, margin_bottom: 10, margin_start: 4, margin_end: 4 });
        // The tabs must fit the sidebar width; a button that is too wide raises the window's minimum width.
        switcher.add_css_class('sidebar-tabs');

        this.panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.panel.add_css_class('sidebar');
        this.panel.append(switcher);
        this.panel.append(this.stack);

        // Fixed width of 240: the sidebar contents (title, entry fields) must not make it expand.
        this.widget = new Adw.OverlaySplitView({
            sidebar: this.panel, min_sidebar_width: 240, max_sidebar_width: 240,
            enable_show_gesture: false, enable_hide_gesture: false,
        });
    }

    setContent(content: Gtk.Widget): void {
        this.widget.set_content(content);
    }

    get page(): SidebarPage {
        return this.stack.visible_child_name as SidebarPage;
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
