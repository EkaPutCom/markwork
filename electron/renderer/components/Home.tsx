// The Home page: what can be continued today. It draws the data the core sends (view.home) and reports what
// the user chose; it reads no files itself.

import { useState } from 'react';
import { dayPart } from '../../../src/markdown/home';
import type { HomeData } from '../../../src/app/protocol/screen';
import { Icon } from './Icons';
import { StatusIcon } from './Programs';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { IconButton } from '@/ui/icon-button';
import { useClient } from '../lib/useClient';

const SHOWN_TASKS = 7;

// "5 minutes ago", "2 days ago", else the date.
function ageLabel(seconds: number, now: number): string {
    const diff = Math.max(0, now - seconds * 1000), minute = 60_000, hour = 60 * minute, day = 24 * hour;
    const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    if (diff < minute) return 'just now';
    if (diff < hour) return plural(Math.floor(diff / minute), 'minute');
    if (diff < day) return plural(Math.floor(diff / hour), 'hour');
    if (diff < 7 * day) return plural(Math.floor(diff / day), 'day');
    const date = new Date(seconds * 1000);
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

const GREETINGS = { morning: 'Good morning', midday: 'Good afternoon', afternoon: 'Good afternoon', evening: 'Good evening' } as const;
const RUN_STATUS: Record<string, string> = { waiting: 'Waiting for your answer', queued: 'Queued' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return <section className="home-section"><h2>{title}</h2><div className="home-list">{children}</div></section>;
}

function Row({ title, subtitle, suffix, onClick, prefix, action }: { title: string; subtitle?: string; suffix?: string; onClick?: () => void; prefix?: React.ReactNode; action?: React.ReactNode }) {
    // A row with a button of its own is not a button itself (a button holds no button): its text is the one that opens it.
    const press = onClick ? { role: 'button', tabIndex: 0, onClick, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } } : {};
    return (
        <div className="home-row" {...action ? {} : press}>
            {prefix}
            <span className="text" {...action ? press : {}}><span className="title">{title}</span>{subtitle && <span className="subtitle">{subtitle}</span>}</span>
            {suffix && <span className="suffix">{suffix}</span>}
            {action}
        </div>
    );
}

// The needed programs that are missing, above everything else; gone once they are installed or hidden.
function Setup({ setup }: { setup: NonNullable<HomeData['setup']> }) {
    const client = useClient();
    return (
        <section className="home-section setup-section" aria-label="Set up">
            <div className="setup-head"><h2>Set up</h2><Button variant="ghost" size="xs" aria-description="Hide until something else is missing" onClick={() => client.hideSetup()}>Hide</Button></div>
            <div className="home-list setup-list">
                {setup.items.map(p => (
                    <Row key={p.id} title={p.state === 'not-allowed' ? `${p.name} is not allowed by markworkd on ${p.machine}` : p.machine ? `${p.name} is not installed on ${p.machine}` : `${p.name} is not installed`}
                        subtitle={p.purpose} prefix={<StatusIcon program={p} />}
                        action={<span className="setup-actions">
                            <Button variant="outline" size="xs" onClick={() => client.openPrograms()}>How to install</Button>
                            {setup.runHere && p.name === 'markworkd' && <Button variant="ghost" size="xs" onClick={() => client.runAgentsHere()}>Run in this window instead</Button>}
                        </span>} />
                ))}
                <Row title={setup.note || 'See every program and where it was found'} action={<Button variant="ghost" size="xs" onClick={() => client.openPrograms()}>All programs<Icon name="pan-end" size={14} /></Button>} />
            </div>
        </section>
    );
}

function Task({ task }: { task: HomeData['tasks'][number] }) {
    const client = useClient();
    const [checked, setChecked] = useState(false);
    const board = task.file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const due = task.status === 'overdue' ? `${-task.days} day${task.days === -1 ? '' : 's'} overdue` : task.status === 'today' ? 'Today' : task.days === 1 ? 'Tomorrow' : 'Day after tomorrow';
    return (
        <Row title={task.title} subtitle={task.project ? `${task.project} · ${board}` : board} suffix={due} onClick={() => client.openWorkspaceFile(task.file)}
            prefix={<Checkbox checked={checked} aria-label={`Done: ${task.title}`} onClick={e => e.stopPropagation()}
                onCheckedChange={async value => { const done = value === true; setChecked(done); if (!await client.toggleTask(task, done)) setChecked(!done); }} />} />
    );
}

export function Home({ data }: { data: HomeData | null }) {
    const client = useClient();
    const [allTasks, setAllTasks] = useState(false);
    if (!data) return <div className="home-scroll"><div className="home-page" /></div>;
    const now = new Date(data.now);
    if (!data.workspace && !data.resume.length && !data.recent.length) {
        return (
            <div className="home-scroll"><div className="home-page welcome">
                <h1>Welcome to Markwork</h1>
                <p>Open a work folder to see the latest files, kanban due dates, and the inbox here.</p>
                <div className="actions">
                    <Button onClick={() => void client.openFolder()}>Open Folder…</Button>
                    <Button variant="outline" onClick={() => client.run('new')}>New Document</Button>
                </div>
            </div></div>
        );
    }
    const part = GREETINGS[dayPart(now.getHours())];
    const tasks = allTasks ? data.tasks : data.tasks.slice(0, SHOWN_TASKS);
    const journal = data.journal;
    const journalLine = journal && ([journal.notes ? `${journal.notes} note${journal.notes === 1 ? '' : 's'}` : '', journal.activity ? `${journal.activity} activit${journal.activity === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(' · ')
        || (journal.exists ? 'No notes yet' : 'Not written yet'));
    return (
        <div className="home-scroll"><div className="home-page">
            <header>
                <h1>{data.name ? `${part}, ${data.name}` : part}</h1>
                <p>{now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
            </header>
            {data.setup && <Setup setup={data.setup} />}
            {data.resume.length > 0 && (
                <Section title="Continue">
                    <div className="resume">
                        {data.resume.map(e => (
                            <Button key={e.path} variant="outline" className="card h-auto items-start font-normal text-left" aria-label={`Continue ${e.subtitle} in ${e.title}`} onClick={() => client.openRecent(e.path)}>
                                <span className="title">{e.title}</span><span className="subtitle">{e.subtitle}</span>
                            </Button>
                        ))}
                    </div>
                </Section>
            )}
            {journal && <Section title="Journal"><Row title="Today's journal" subtitle={journalLine ?? ''} onClick={() => client.openJournal()}
                action={<IconButton label="Add to Journal…" onClick={e => { e.stopPropagation(); client.run('journal-capture'); }}><Icon name="list-add" /></IconButton>} /></Section>}
            {(data.runs.length > 0 || data.agentHost) && (
                <Section title="Agent">
                    {data.agentHost && <Row title={`Agents run on ${data.agentHost.label}`} subtitle={data.agentHost.state === 'ready' ? '' : data.agentHost.detail}
                        suffix={{ ready: 'Connected', waiting: 'Trying again', failed: 'Cannot connect' }[data.agentHost.state as string] ?? 'Connecting…'} />}
                    {data.runs.map(r => <Row key={r.id} title={r.title} subtitle={r.agent} suffix={RUN_STATUS[r.status] ?? 'Working'} onClick={() => client.openRun(r.id)} />)}
                </Section>
            )}
            <Section title="Due dates">
                {!data.workspace ? <Row title="Open a work folder to see due dates from kanban boards" />
                    : data.tasks.length === 0 ? <Row title="Nothing is due until the day after tomorrow" />
                    : tasks.map((t, i) => <Task key={`${t.file}:${t.at.column}:${t.at.index}:${i}`} task={t} />)}
                {data.tasks.length > tasks.length && <Row title={`Show ${data.tasks.length - tasks.length} more task${data.tasks.length - tasks.length === 1 ? '' : 's'}`} onClick={() => setAllTasks(true)} />}
            </Section>
            {data.inboxes.length > 0 && (
                <Section title="Inbox">{data.inboxes.map(i => <Row key={i.file} title={i.file} suffix={`${i.open} unprocessed`} onClick={() => client.openWorkspaceFile(i.file)} />)}</Section>
            )}
            {data.recent.length > 0 && (
                <Section title="Recent files">{data.recent.map(e => <Row key={e.path} title={e.title} subtitle={e.subtitle} suffix={ageLabel(e.time, data.now)} onClick={() => client.openRecent(e.path)} />)}</Section>
            )}
        </div></div>
    );
}
