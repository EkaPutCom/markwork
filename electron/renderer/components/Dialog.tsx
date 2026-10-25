// The window's dialog, an AlertDialog: a heading, the detail, an entry when the core asks for text, and a row of buttons.
// It answers the questions of the core (client.ts): the ones this window knows by name and any `Question` or `Prompt` it
// has no dialog of its own for.

import { useEffect, useRef, useState } from 'react';
import { useClient, useStore } from '../lib/useClient.js';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

const VARIANT = { suggested: 'default', destructive: 'destructive' } as const;

export function DialogLayer() {
    const client = useClient();
    const { dialog } = useStore();
    const [text, setText] = useState('');
    const entry = useRef<HTMLInputElement>(null);
    const first = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!dialog) return;
        setText(dialog.entry?.value ?? '');
        // The entry, or else the default button, has the focus, so Enter answers and Escape dismisses. Done here rather
        // than in onOpenAutoFocus, so a question that follows another one at once gets it too.
        setTimeout(() => { if (dialog.entry) entry.current?.select(); else first.current?.focus(); });
    }, [dialog]);
    if (!dialog) return null;

    const answer = (value: string | null) => {
        dialog.close(value, text);
        if (!client.getState().dialog) client.focusEditor();
    };
    return (
        <AlertDialog open>
            <AlertDialogContent
                onOpenAutoFocus={e => e.preventDefault()}
                onEscapeKeyDown={e => { e.preventDefault(); answer(null); }}
                {...!dialog.detail && { 'aria-describedby': undefined }}
            >
                <AlertDialogHeader>
                    <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
                    {dialog.detail && <AlertDialogDescription className="[overflow-wrap:anywhere]">{dialog.detail}</AlertDialogDescription>}
                </AlertDialogHeader>
                {dialog.entry && (
                    <div className="grid gap-2">
                        <Label htmlFor="dialog-entry">{dialog.entry.label}</Label>
                        <Input
                            id="dialog-entry" ref={entry} value={text} onChange={e => setText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); answer(dialog.buttons[0]?.value ?? null); } }}
                        />
                    </div>
                )}
                <AlertDialogFooter className="flex-col sm:flex-row-reverse sm:justify-start">
                    {dialog.buttons.map((b, i) => (
                        <Button key={b.value} ref={i === 0 ? first : undefined} variant={b.style ? VARIANT[b.style] : 'outline'} onClick={() => answer(b.value)}>
                            {b.label}
                        </Button>
                    ))}
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
