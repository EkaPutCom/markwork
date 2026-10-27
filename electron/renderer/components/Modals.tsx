// The dialogs that are pages of settings or information: Preferences, Keyboard Shortcuts, and About. Preferences draws the values
// the core sends (view.prefs.*) and reports each change as a key and a value; the other two read the window's own command table.

import { useEffect, useState, type ReactNode } from 'react';
import { COMMANDS } from '../../../src/app/commands.js';
import { AgentsPage } from './AgentsPrefs.js';
import { Icon } from './Icons.js';
import { label } from '../lib/keys.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Select } from '../ui/select.js';
import { cn } from '../lib/utils.js';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog.js';
import { IconButton } from '../ui/icon-button.js';
import { Input } from '../ui/input.js';
import { Kbd } from '../ui/kbd.js';
import { Switch } from '../ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.js';

// A task in a window of its own: shadcn's Dialog with a header bar, the title at the start (or what `header` puts there,
// as the tabs of Preferences) and Close at the end. Escape and a click beside it close it. With `tabs`, the header and the
// body share one Tabs, so `header` holds its TabsList and the body its TabsContent. `hidden` takes it and its darkening
// out of sight for a moment without closing it (while a picture of the editor is taken).
export function Modal({ title, onClose, children, wide, header, className, tabs, hidden }: {
    title: string; onClose: () => void; children: ReactNode; wide?: boolean; header?: ReactNode; className?: string;
    tabs?: { value: string; onValueChange: (value: string) => void }; hidden?: boolean;
}) {
    const body = (
        <>
            <header>
                {header ?? <DialogTitle>{title}</DialogTitle>}
                {header && <DialogTitle className="sr-only">{title}</DialogTitle>}
                <DialogClose asChild><IconButton size="icon-xs" label="Close"><Icon name="window-close" /></IconButton></DialogClose>
            </header>
            {children}
        </>
    );
    return (
        <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
            {/* Without a field that takes the focus (autoFocus), the dialog itself has it: on Close, the first thing in it,
                its Tooltip would open, and the first Escape would close only that. */}
            <DialogContent showCloseButton={false} aria-describedby={undefined} className={cn('modal block gap-0 p-0 outline-none focus-visible:shadow-lg', wide && 'wide', hidden && 'out-of-sight', className)}
                onOpenAutoFocus={e => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}>
                {tabs ? <Tabs value={tabs.value} onValueChange={tabs.onValueChange} className="contents">{body}</Tabs> : body}
            </DialogContent>
        </Dialog>
    );
}

// ---------- Preferences ----------

function Row({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
    return <label className="pref-row"><span className="text"><span className="title">{title}</span>{subtitle && <span className="subtitle">{subtitle}</span>}</span>{children}</label>;
}

// A group of rows in a box, under its title (and what the group is about), as an Adwaita preferences group.
export function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
    return (
        <section className="pref-group">
            <h3>{title}</h3>
            {description && <p className="description">{description}</p>}
            <div className="boxed">{children}</div>
        </section>
    );
}

// A number with − and + beside it, kept between `min` and `max` and moved by `step`.
function SpinButton({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void }) {
    const [text, setText] = useState(String(value));
    useEffect(() => { setText(String(value)); }, [value]);
    const set = (n: number) => { const clamped = Math.min(max, Math.max(min, Math.round(n))); setText(String(clamped)); if (clamped !== value) onChange(clamped); };
    return (
        <span className="spin">
            <Input type="text" inputMode="numeric" role="spinbutton" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} value={text}
                onChange={e => setText(e.target.value)} onBlur={() => { const n = Number(text); if (Number.isFinite(n) && text.trim()) set(n); else setText(String(value)); }}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'ArrowUp') { e.preventDefault(); set(value + step); } else if (e.key === 'ArrowDown') { e.preventDefault(); set(value - step); } }} />
            <IconButton variant="outline" label="Decrease" disabled={value <= min} onClick={e => { e.preventDefault(); set(value - step); }}><Icon name="list-remove" /></IconButton>
            <IconButton variant="outline" label="Increase" disabled={value >= max} onClick={e => { e.preventDefault(); set(value + step); }}><Icon name="list-add" /></IconButton>
        </span>
    );
}

const PREF_PAGES = [
    { page: 'general', label: 'General', icon: 'preferences-system' },
    { page: 'assistant', label: 'Assistant', icon: 'user-available' },
    { page: 'agents', label: 'Agents', icon: 'system-run' },
] as const;

export function PreferencesDialog() {
    const client = useClient();
    const { prefs } = useStore();
    const [page, setPage] = useState<'general' | 'assistant' | 'agents'>('general');
    if (!prefs) return null;
    const set = (key: string) => (value: string | number | boolean) => client.setPreference(key, value);
    const toggle = (key: 'visual' | 'focus' | 'typewriter' | 'home' | 'autosave' | 'chatThinking' | 'chatSave' | 'forgeNotify', title: string, subtitle?: string) => (
        <Row title={title} subtitle={subtitle}><Switch aria-label={title} checked={prefs[key]} onCheckedChange={set(key)} /></Row>
    );
    const tabs = (
        <TabsList className="pref-tabs">
            {PREF_PAGES.map(p => <TabsTrigger key={p.page} value={p.page}><Icon name={p.icon} />{p.label}</TabsTrigger>)}
        </TabsList>
    );
    return (
        <Modal title="Preferences" onClose={() => client.closePreferences()} wide header={tabs} className="preferences"
            tabs={{ value: page, onValueChange: value => setPage(value as typeof page) }}>
            <TabsContent value={page}>
            {page === 'general' ? (
                <div className="pref-page">
                    <Group title="View">
                        <Row title="Color scheme">
                            <Select value={prefs.colorScheme} onChange={e => set('colorScheme')(e.target.value)}>
                                <option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option>
                            </Select>
                        </Row>
                        {toggle('visual', 'Visual editor', 'Edit text as it looks. Off: the live view, which shows syntax on the cursor line')}
                        {toggle('focus', 'Focus mode', 'Dim all paragraphs except the one being edited')}
                        {toggle('typewriter', 'Typewriter mode', 'Keep the line being typed in the middle')}
                    </Group>
                    <Group title="Files">
                        {toggle('home', 'Home', 'Show when no document is open')}
                        {toggle('autosave', 'Autosave', 'Applies to documents that already have a file')}
                    </Group>
                    <Group title="Collaboration" description="Pull requests of the Forgejo or Gitea server behind the folder's git remote">
                        <Row title="Check every" subtitle="Seconds between looks for new pull requests">
                            <SpinButton label="Check every" value={prefs.forgePollSeconds} min={30} max={3600} step={30} onChange={set('forgePollSeconds')} />
                        </Row>
                        {toggle('forgeNotify', 'Desktop notifications', 'When a pull request is opened or updated')}
                    </Group>
                </div>
            ) : page === 'agents' ? <AgentsPage prefs={prefs} /> : (
                <div className="pref-page">
                    <Group title="Assistant">
                        <Row title="Model">
                            <Select value={prefs.chatModel} onChange={e => set('chatModel')(e.target.value)}>
                                {prefs.chatModels.map(m => <option key={m} value={m}>{m}</option>)}
                            </Select>
                        </Row>
                        {toggle('chatThinking', 'Thinking mode', 'More thorough, but slower')}
                        {toggle('chatSave', 'Save conversation history', 'Saved in the work folder, in .markwork/chats')}
                    </Group>
                </div>
            )}
            </TabsContent>
        </Modal>
    );
}

// ---------- Keyboard Shortcuts ----------

// The sections and the commands in them.
const SECTIONS: [string, string[]][] = [
    ['Files', ['new', 'open', 'open-folder', 'save', 'save-as', 'export-html']],
    ['Tab', ['home', 'next-tab', 'prev-tab', 'close-tab', 'close-all-tabs']],
    ['Journal', ['journal', 'journal-capture']],
    ['Editing', ['undo', 'redo', 'find', 'replace', 'search-files', 'replace-files']],
    ['Format', ['bold', 'italic', 'strike', 'inline-code', 'highlight', 'link', 'image', 'codeblock', 'table', 'divider', 'quote', 'ulist', 'olist', 'tasklist', 'block-up', 'block-down']],
    ['Panes', ['split-right', 'split-down', 'move-to-next-pane', 'close-pane']],
    ['Table', ['table-row-below', 'table-row-above', 'table-delete-row', 'table-col-right', 'table-col-left', 'table-delete-col', 'table-format']],
    ['View', ['sidebar', 'chat', 'kanban-view', 'visual', 'source', 'focus', 'typewriter', 'dark']],
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
                            {items.map(c => <div key={c!.id} className="shortcut"><span>{c!.label}</span><Kbd>{label(c!.keys[0])}</Kbd></div>)}
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
                <p><a href="https://usemarkwork.com/" onClick={e => { e.preventDefault(); window.open('https://usemarkwork.com/'); }}>usemarkwork.com</a></p>
                <p className="dim">© 2026 Eka Putra · MIT License</p>
            </div>
        </Modal>
    );
}
