import { useEffect, useMemo, useState } from 'react';
import { COMMANDS } from '../../../src/app/commands.js';
import { label } from '../lib/keys.js';
import { useClient, useStore } from '../lib/useClient.js';
import { CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/ui/command';
import { Kbd } from '@/ui/kbd';

// The command palette (Ctrl+Shift+P): shadcn's Command in a dialog. It filters by its own rule (every word in the
// name, only what can run now), so cmdk's own filter is off and the first match is chosen whenever the query changes.
export function Palette() {
    const client = useClient();
    const { palette, tabs, active } = useStore();
    const [query, setQuery] = useState('');
    const [chosen, setChosen] = useState('');

    // The commands that have a name and can run now, in the order of the table.
    const commands = useMemo(() => {
        if (!palette) return [];
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        return COMMANDS.filter(c => c.label && c.id !== 'command-palette' && client.enabled(c) && words.every(w => c.label!.toLowerCase().includes(w)));
        // tabs and active decide what is enabled
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [palette, query, tabs, active, client]);

    // The query is emptied when the palette closes, not after it opens: an effect after opening would wipe what was typed
    // in the first moment (and Enter would then run the first command of the whole list).
    useEffect(() => { if (!palette) setQuery(''); }, [palette]);
    useEffect(() => setChosen(commands[0]?.id ?? ''), [commands]);

    const close = () => { client.openPalette(false); client.focusEditor(); };
    // cmdk takes the Enter (preventDefault), so the editor that has the focus right after does not type a new line.
    const choose = (id: string) => { close(); client.run(id); };
    return (
        <CommandDialog open={palette} onOpenChange={open => { if (!open) close(); }}
            commandProps={{ shouldFilter: false, value: chosen, onValueChange: setChosen }}
            title="Command Palette" description="Type a command or search, then Enter to run it"
            // The editor takes the focus back (close), not the element that had it before the palette.
            contentProps={{ className: 'palette top-[14vh] translate-y-0 sm:max-w-[560px]', onCloseAutoFocus: e => e.preventDefault() }}>
            <CommandInput value={query} onValueChange={setQuery} placeholder="Type a command or search…" aria-label="Command">
                <Kbd>Esc</Kbd>
            </CommandInput>
            <CommandList className="max-h-[340px]">
                <CommandEmpty>No matching commands</CommandEmpty>
                {commands.map(c => (
                    <CommandItem key={c.id} value={c.id} onSelect={choose} className="h-9">
                        <span>{c.label}</span>
                        {c.keys[0] && <CommandShortcut><Kbd>{label(c.keys[0])}</Kbd></CommandShortcut>}
                    </CommandItem>
                ))}
            </CommandList>
            <div className="flex h-9 items-center gap-4 border-t bg-muted/50 px-3 text-xs text-muted-foreground" aria-hidden="true"><span>↑↓ to move</span><span>↵ to run</span></div>
        </CommandDialog>
    );
}
