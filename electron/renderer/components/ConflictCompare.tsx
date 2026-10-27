// One conflict in three panes: immutable sources and an editable result, applied only by the user's explicit action.
import { useMemo, useState } from 'react';
import { sideBySide, type DiffCell } from '../../../src/markdown/diffview.js';
import type { ConflictComparison } from '../../../src/app/protocol/screen.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Button } from '../ui/button.js';
import { Textarea } from '../ui/textarea.js';
import { DiffColumn } from './Diff.js';

function Source({ title, branch, cells, accept, both }: {
    title: 'Incoming' | 'Current'; branch: string; cells: (DiffCell | null)[]; accept(): void; both(): void;
}) {
    return <section className={`conflict-merge-source ${title.toLowerCase()}`} aria-label={`${title} Change`}>
        <div className="flex flex-wrap items-baseline gap-2 border-b px-3 py-2">
            <h3 className="text-sm font-medium">{title}</h3><span className="break-all text-xs text-muted-foreground">{branch || title}</span>
        </div>
        <div className="flex flex-wrap gap-1 border-b px-2 py-1">
            <Button variant="ghost" size="xs" onClick={accept}>Accept {title}</Button>
            <Button variant="ghost" size="xs" onClick={both}>Accept Both ({title} First)</Button>
        </div>
        <div className="min-h-0 overflow-auto" tabIndex={0} role="region" aria-label={`${title} source`}><DiffColumn cells={cells} /></div>
    </section>;
}

function MergeResult({ comparison }: { comparison: ConflictComparison }) {
    const client = useClient();
    const [text, setText] = useState('');
    const [choice, setChoice] = useState<string | null>(null);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rows = useMemo(() => sideBySide(comparison.lines).filter(r => r.kind === 'line'), [comparison.lines]);
    const choose = (value: string, name: string) => { setText(value); setChoice(name); };
    const combine = (first: string, second: string) => first + second;
    const apply = async () => {
        setApplying(true);
        setError(null);
        try {
            if (!await client.applyConflictComparison(comparison.id, text)) setError('The document changed. Close this comparison and open it again before applying.');
        } catch (error) { setError(error instanceof Error ? error.message : 'Could not apply the result. Please try again.'); }
        finally { setApplying(false); }
    };
    return <>
        <div className="conflict-merge-sources">
            <Source title="Incoming" branch={comparison.incoming} cells={rows.map(r => r.right)}
                accept={() => choose(comparison.incomingText, 'Incoming accepted')}
                both={() => choose(combine(comparison.incomingText, comparison.currentText), 'Both accepted — Incoming first')} />
            <Source title="Current" branch={comparison.current} cells={rows.map(r => r.left)}
                accept={() => choose(comparison.currentText, 'Current accepted')}
                both={() => choose(combine(comparison.currentText, comparison.incomingText), 'Both accepted — Current first')} />
        </div>
        <section className="conflict-merge-result" aria-label="Merge result">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-3 py-2">
                <h3 className="text-sm font-medium">Result <span className="text-xs font-normal text-muted-foreground">{comparison.file}</span></h3>
                <span role="status" className="text-xs text-muted-foreground">{choice ?? 'No changes accepted'}</span>
            </div>
            <Textarea aria-label="Result" className="min-h-32 resize-none rounded-none border-0 font-mono text-sm shadow-none"
                value={text} onChange={event => choose(event.target.value, 'Edited result')} />
        </section>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
            <Button variant="ghost" disabled={applying || choice === null} onClick={() => { setText(''); setChoice(null); }}>Reset selection</Button>
            <Button variant="outline" disabled={applying} onClick={() => client.closeConflictComparison()}>Close comparison</Button>
            <Button disabled={applying || choice === null} onClick={() => void apply()}>{applying ? 'Applying…' : 'Apply Result'}</Button>
        </DialogFooter>
    </>;
}

export function ConflictCompare() {
    const client = useClient();
    const { conflictComparison: comparison } = useStore();
    if (!comparison) return null;
    return <Dialog open onOpenChange={open => { if (!open) client.closeConflictComparison(); }}>
        <DialogContent className="conflict-merge flex flex-col sm:max-w-6xl max-h-[calc(100%-2rem)] overflow-y-auto"
            onCloseAutoFocus={event => { event.preventDefault(); client.focusEditor(); }}>
            <DialogHeader>
                <DialogTitle>Compare Changes</DialogTitle>
                <DialogDescription className="break-words">{comparison.file} · Selected conflict · Choose changes or edit the result, then apply.</DialogDescription>
            </DialogHeader>
            <MergeResult key={comparison.id} comparison={comparison} />
        </DialogContent>
    </Dialog>;
}
