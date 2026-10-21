// The Programs page: the programs Markwork works with (git, pi, markworkd), whether each is there, and how to install a
// missing one. It draws the core's check (view.programs) and reports what the user chose; it looks for nothing itself.

import { useState } from 'react';
import type { InstallWay, ProgramInfo, ProgramsData } from '../../../src/app/protocol/screen.js';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Icon } from './Icons.js';
import { useClient } from '../lib/useClient.js';

const OS_NAMES: Record<InstallWay['os'], string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

// The words for a program's state; never only its color or icon.
export function stateLabel(p: ProgramInfo): string {
    switch (p.state) {
        case 'installed': return p.machine && p.name === 'markworkd' ? 'Connected' : 'Installed';
        case 'missing': return p.machine ? `Not installed on ${p.machine}` : 'Not installed';
        case 'not-allowed': return 'Not allowed by markworkd';
        case 'unknown': return 'Unknown';
    }
}

// ok: there; warn: needed and missing; optional: missing but not needed, or not known.
export function tone(p: ProgramInfo): 'ok' | 'warn' | 'optional' {
    if (p.state === 'installed') return 'ok';
    return p.needed && p.state !== 'unknown' ? 'warn' : 'optional';
}

export function StatusIcon({ program, size = 18 }: { program: ProgramInfo; size?: number }) {
    const t = tone(program);
    return (
        <span className={`program-status ${t}`} aria-hidden="true">
            <Icon name={t === 'ok' ? 'emblem-ok' : t === 'warn' ? 'dialog-error' : 'program-optional'} size={size} />
        </span>
    );
}

function Install({ program }: { program: ProgramInfo }) {
    const client = useClient();
    const [os, setOs] = useState(program.install[0]?.os ?? 'linux');
    const [copied, setCopied] = useState(false);
    const way = program.install.find(w => w.os === os) ?? program.install[0];
    if (!way) return null;
    const copy = () => {
        void navigator.clipboard.writeText(way.command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (
        <div className="program-install">
            {program.install.length > 1 && (
                <div className="program-tabs" role="tablist" aria-label={`How to install ${program.name}`}>
                    {program.install.map(w => (
                        <button key={w.os} role="tab" aria-selected={w.os === os} onClick={() => setOs(w.os)}>{OS_NAMES[w.os]}</button>
                    ))}
                </div>
            )}
            <p>{way.text}</p>
            {way.command && (
                <div className="program-command">
                    <Icon name="utilities-terminal" size={14} />
                    <code>{way.command}</code>
                    <Button variant="ghost" size="icon-xs" title={copied ? 'Copied' : 'Copy'} aria-label={copied ? 'Copied' : `Copy the command for ${program.name}`} onClick={copy}>
                        <Icon name={copied ? 'emblem-ok' : 'edit-copy'} size={14} />
                    </Button>
                </div>
            )}
            <p className="then">Then come back and choose <b>Check again</b>.</p>
            <div className="program-actions">
                <Button size="xs" onClick={() => client.openTerminalFor(program.machine)}>
                    <Icon name="utilities-terminal" size={14} />{program.machine ? `Open Terminal on ${program.machine}` : 'Open Terminal'}
                </Button>
                <Button variant="outline" size="xs" onClick={() => client.openProgramSite(program.name)}>
                    <Icon name="external-link" size={14} />Instructions
                </Button>
            </div>
        </div>
    );
}

function Program({ program }: { program: ProgramInfo }) {
    const t = tone(program);
    // A needed program that is missing shows how to install it; an optional one, when asked.
    const [open, setOpen] = useState(t === 'warn');
    const installable = program.state === 'missing' && program.install.length > 0;
    return (
        <section className={`program ${t}`} aria-label={`${program.name}: ${stateLabel(program)}`}>
            <StatusIcon program={program} />
            <div className="body">
                <div className="name">
                    <h3>{program.name}</h3>
                    <Badge variant="secondary" className={`program-badge ${t}`}>{stateLabel(program)}</Badge>
                    {!program.needed && <Badge variant="secondary">Optional</Badge>}
                </div>
                <p className="purpose">{program.purpose}</p>
                {(program.version || program.path) && <p className="meta">{[program.version, program.path].filter(Boolean).join(' · ')}</p>}
                {program.detail && <p className="meta">{program.detail}</p>}
                {installable && (open ? <Install program={program} /> : (
                    <div className="program-actions"><Button variant="outline" size="xs" onClick={() => setOpen(true)}>How to install</Button></div>
                ))}
            </div>
        </section>
    );
}

export function Programs({ data }: { data: ProgramsData | null }) {
    const client = useClient();
    if (!data) return <div className="home-scroll"><div className="home-page" /></div>;
    const here = data.programs.filter(p => p.machine === null);
    const there = data.programs.filter(p => p.machine !== null);
    const remote = there[0]?.machine ?? null;
    const first = !data.programs.length && data.checking;
    return (
        <div className="home-scroll"><div className="home-page programs-page">
            <header className="programs-header">
                <div>
                    <h1>Programs</h1>
                    <p>{remote
                        ? `Agents run on ${data.machineLabel} (Preferences → Agents), so what they need is checked there.`
                        : 'Markwork edits plain files on its own. These programs add features to it; they are looked for on this computer.'}</p>
                </div>
                <Button variant="outline" size="sm" disabled={data.checking} onClick={() => client.checkPrograms()}>
                    <Icon name="view-refresh" size={14} />{data.checking ? 'Checking…' : 'Check again'}
                </Button>
            </header>
            {first && <p className="programs-checking" role="status">Looking for the programs…</p>}
            {remote && here.length > 0 && <h2 className="programs-group">This computer</h2>}
            {here.map(p => <Program key={p.id} program={p} />)}
            {remote && <h2 className="programs-group">Agents on <span className="where">{remote}</span></h2>}
            {there.map(p => <Program key={p.id} program={p} />)}
        </div></div>
    );
}
