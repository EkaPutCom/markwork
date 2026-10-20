// Preferences → Agents: where the agents run, the machines they
// can run on, and the projects with how their cards are isolated. The values are the core's; a change is reported as a key and a
// value, or for a project as a patch the core checks field by field.

import { useEffect, useState, type ReactNode } from 'react';
import type { PreferencesData, ProjectPage, WorktreeList } from '../../../src/app/protocol/preferences.js';
import { useClient, useStore } from '../lib/useClient.js';

function Row({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
    return <div className="pref-row"><span className="text"><span className="title">{title}</span>{subtitle && <span className="subtitle">{subtitle}</span>}</span>{children}</div>;
}

// A text that is written when the user leaves the field or presses Enter, not at every key; it starts again from the core's value.
function CommitText({ value, label, placeholder, onCommit }: { value: string; label: string; placeholder?: string; onCommit: (text: string) => void }) {
    const [text, setText] = useState(value);
    useEffect(() => { setText(value); }, [value]);
    const commit = () => { if (text !== value) onCommit(text); };
    return <input aria-label={label} value={text} placeholder={placeholder} onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape' && text !== value) { e.stopPropagation(); setText(value); } }} />;
}

// The markworkd daemon on this computer is Linux only for now (docs/design/electron.md): other systems run agents as children of the window.
const daemonHere = (): boolean => /Linux/.test(navigator.userAgent);

function Worktrees({ page, list }: { page: ProjectPage; list: WorktreeList | null }) {
    const client = useClient();
    const [error, setError] = useState('');
    useEffect(() => { setError(''); }, [list]);
    if (!list) return <p className="dim">Looking for worktrees…</p>;
    return (
        <>
            {list.loading && <p className="dim">Reading the worktrees from git…</p>}
            {(error || list.error) && <div className="form-error" role="alert">{error || list.error}</div>}
            {!list.loading && !list.items.length && !list.error && <p className="dim">No card has a worktree now.</p>}
            <ul className="worktrees">
                {list.items.map(w => (
                    <li key={w.path}>
                        <span className="text"><span className="title">{w.branch}</span><span className="subtitle">{w.path}</span></span>
                        <button className="button" onClick={() => void client.removeWorktree(page.name, w.path).then(e => setError(e ?? ''))}>Remove…</button>
                    </li>
                ))}
            </ul>
        </>
    );
}

function ProjectPageView({ page }: { page: ProjectPage }) {
    const client = useClient();
    const { worktrees } = useStore();
    const [error, setError] = useState('');
    const iso = page.isolation;
    // A change is a patch of one field; the core writes it or says why not.
    const change = (patch: Record<string, unknown>) => { void client.setProject(page.name, patch).then(e => { setError(e ?? ''); if (!e) client.openProject(page.name); }); };
    return (
        <div className="pref-page">
            <div className="project-head">
                <button className="button flat" onClick={() => client.closeProject()}>← Projects</button>
                <h3>{page.name}</h3>
            </div>
            <Row title="Folder" subtitle={`On ${page.machine}`}><code className="path">{page.folder}</code></Row>
            <Row title="A worktree per card" subtitle="Each card works on a branch of its own, so cards do not step on each other">
                <input type="checkbox" role="switch" aria-label="A worktree per card" checked={iso.worktrees} onChange={e => change({ worktrees: e.target.checked })} />
            </Row>
            {iso.worktrees && (
                <>
                    <Row title="Cards at the same time" subtitle={`1 to ${page.maxSlots}`}>
                        <input type="number" aria-label="Cards at the same time" min={1} max={page.maxSlots} value={iso.slots}
                            onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n)) change({ slots: n }); }} />
                    </Row>
                    <Row title="Base branch" subtitle="Empty: the branch the project folder is on"><CommitText label="Base branch" value={iso.base} onCommit={base => change({ base })} /></Row>
                    <Row title="Worktree folder" subtitle={`Empty: ${page.defaultDir}`}><CommitText label="Worktree folder" value={iso.dir} placeholder={page.defaultDir} onCommit={dir => change({ dir })} /></Row>
                    <Row title="After merging">
                        <select aria-label="After merging" value={iso.afterMerge} onChange={e => change({ afterMerge: e.target.value })}>
                            <option value="remove">Remove the branch</option><option value="keep-branch">Keep the branch</option>
                        </select>
                    </Row>
                </>
            )}
            {error && <div className="form-error" role="alert">{error}</div>}
            <h3>Card worktrees</h3>
            <p className="dim">Branches that start with {page.branchPrefix}.</p>
            <Worktrees page={page} list={worktrees} />
        </div>
    );
}

export function AgentsPage({ prefs }: { prefs: PreferencesData }) {
    const client = useClient();
    const { project } = useStore();
    const choices = prefs.machineChoices.filter(c => c.value !== 'local' || daemonHere());
    if (project) return <ProjectPageView page={project} />;
    return (
        <div className="pref-page">
            <h3>Run agents</h3>
            <Row title="Where" subtitle="Agents run as children of this window, or on a machine that goes on without it">
                <select aria-label="Run agents" value={prefs.harnessMachine} onChange={e => client.setPreference('harnessMachine', e.target.value)}>
                    {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
            </Row>
            {daemonHere() && <Row title="markworkd command" subtitle="Empty: the one that came with Markwork"><CommitText label="markworkd command" value={prefs.daemonCommand} onCommit={v => client.setPreference('daemonCommand', v)} /></Row>}
            <h3>Machines</h3>
            {!prefs.machines.length && <p className="dim">No machines yet. Add one to run agents over ssh.</p>}
            {prefs.machines.map(m => (
                <Row key={m.name} title={m.name} subtitle={m.target}><button className="button" aria-label={`Remove ${m.name}`} onClick={() => client.removeMachine(m.name)}>Remove</button></Row>
            ))}
            <div className="pref-actions"><button className="button" onClick={() => client.addMachine()}>Add Machine…</button></div>
            <h3>Projects</h3>
            {!prefs.projects.length && <p className="dim">A project appears here when you assign its first card to an agent.</p>}
            {prefs.projects.map(p => (
                <button key={p.name} className="pref-row project-row" onClick={() => client.openProject(p.name)}>
                    <span className="text"><span className="title">{p.name}</span><span className="subtitle">{p.folder}</span></span>
                    <span className="side-meta">{p.worktrees ? 'worktrees' : 'in the folder'} ›</span>
                </button>
            ))}
        </div>
    );
}
