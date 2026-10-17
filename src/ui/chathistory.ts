// The Assistant panel's history popover: the conversations saved in the work folder, to reopen or move to the Trash.

import Gtk from 'gi://Gtk?version=4.0';
import type { ChatSummary } from '../agent/chatstore.js';
import { after, childrenOf, pack, type Awaitable } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';

export class ChatHistoryList {
    // chats: the saved conversations (null = no work folder); remove: move one to the Trash (an error message, or null);
    // onOpen: reopen a saved conversation; onError: show a failure in the panel.
    constructor(private readonly button: Gtk.MenuButton, popover: Gtk.Popover, private readonly list: Gtk.Box,
                private readonly chats: () => Awaitable<ChatSummary[] | null>, private readonly remove: (path: string) => Awaitable<string | null>,
                private readonly onOpen: (path: string) => void, private readonly onError: (message: string) => void) {
        popover.connect('show', () => this.refresh());
    }

    refresh(): void {
        void after(this.chats(), chats => this.show(chats));
    }

    private show(chats: ChatSummary[] | null): void {
        for (const child of childrenOf(this.list)) this.list.remove(child);
        if (!chats) return this.note('Open a work folder to save and open conversation history.');
        if (!chats.length) return this.note('There are no saved conversations in this folder yet.');
        for (const chat of chats) this.list.append(this.row(chat));
    }

    private note(text: string): void {
        const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 36 });
        l.add_css_class('side-meta');
        l.show();
        this.list.append(l);
    }

    // The title and date open the conversation; the trash button deletes it.
    private row(chat: ChatSummary): Gtk.Box {
        const row = new Gtk.Box({ spacing: 2 });
        const open = new Gtk.Button({ has_frame: false, tooltip_text: fmt(_('{date} · {turns} Q&A'), { date: chat.created.replace('T', ' '), turns: chat.turns / 2 | 0 }) });
        const text = new Gtk.Label({ label: chat.title, xalign: 0, ellipsize: 3, max_width_chars: 30 });
        const date = new Gtk.Label({ label: chat.created.slice(0, 10), xalign: 0 });
        date.add_css_class('side-meta');
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        column.append(text);
        column.append(date);
        open.set_child(column);
        open.connect('clicked', () => {
            this.button.get_popover()?.popdown();
            this.onOpen(chat.path);
        });
        const remove = Gtk.Button.new_from_icon_name('user-trash-symbolic');
        remove.set_has_frame(false);
        remove.set_tooltip_text(_('Move to the Trash'));
        remove.connect('clicked', () => {
            void after(this.remove(chat.path), error => {
                if (error) this.onError(error);
                this.refresh();
            });
        });
        pack(row, open, true);
        row.append(remove);
        return row;
    }
}
