// The language of a code block in the visual editor, picked from the languages the code colors know
// (@codemirror/language-data), found by typing a name or a short name (js, py). A word that is not in the list can be
// used as it is. Opened by the button over the box (lib/codecolor.ts).

import { useState } from 'react';
import { languages } from '@codemirror/language-data';
import { Command, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover';
import { fenceName, type LanguagePick } from '../lib/codecolor';
import { Icon } from './Icons';
import { Anchor } from './notes';

const CHOICES = [
    { value: '', label: 'Plain text', keywords: ['text', 'none'] },
    ...[...languages].sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ value: fenceName(l), label: l.name, keywords: [...l.alias, ...l.extensions] })),
];

export function LanguagePicker({ pick, onClose }: { pick: LanguagePick; onClose: () => void }) {
    const [query, setQuery] = useState('');
    const current = pick.current.trim().split(/[\s{]/)[0].toLowerCase();
    const typed = query.trim().toLowerCase().replace(/\s+/g, '-');
    // A word no language matches can be used as it is; while one matches, Enter takes that one.
    const matches = CHOICES.some(c => [c.label.toLowerCase(), ...c.keywords].some(w => w.includes(typed)));
    const choose = (lang: string) => { onClose(); pick.choose(lang); };
    return (
        <Popover open onOpenChange={open => { if (!open) onClose(); }}>
            <PopoverAnchor asChild><Anchor at={{ x: pick.at.left, y: pick.at.top + pick.at.height }} /></PopoverAnchor>
            <PopoverContent align="start" className="w-64 p-0" aria-label="Language" onCloseAutoFocus={e => e.preventDefault()}>
                <Command>
                    <CommandInput value={query} onValueChange={setQuery} placeholder="Search languages…" aria-label="Language" />
                    <CommandList>
                        {CHOICES.map(c => (
                            <CommandItem key={c.label} value={c.label} keywords={c.keywords} onSelect={() => choose(c.value)}>
                                {c.label}
                                {c.value === current && <Icon name="emblem-ok" size={14} className="ml-auto" />}
                            </CommandItem>
                        ))}
                        {typed && !matches && <CommandItem forceMount value={`use ${typed}`} onSelect={() => choose(typed)}>Use “{typed}”</CommandItem>}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
