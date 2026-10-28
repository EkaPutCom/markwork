import { useEffect, useRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter } from '@lezer/highlight';
import { createFindBar } from '../lib/findbar';
import { useClient } from '../lib/useClient';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

// A page snapshot, deliberately separate from MarkdownEditor and its document write callbacks.
export function CodePage({ id, pane, file, text }: { id: number; pane: number; file: string; text: string }) {
    const client = useClient();
    const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null);
    const name = file.split(/[\\/]/).pop() ?? file;
    const language = LanguageDescription.matchFilename(languages, name);
    useEffect(() => {
        const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: text, extensions: [
            EditorState.readOnly.of(true), EditorView.editable.of(false),
            EditorView.contentAttributes.of({ tabindex: '0', role: 'textbox', 'aria-label': `Code: ${name}`, 'aria-readonly': 'true' }),
            lineNumbers(), drawSelection(), search({ top: true, createPanel: createFindBar }),
            EditorView.updateListener.of(update => {
                if (!update.selectionSet) return;
                const { head, from, to } = update.state.selection.main;
                const line = update.state.doc.lineAt(head);
                client.codeMoved(pane, id, { line: line.number, column: Array.from(line.text.slice(0, head - line.from)).length + 1,
                    selected: from === to ? 0 : Array.from(update.state.sliceDoc(from, to)).length });
            }),
            keymap.of([...searchKeymap, ...defaultKeymap]), syntaxHighlighting(classHighlighter),
        ] }) });
        editor.current = view;
        client.codeMoved(pane, id, { line: 1, column: 1, selected: 0 });
        let live = true;
        if (language) void language.load().then(support => {
            if (live) view.dispatch({ effects: StateEffect.appendConfig.of(support) });
        }).catch(() => { /* Unsupported grammars keep readable plain text. */ });
        return () => { live = false; editor.current = null; view.destroy(); client.codeMoved(pane, id, null); };
    }, [client, id, pane, file, text, language, name]);
    return <div className="code-page">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
            <Badge variant="secondary">Read-only</Badge>
            <span>{language?.name ?? 'Plain text'}</span>
            <Button className="ml-auto" variant="ghost" size="xs" onClick={() => { if (editor.current) { openSearchPanel(editor.current); } }}>Find</Button>
        </div>
        <div ref={host} className="code-page-editor" />
    </div>;
}
