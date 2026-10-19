import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMANDS } from '../../src/app/commands.js';
import { label } from './keys.js';
import { useClient, useStore } from './useClient.js';

export function Palette() {
    const client = useClient();
    const { palette, tabs, active } = useStore();
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);
    const input = useRef<HTMLInputElement>(null);

    // The commands that have a name and can run now, in the order of the table.
    const commands = useMemo(() => {
        if (!palette) return [];
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        return COMMANDS.filter(c => c.label && c.id !== 'command-palette' && client.enabled(c) && words.every(w => c.label!.toLowerCase().includes(w)));
        // tabs and active decide what is enabled
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [palette, query, tabs, active, client]);

    useEffect(() => { if (palette) { setQuery(''); setIndex(0); input.current?.focus(); } }, [palette]);
    useEffect(() => setIndex(0), [query]);
    if (!palette) return null;

    const close = () => { client.openPalette(false); client.focusEditor(); };
    const choose = (id: string) => { close(); client.run(id); };
    return (
        <div className="palette-backdrop" onMouseDown={close}>
            <div className="palette" role="dialog" aria-label="Command Palette" onMouseDown={e => e.stopPropagation()}>
                <input
                    ref={input} value={query} placeholder="Type the name of a command" aria-label="Command"
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Escape') close();
                        else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(i + 1, commands.length - 1)); }
                        else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(i - 1, 0)); }
                        else if (e.key === 'Enter' && commands[index]) choose(commands[index].id);
                    }}
                />
                <ul role="listbox">
                    {commands.map((c, i) => (
                        <li key={c.id} role="option" aria-selected={i === index} className={i === index ? 'selected' : ''} onMouseMove={() => setIndex(i)} onClick={() => choose(c.id)}>
                            <span>{c.label}</span>
                            {c.keys[0] && <kbd>{label(c.keys[0])}</kbd>}
                        </li>
                    ))}
                    {commands.length === 0 && <li className="none">No matching commands</li>}
                </ul>
            </div>
        </div>
    );
}
