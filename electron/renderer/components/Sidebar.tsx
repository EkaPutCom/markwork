// The sidebar, as the sidebar of VS Code: an activity bar with the pages (Files, Search, History, Pull requests, and Programs
// and Preferences at the foot) that stays when the sidebar is closed, and the panel of the page shown beside it.

import { useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icons.js';
import { useClient, useStore } from '../lib/useClient.js';
import { layoutOf, SIDEBAR_WIDTH } from '../lib/client.js';

export const PAGES: { page: string; label: string; icon: IconName }[] = [
    { page: 'files', label: 'Files', icon: 'folder' },
    { page: 'search', label: 'Search', icon: 'search' },
    { page: 'history', label: 'History', icon: 'document-open-recent' },
    { page: 'collab', label: 'Pull requests', icon: 'pull-request' },
];

// The activity bar: always there, closed or open. A page button opens the sidebar on that page, and the button of the page
// shown closes it (client.ts showSidebarPage); Programs is a tab of its own, with a mark while something is missing.
export function ActivityBar() {
    const client = useClient();
    const state = useStore();
    const shown = layoutOf(state).sidebar.shown;
    const current = state.settings['sidebar-page'] ?? 'files';
    return (
        <nav className="rail" aria-label="Sidebar pages">
            {PAGES.map(({ page, label, icon }) => (
                <button key={page} className="button flat" title={label} aria-label={label}
                    aria-pressed={shown && current === page} onClick={() => client.showSidebarPage(page)}>
                    <Icon name={icon} />
                </button>
            ))}
            <span className="grow" />
            <button className="button flat rail-programs" title="Programs" aria-label={state.programsMissing > 0 ? `Programs, ${state.programsMissing} missing` : 'Programs'} onClick={() => client.openPrograms()}>
                <Icon name="programs" />{state.programsMissing > 0 && <span className="mark-dot" aria-hidden="true" />}
            </button>
            <button className="button flat" title="Preferences" aria-label="Preferences" onClick={() => client.run('preferences')}>
                <Icon name="preferences-system" />
            </button>
        </nav>
    );
}

// The sidebar open, around the panel of its page: its edge is dragged to change its width. Floating (a narrow window), it
// lies over the editor beside the activity bar.
export function SideShell({ children }: { children: ReactNode }) {
    const client = useClient();
    const state = useStore();
    const saved = Number(state.settings['sidebar-width']);
    const [dragging, setDragging] = useState<number | null>(null);
    const width = dragging ?? (saved >= SIDEBAR_WIDTH.min ? Math.min(saved, SIDEBAR_WIDTH.max) : SIDEBAR_WIDTH.default);
    return (
        <div className="side-shell" style={{ width }}>
            {children}
            <div className="side-grip" role="separator" aria-orientation="vertical" aria-label="Resize the sidebar"
                onPointerDown={e => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const x0 = e.clientX, w0 = width;
                    const grip = e.currentTarget;
                    const clamp = (x: number) => Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, w0 + x - x0));
                    const move = (ev: PointerEvent) => setDragging(clamp(ev.clientX));
                    const up = (ev: PointerEvent) => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); setDragging(null); client.setSidebarWidth(clamp(ev.clientX)); };
                    grip.addEventListener('pointermove', move);
                    grip.addEventListener('pointerup', up);
                }} />
        </div>
    );
}
