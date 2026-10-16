// Menus as data: what a card or a file offers, independent of how a frontend shows it (a Gtk.PopoverMenu under GTK,
// see ui/menu.ts). Tests find an entry by label and call run().

// One menu item. An empty label = a section separator; submenu = an item containing a child menu.
export interface MenuEntry {
    label: string;
    enabled?: boolean;   // default true
    run?: () => void;
    submenu?: MenuEntry[];
}

export const separator = (): MenuEntry => ({ label: '' });

// Find an entry by label (also inside submenus).
export function findEntry(entries: MenuEntry[], label: string): MenuEntry | undefined {
    for (const entry of entries) {
        if (entry.label === label) return entry;
        const inner = entry.submenu && findEntry(entry.submenu, label);
        if (inner) return inner;
    }
    return undefined;
}
