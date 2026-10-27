// The programs Markwork works with but does not ship (git, pi, markworkd): whether each is there, where the features the
// user chose need it, and how to install it. Home lists the missing ones in its Set up section; the Programs page lists
// them all. What is needed follows Preferences → Agents (harness-machine): agents in this window need pi here; through
// markworkd they need markworkd too; on an SSH machine pi and git are checked there, through its daemon, so the check sees
// the PATH and the `programs` list the agent will.

import { platform, type OS, type Processes } from '../platform/index';
import type { AppSettings } from '../base/settings';
import type { GitRun } from '../forge/contribute';
import type { ConnectionState, DaemonConnection } from '../agent/daemon/connection';
import { isRemoteMachine, isValidSshTarget, LOCAL_MACHINE } from '../agent/daemon/machines';
import { daemonRun } from '../orchestrator/daemon';
import { _, fmt } from '../base/i18n';

export type ProgramName = 'git' | 'pi' | 'markworkd';

// installed; missing; not-allowed = there, but the daemon's `programs` list leaves it out; unknown = could not be asked
// (the machine does not answer, or has no project folder to run in).
export type ProgramState = 'installed' | 'missing' | 'not-allowed' | 'unknown';

// One way to install a program on one system: what to do, and the command to paste into a terminal ('' = none).
export interface InstallWay {
    os: OS;
    text: string;
    command: string;
}

export interface ProgramInfo {
    id: string;              // unique on the page: the name, with the machine for one checked elsewhere ("vps-1:pi")
    name: ProgramName;
    machine: string | null;  // null = this computer; else the machine's name in Preferences → Agents
    state: ProgramState;
    needed: boolean;         // a feature the user chose depends on it; an optional program is never a warning
    version: string;         // the first line of its version output, '' when not known
    path: string;            // where it was found, '' when not
    detail: string;          // why it is missing, not allowed, or unknown
    purpose: string;
    install: InstallWay[];   // for this computer every system (this one first); for a machine, Linux only
    url: string;             // the page with the full instructions
}

export interface ProgramsData {
    machine: string;         // where agents run: '' = in this window, 'local' = markworkd here, else an SSH machine
    machineLabel: string;
    checking: boolean;
    programs: ProgramInfo[];
}

// Home's Set up section: the needed programs that are missing, and a line about the rest.
export interface SetupData {
    items: ProgramInfo[];
    note: string;
    runHere: boolean;        // agents are set to run through markworkd, which is missing: offer to run them in this window
}

export interface ProgramsHost {
    readonly settings: AppSettings;
    connection(machine: string): DaemonConnection;
    machineState(machine: string): { state: ConnectionState; detail: string } | null;
    refresh(): void;         // Home and the Programs page show the new state
    openUri(uri: string): void;
    toast(message: string): void;
    // The lookup, the version runs, and the terminal; tests give their own, the app the platform's.
    readonly processes?: Pick<Processes, 'findProgram' | 'run' | 'openTerminal'>;
}

const CHECK_MS = 10_000;     // a program or a machine that has not answered by then is reported as unknown

const PURPOSE: Record<ProgramName, () => string> = {
    git: () => _('History, pull requests, the agent\'s history tools, and a worktree per card.'),
    pi: () => _('The agent that works on kanban cards: Work on it with pi on a card.'),
    markworkd: () => _('Keeps agents running after the window closes, or runs them on another machine.'),
};

const URL: Record<ProgramName, string> = {
    git: 'https://git-scm.com/downloads',
    pi: 'https://pi.dev',
    markworkd: 'https://github.com/EkaPutCom/markwork/blob/main/markworkd/README.md',
};

const PI_NPM = 'npm install -g @earendil-works/pi-coding-agent';

function ways(name: ProgramName): InstallWay[] {
    switch (name) {
        case 'git': return [
            { os: 'linux', text: _('Install it with the package manager of your system; on Ubuntu or Debian:'), command: 'sudo apt install git' },
            { os: 'darwin', text: _('Install Apple\'s command line tools, which include git:'), command: 'xcode-select --install' },
            { os: 'win32', text: _('Install Git for Windows:'), command: 'winget install --id Git.Git -e' },
        ];
        case 'pi': return (['linux', 'darwin', 'win32'] as const).map(os => ({ os, text: _('Install it with npm (Node.js 22.19 or newer), or follow pi.dev:'), command: PI_NPM }));
        case 'markworkd': return [
            { os: 'linux', text: _('Build it with Go into ~/.local/bin:'), command: 'GOBIN=$HOME/.local/bin go install github.com/EkaPutCom/markwork/markworkd/cmd/markworkd@main' },
        ];
    }
}

// The ways for one place: this computer's system first; a machine runs markworkd, so it is Linux.
export function installWays(name: ProgramName, os: OS | null): InstallWay[] {
    const all = ways(name);
    if (os === null) return all.filter(w => w.os === 'linux');
    return [...all.filter(w => w.os === os), ...all.filter(w => w.os !== os)];
}

// The first line of `--version`, named when it is only a number ("1.0.3" → "pi 1.0.3").
export function versionLine(name: ProgramName, out: string): string {
    const line = out.split('\n').map(l => l.trim()).find(Boolean) ?? '';
    return /^v?\d/.test(line) ? `${name} ${line}` : line;
}

// What a daemon's refusal or a failed run says about a program on that machine.
export function remoteState(run: GitRun | null): { state: ProgramState; detail: string } {
    if (!run) return { state: 'unknown', detail: _('The machine did not answer.') };
    if (run.status === 0) return { state: 'installed', detail: '' };
    if (/is not in the configured programs/.test(run.err)) return { state: 'not-allowed', detail: run.err.trim() };
    if (run.status === 127) return { state: 'missing', detail: run.err.trim() };
    return { state: 'unknown', detail: run.err.trim() || fmt(_('It ended with status {status}.'), { status: run.status }) };
}

const within = <T>(promise: Promise<T>, ms: number, late: T): Promise<T> =>
    new Promise(resolve => {
        const timer = setTimeout(() => resolve(late), ms);
        void promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(late); });
    });

export class ProgramsController {
    private programs: ProgramInfo[] = [];
    private checking: Promise<void> | null = null;
    private checked = false;
    private generation = 0;

    // checkMs: how long a program or a machine has to answer; tests make it short.
    constructor(private readonly host: ProgramsHost, private readonly checkMs = CHECK_MS) {}

    private get machine(): string { return this.host.settings.harnessMachine; }

    private get processes(): Pick<Processes, 'findProgram' | 'run' | 'openTerminal'> { return this.host.processes ?? platform().processes; }

    private machineLabel(machine: string): string { return machine === LOCAL_MACHINE ? _('this computer') : machine; }

    // What the Programs page shows. The first call starts the check; the page is told again when it ends.
    data(): ProgramsData {
        if (!this.checked && !this.checking) void this.check();
        return { machine: this.machine, machineLabel: this.machine ? this.machineLabel(this.machine) : '', checking: this.checking !== null, programs: this.programs };
    }

    // Home's Set up section, or null when nothing needed is missing or the user hid this very list.
    setup(): SetupData | null {
        if (!this.checked && !this.checking) void this.check();
        const items = this.missing();
        if (!items.length || this.signature(items) === this.host.settings.setupHidden) return null;
        const fine = this.programs.filter(p => p.needed && p.state === 'installed').map(p => p.name);
        const optional = this.programs.filter(p => !p.needed && p.state !== 'installed').map(p => p.name);
        const note = fine.length ? fmt(fine.length === 1 ? _('{names} is installed.') : _('{names} are installed.'), { names: fine.join(_(' and ')) })
            : optional.length ? fmt(_('{names} is optional and not shown here.'), { names: optional.join(_(' and ')) }) : '';
        return { items, note, runHere: this.machine === LOCAL_MACHINE && items.some(p => p.name === 'markworkd') };
    }

    get missingCount(): number { return this.missing().length; }

    private missing(): ProgramInfo[] {
        return this.programs.filter(p => p.needed && (p.state === 'missing' || p.state === 'not-allowed'));
    }

    private signature(items: ProgramInfo[]): string {
        return items.map(p => `${p.id}=${p.state}`).sort().join(',');
    }

    // Hide the Set up section until the list of missing programs changes.
    hideSetup(): void {
        this.host.settings.setupHidden = this.signature(this.missing());
        this.host.refresh();
    }

    // Agents back in this window (Preferences → Agents), when markworkd is missing.
    runHere(): void {
        this.host.settings.harnessMachine = '';   // the settings listener checks again
    }

    get wasChecked(): boolean { return this.checked || this.checking !== null; }

    // Coming back to the window after installing something in a terminal: look again while something needed is missing.
    recheckMissing(): void {
        if (this.checked && !this.checking && this.missing().length) void this.check();
    }

    // Look again; a check that is running is not started twice, but one asked for after a settings change starts over.
    check(): Promise<void> {
        const generation = ++this.generation;
        const run = this.collect().then(programs => {
            if (generation !== this.generation) return;
            this.programs = programs;
            this.checked = true;
            this.checking = null;
            this.host.refresh();
        });
        this.checking = run;
        this.host.refresh();
        return run;
    }

    private async collect(): Promise<ProgramInfo[]> {
        const machine = this.machine;
        const os = platform().os;
        if (!isRemoteMachine(machine)) {
            return Promise.all([
                this.local('git', true, os),
                this.local('pi', true, os),
                this.local('markworkd', machine === LOCAL_MACHINE, os),
            ]);
        }
        // Agents on an SSH machine: git stays needed here for History; markworkd, pi and git are checked there.
        return Promise.all([
            this.local('git', true, os),
            this.daemon(machine),
            this.remote(machine, 'pi'),
            this.remote(machine, 'git'),
        ]);
    }

    private info(name: ProgramName, machine: string | null, needed: boolean, os: OS | null): Omit<ProgramInfo, 'state' | 'version' | 'path' | 'detail'> {
        return { id: machine ? `${machine}:${name}` : name, name, machine, needed, purpose: PURPOSE[name](), install: installWays(name, os), url: URL[name] };
    }

    // A program on this computer: the lookup that starts it (PATH, then the user's bin folders), then its version.
    private async local(name: ProgramName, needed: boolean, os: OS): Promise<ProgramInfo> {
        const base = this.info(name, null, needed, os);
        const { processes } = this;
        const path = processes.findProgram(name);
        if (!path) {
            // markworkd may be a service that listens on its socket without being on the PATH.
            const state = name === 'markworkd' ? this.host.machineState(LOCAL_MACHINE) : null;
            if (state?.state === 'ready') return { ...base, state: 'installed', version: '', path: '', detail: _('Running as a service; not found on the PATH.') };
            return { ...base, state: 'missing', version: '', path: '', detail: _('Not found in PATH or in ~/.local/bin.') };
        }
        const run = await within(processes.run({ argv: [path, name === 'markworkd' ? 'version' : '--version'], cwd: platform().paths.homeDir(), timeoutMs: this.checkMs }), this.checkMs + 1000, null);
        const version = run?.status === 0 ? versionLine(name, run.out || run.err) : '';
        return { ...base, state: 'installed', version, path, detail: '' };
    }

    // markworkd on an SSH machine: whether its daemon answers, and its version.
    private async daemon(machine: string): Promise<ProgramInfo> {
        const base = this.info('markworkd', machine, true, null);
        const ask = async () => (await (await this.host.connection(machine).ready()).info()).daemon;
        const version = await within(ask(), this.checkMs, null);
        if (version) return { ...base, state: 'installed', version, path: '', detail: '' };
        const detail = this.host.machineState(machine)?.detail || _('The machine did not answer.');
        // ssh got in, but the shell there has no markworkd to run.
        return { ...base, state: /command not found|No such file or directory/i.test(detail) ? 'missing' : 'unknown', version: '', path: '', detail };
    }

    // pi or git on an SSH machine, run through its daemon in one of the project folders it has there.
    private async remote(machine: string, name: ProgramName): Promise<ProgramInfo> {
        const base = this.info(name, machine, true, null);
        const folder = Object.entries(this.host.settings.machineProjects).find(([key]) => key.startsWith(`${machine}:`))?.[1];
        if (!folder) return { ...base, state: 'unknown', version: '', path: '', detail: fmt(_('Choose a project folder on {machine} first; the check runs there.'), { machine }) };
        const run = await within(daemonRun(this.host.connection(machine), [name, '--version'], folder), this.checkMs, null);
        const { state, detail } = remoteState(run);
        return { ...base, state, version: state === 'installed' && run ? versionLine(name, run.out) : '', path: '', detail };
    }

    // A terminal for installing: on this computer, or logged in to the machine.
    openTerminal(machine: string | null): void {
        const target = machine ? this.host.settings.machines[machine] : null;
        if (machine && (!target || !isValidSshTarget(target))) return;
        const command = target ? ['ssh', '--', target] : null;
        if (!this.processes.openTerminal(platform().paths.homeDir(), command)) this.host.toast(_('No terminal was found on this computer'));
    }

    // The page with a program's full instructions.
    openSite(name: string): void {
        const url = URL[name as ProgramName];
        if (url) this.host.openUri(url);
    }
}
