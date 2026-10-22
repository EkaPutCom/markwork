import { useState, type DragEvent } from 'react';
import { Icon } from './Icons.js';
import type { Tab } from '../lib/client.js';
import type { Pane } from '../lib/panes.js';
import { useClient, useStore } from '../lib/useClient.js';

// What a dragged tab carries: the pane it comes from and its document. A file of the sidebar carries its path instead.
export const TAB_DRAG = 'application/x-markwork-tab';
export const FILE_DRAG = 'application/x-markwork-file';

// The tabs of a pane, drawn as VS Code's: flat, from the left, a line of accent over the one shown. With a single pane they are drawn over the editor, even for one document; with several,
// each pane's bar has its own. A document with changes not saved has a dot before its
// name, and the tab says so to a screen reader. A tab is dragged to another place in the bar, or to another pane.
export function PaneTabs({ pane, solo, label, onMenu }: { pane: Pane; solo: boolean; label: string; onMenu: (doc: number) => void }) {
    const client = useClient();
    const { tabs } = useStore();
    const [before, setBefore] = useState<number | null>(null);
    const docs = pane.tabs.map(id => tabs.find(t => t.id === id)).filter((t): t is Tab => !!t);
    if (docs.length === 0) return null;
    const dragOver = (e: DragEvent, doc: number) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG)) return;
        e.preventDefault();
        setBefore(doc);
    };
    const drop = (e: DragEvent, doc: number | null) => {
        setBefore(null);
        const raw = e.dataTransfer.getData(TAB_DRAG);
        if (!raw) return;
        const from = JSON.parse(raw) as { pane: number; doc: number };
        // Within the bar a tab changes its place; from another pane, the pane's drop zone takes it (joins its tabs).
        if (from.pane !== pane.id) return;
        e.preventDefault();
        e.stopPropagation();
        client.reorderTab(pane.id, from.doc, doc);
    };
    return (
        <div className={solo ? 'tabs' : 'pane-tabs'}>
            <div className="tab-list" role="tablist" aria-label={label} onDragLeave={() => setBefore(null)} onDrop={e => drop(e, null)} onDragOver={e => dragOver(e, -1)}>
                {docs.map(t => (
                    <div key={t.id} role="tab" aria-selected={t.id === pane.active} className={`tab${t.id === pane.active ? ' active' : ''}${before === t.id ? ' drop-before' : ''}`}
                        title={t.file ?? t.name} draggable
                        onDragStart={e => { e.dataTransfer.setData(TAB_DRAG, JSON.stringify({ pane: pane.id, doc: t.id })); e.dataTransfer.effectAllowed = 'move'; }}
                        onDragOver={e => { e.stopPropagation(); dragOver(e, t.id); }} onDrop={e => drop(e, t.id)}
                        onClick={() => client.selectTab(t.id, pane.id)} onAuxClick={e => { if (e.button === 1) client.closeTab(t.id, pane.id); }}
                        onContextMenu={e => { e.preventDefault(); client.selectTab(t.id, pane.id); onMenu(t.id); }}>
                        <Icon name="text-x-generic" size={14} className="file" />
                        <span className="label">{t.name}</span>
                        {t.mirror.modified && <span className="dot" role="img" aria-label="Unsaved" />}
                        <button className="button flat circular close" aria-label={`Close ${t.name}`} onClick={e => { e.stopPropagation(); client.closeTab(t.id, pane.id); }}>
                            <Icon name="window-close" size={14} />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
