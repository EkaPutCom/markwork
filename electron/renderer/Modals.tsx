// The dialogs that are pages of settings or information: Preferences, Keyboard Shortcuts, and About. Preferences draws the values
// the core sends (view.prefs.*) and reports each change as a key and a value; the other two read the window's own command table.

import { useEffect, useState, type ReactNode } from 'react';
import { COMMANDS } from '../../src/app/commands.js';
import { AgentsPage } from './AgentsPrefs.js';
import { label } from './keys.js';
import { useClient, useStore } from './useClient.js';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
    useEffect(() => {
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
        window.addEventListener('keydown', key, true);
        return () => window.removeEventListener('keydown', key, true);
    }, [onClose]);
    return (
        <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={`dialog modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title} aria-modal="true">
                <header><h2>{title}</h2><button className="button flat circular" aria-label="Close" onClick={onClose}>×</button></header>
                {children}
            </div>
        </div>
    );
}

// ---------- Preferences ----------

function Row({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
    return <label className="pref-row"><span className="text"><span className="title">{title}</span>{subtitle && <span className="subtitle">{subtitle}</span>}</span>{children}</label>;
}

export function PreferencesDialog() {
    const client = useClient();
    const { prefs } = useStore();
    const [page, setPage] = useState<'general' | 'assistant' | 'agents'>('general');
    if (!prefs) return null;
    const set = (key: string) => (value: string | number | boolean) => client.setPreference(key, value);
    const toggle = (key: 'focus' | 'typewriter' | 'home' | 'autosave' | 'chatThinking' | 'chatSave' | 'forgeNotify', title: string, subtitle?: string) => (
        <Row title={title} subtitle={subtitle}><input type="checkbox" role="switch" checked={prefs[key]} onChange={e => set(key)(e.target.checked)} /></Row>
    );
    return (
        <Modal title="Preferences" onClose={() => client.closePreferences()} wide>
            <div className="pref-tabs" role="tablist">
                {(['general', 'assistant', 'agents'] as const).map(p => (
                    <button key={p} role="tab" aria-selected={page === p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>{{ general: 'General', assistant: 'Assistant', agents: 'Agents' }[p]}</button>
                ))}
            </div>
            {page === 'general' ? (
                <div className="pref-page">
                    <h3>View</h3>
                    <Row title="Color scheme">
                        <select value={prefs.colorScheme} onChange={e => set('colorScheme')(e.target.value)}>
                            <option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option>
                        </select>
                    </Row>
                    {toggle('focus', 'Focus mode', 'Dim all paragraphs except the one being edited')}
                    {toggle('typewriter', 'Typewriter mode', 'Keep the line being typed in the middle')}
                    <h3>Files</h3>
                    {toggle('home', 'Home', 'Show when no document is open')}
                    {toggle('autosave', 'Autosave', 'Applies to documents that already have a file')}
                    <h3>Collaboration</h3>
                    <Row title="Check every" subtitle="Seconds between looks for new pull requests">
                        <input type="number" min={30} max={3600} value={prefs.forgePollSeconds}
                            onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 30 && n <= 3600) set('forgePollSeconds')(n); }} />
                    </Row>
                    {toggle('forgeNotify', 'Desktop notifications', 'When a pull request is opened or updated')}
                </div>
            ) : page === 'agents' ? <AgentsPage prefs={prefs} /> : (
                <div className="pref-page">
                    <Row title="Model">
                        <select value={prefs.chatModel} onChange={e => set('chatModel')(e.target.value)}>
                            {prefs.chatModels.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                    </Row>
                    {toggle('chatThinking', 'Thinking mode', 'More thorough, but slower')}
                    {toggle('chatSave', 'Save conversation history', 'Saved in the work folder, in .markwork/chats')}
                </div>
            )}
        </Modal>
    );
}

// ---------- Keyboard Shortcuts ----------

// The sections and the commands in them.
const SECTIONS: [string, string[]][] = [
    ['Files', ['new', 'open', 'open-folder', 'save', 'save-as', 'export-html']],
    ['Tab', ['home', 'next-tab', 'prev-tab', 'close-tab']],
    ['Journal', ['journal', 'journal-capture']],
    ['Editing', ['undo', 'redo', 'find', 'replace', 'search-files', 'replace-files']],
    ['Format', ['bold', 'italic', 'strike', 'inline-code', 'highlight', 'link', 'image', 'codeblock', 'table', 'quote', 'ulist', 'olist']],
    ['Table', ['table-row-below', 'table-row-above', 'table-delete-row', 'table-col-right', 'table-col-left', 'table-delete-col', 'table-format']],
    ['View', ['sidebar', 'chat', 'kanban-view', 'source', 'focus', 'typewriter', 'dark']],
    ['General', ['command-palette', 'preferences', 'shortcuts', 'quit']],
];

export function ShortcutsDialog() {
    const client = useClient();
    const { info } = useStore();
    if (info !== 'shortcuts') return null;
    return (
        <Modal title="Keyboard Shortcuts" onClose={() => client.showInfo(null)} wide>
            <div className="shortcuts">
                {SECTIONS.map(([title, ids]) => {
                    const items = ids.map(id => COMMANDS.find(c => c.id === id)).filter(c => c?.keys[0]);
                    return items.length === 0 ? null : (
                        <section key={title}>
                            <h3>{title}</h3>
                            {items.map(c => <div key={c!.id} className="shortcut"><span>{c!.label}</span><kbd>{label(c!.keys[0])}</kbd></div>)}
                        </section>
                    );
                })}
            </div>
        </Modal>
    );
}

// ---------- About ----------

export function AboutDialog() {
    const client = useClient();
    const { info } = useStore();
    if (info !== 'about') return null;
    return (
        <Modal title="About Markwork" onClose={() => client.showInfo(null)}>
            <div className="about">
                <h1>Markwork</h1>
                <p className="version">Version {__APP_VERSION__}</p>
                <p>Markdown workspace for humans and AI agents.</p>
                <p><a href="https://markwork.ekaput.com/" onClick={e => { e.preventDefault(); window.open('https://markwork.ekaput.com/'); }}>markwork.ekaput.com</a></p>
                <p className="dim">© 2026 Eka Putra · MIT License</p>
            </div>
        </Modal>
    );
}
