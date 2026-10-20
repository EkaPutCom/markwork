// The window's dialog, drawn as an alert dialog: a heading, the detail, an entry when the core asks for text,
// and a row of buttons. It answers the questions of the core (client.ts): the ones this window knows by name and any
// `Question` or `Prompt` it has no dialog of its own for.

import { useEffect, useRef, useState } from 'react';
import { useClient, useStore } from '../lib/useClient.js';

export function DialogLayer() {
    const client = useClient();
    const { dialog } = useStore();
    const [text, setText] = useState('');
    const entry = useRef<HTMLInputElement>(null);
    const first = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!dialog) return;
        setText(dialog.entry?.value ?? '');
        // The entry, or else the default button, has the focus, so Enter answers and Escape dismisses.
        setTimeout(() => { if (dialog.entry) entry.current?.select(); else first.current?.focus(); });
    }, [dialog]);
    if (!dialog) return null;

    const answer = (value: string | null) => {
        dialog.close(value, text);
        if (!client.getState().dialog) client.focusEditor();
    };
    return (
        <div className="dialog-backdrop" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); answer(null); } }}>
            <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-detail">
                <h2 id="dialog-title">{dialog.title}</h2>
                {dialog.detail && <p id="dialog-detail">{dialog.detail}</p>}
                {dialog.entry && (
                    <label className="entry">
                        <span>{dialog.entry.label}</span>
                        <input
                            ref={entry} value={text} onChange={e => setText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); answer(dialog.buttons[0]?.value ?? null); } }}
                        />
                    </label>
                )}
                <div className="buttons">
                    {dialog.buttons.map((b, i) => (
                        <button key={b.value} ref={i === 0 ? first : undefined} className={`button${b.style ? ` ${b.style}` : ''}`} onClick={() => answer(b.value)}>
                            {b.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
