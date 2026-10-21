// The sidebar, as shadcn's Sidebar: the workspace at the top, Home and the journal, the panel of the page shown, and the
// pages at the foot. Closed, it is a rail of icons with the same pages; a page button opens the sidebar on that page and
// the button of the page shown closes it (client.ts showSidebarPage).

import type { ReactNode } from 'react';
import { COMMANDS } from '../../../src/app/commands.js';
import { Icon, type IconName } from './Icons.js';
import { useClient, useStore } from '../lib/useClient.js';
import { layoutOf } from '../lib/client.js';

export const PAGES: { page: string; label: string; icon: IconName }[] = [
    { page: 'files', label: 'Files', icon: 'folder' },
    { page: 'search', label: 'Search', icon: 'search' },
    { page: 'outline', label: 'Outline', icon: 'outline' },
    { page: 'history', label: 'History', icon: 'document-open-recent' },
    { page: 'collab', label: 'Pull requests', icon: 'pull-request' },
];

// The home folder, as the core shows it: a tab's folder is its `place` with ~ for home, so the part of its path that ~
// stands for is home. Null while no open file tells.
function homeOf(tabs: { file: string | null; place: string | null }[]): string | null {
    for (const { file, place } of tabs) {
        if (!file || !place?.startsWith('~')) continue;
        const dir = file.replace(/[\\/][^\\/]*$/, '');
        if (dir.endsWith(place.slice(1))) return dir.slice(0, dir.length - (place.length - 1));
    }
    return null;
}

// The first letter of the workspace, as its mark.
function initial(root: string | null): string {
    return (root?.split(/[\\/]/).filter(Boolean).pop() ?? 'Markwork').charAt(0).toUpperCase();
}

// The rail: the sidebar closed to its icons.
export function Rail() {
    const client = useClient();
    const state = useStore();
    const shown = layoutOf(state).sidebar.shown;
    const current = state.settings['sidebar-page'] ?? 'files';
    return (
        <nav className="rail" aria-label="Sidebar pages">
            <span className="logo" aria-hidden="true">{initial(state.tree.root)}</span>
            {PAGES.map(({ page, label, icon }) => (
                <button key={page} className="button flat" title={label} aria-label={label}
                    aria-pressed={shown && current === page} onClick={() => client.showSidebarPage(page)}>
                    <Icon name={icon} />
                </button>
            ))}
            <button className="button flat rail-programs" title="Programs" aria-label={state.programsMissing > 0 ? `Programs, ${state.programsMissing} missing` : 'Programs'} onClick={() => client.openPrograms()}>
                <Icon name="programs" />{state.programsMissing > 0 && <span className="mark-dot" aria-hidden="true" />}
            </button>
        </nav>
    );
}

// A line of the sidebar's menus: a page, or a command it runs.
function Item({ icon, label, pressed, onClick, children }: { icon: IconName; label: string; pressed?: boolean; onClick: () => void; children?: ReactNode }) {
    return (
        <button className="item" aria-pressed={pressed} onClick={onClick}>
            <Icon name={icon} /><span className="label">{label}</span>{children}
        </button>
    );
}

// The sidebar open, around the panel of its page. Floating (a narrow window), the rail beside it has the pages.
export function SideShell({ children }: { children: ReactNode }) {
    const client = useClient();
    const state = useStore();
    const floats = layoutOf(state).sidebar.floats;
    const current = state.settings['sidebar-page'] ?? 'files';
    const root = state.tree.root;
    const name = root?.split(/[\\/]/).filter(Boolean).pop();
    const home = homeOf(state.tabs);
    const where = root && home && (root === home || /^[\\/]/.test(root.slice(home.length))) ? `~${root.slice(home.length)}` : root;
    const command = (id: string) => COMMANDS.find(c => c.id === id);
    const can = (id: string) => { const c = command(id); return c !== undefined && client.enabled(c); };
    return (
        <div className="side-shell">
            <div className="workspace">
                <span className="logo" aria-hidden="true">{initial(root)}</span>
                <span className="text"><strong>{name ?? 'Markwork'}</strong><span title={root ?? undefined}>{where ?? 'No folder open'}</span></span>
            </div>
            <nav className="side-nav" aria-label="Workspace">
                {can('home') && <Item icon="home" label="Home" onClick={() => client.run('home')} />}
                {can('journal') && <Item icon="journal" label="Journal" onClick={() => client.run('journal')} />}
            </nav>
            {children}
            {!floats && (
                <nav className="side-nav foot" aria-label="Sidebar pages">
                    {PAGES.map(({ page, label, icon }) => (
                        <Item key={page} icon={icon} label={label} pressed={current === page} onClick={() => client.showSidebarPage(page)} />
                    ))}
                    <Item icon="programs" label="Programs" onClick={() => client.openPrograms()}>
                        {state.programsMissing > 0 && <span className="mark-dot" role="img" aria-label={`${state.programsMissing} missing`} />}
                    </Item>
                </nav>
            )}
        </div>
    );
}
