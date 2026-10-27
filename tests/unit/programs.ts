// The programs check (app/programs.ts): what is needed follows where agents run, Home's Set up section lists only what is
// needed and missing, hiding it lasts until that list changes, and on an SSH machine pi and git are asked through its daemon.

import { DaemonConnection } from '../../src/agent/daemon/connection';
import { installWays, ProgramsController, remoteState, versionLine, type ProgramsHost } from '../../src/app/programs';
import { platform } from '../../src/platform/index';
import type { RunRequest, RunResult } from '../../src/platform/index';
import type { ConnectionState } from '../../src/agent/daemon/connection';
import { section, test, eq, ok } from '../core/framework';
import { memorySettings } from './appsession';
import { FakeDaemon } from './daemon-fake';

// This computer, as the test says it is: the programs found, what each prints for its version, and the terminals opened.
function machine(found: Record<string, string>) {
    const terminals: (string[] | null)[] = [];
    const runs: string[][] = [];
    const processes = {
        findProgram: (name: string) => found[name] ? `/bin/${name}` : null,
        run: async ({ argv }: RunRequest): Promise<RunResult | null> => {
            runs.push(argv);
            const name = argv[0].replace('/bin/', '');
            return { status: 0, out: `${found[name]}\n`, err: '' };
        },
        openTerminal: (_folder: string, command: string[] | null) => { terminals.push(command); return true; },
    };
    return { processes, terminals, runs, found };
}

function controller(found: Record<string, string>, opts: { daemon?: FakeDaemon; state?: { state: ConnectionState; detail: string } } = {}) {
    const settings = memorySettings();
    const local = machine(found);
    let refreshed = 0;
    const toasts: string[] = [];
    const opened: string[] = [];
    const conns = new Map<string, DaemonConnection>();
    const host: ProgramsHost = {
        settings,
        processes: local.processes,
        connection: name => {
            if (!conns.has(name)) conns.set(name, new DaemonConnection({ open: (opts.daemon ?? new FakeDaemon()).open, name: 'test', backoffMs: [20, 50] }));
            return conns.get(name)!;
        },
        machineState: () => opts.state ?? null,
        refresh: () => { refreshed++; },
        openUri: uri => { opened.push(uri); },
        toast: message => { toasts.push(message); },
    };
    const programs = new ProgramsController(host, 300);
    return { programs, settings, local, toasts, opened, get refreshed() { return refreshed; }, close: () => { for (const c of conns.values()) c.dispose(); } };
}

const states = (c: ProgramsController) => Object.fromEntries(c.data().programs.map(p => [p.id, `${p.state}${p.needed ? '' : ' (optional)'}`]));

export async function programsTests(): Promise<void> {
    section('Programs: the pure parts');

    test('the ways to install put this system first, and a machine gets the Linux way', () => {
        eq(installWays('git', 'darwin').map(w => w.os), ['darwin', 'linux', 'win32']);
        eq(installWays('git', null).map(w => w.os), ['linux']);
        eq(installWays('markworkd', 'win32').map(w => w.os), ['linux'], 'markworkd runs on Linux only');
        ok(installWays('pi', 'linux')[0].command.includes('@earendil-works/pi-coding-agent'), 'pi comes from npm');
    });

    test('a version that is only a number is named', () => {
        eq(versionLine('pi', '1.0.3\n'), 'pi 1.0.3');
        eq(versionLine('git', 'git version 2.43.0\n'), 'git version 2.43.0');
        eq(versionLine('markworkd', '\nmarkworkd 0.1.0\n'), 'markworkd 0.1.0');
        eq(versionLine('pi', ''), '');
    });

    test('what a run through the daemon says about the program', () => {
        eq(remoteState(null).state, 'unknown');
        eq(remoteState({ status: 0, out: 'pi 1.0.3\n', err: '' }).state, 'installed');
        eq(remoteState({ status: 127, out: '', err: 'program "pi" is not in the configured programs' }).state, 'not-allowed');
        eq(remoteState({ status: 127, out: '', err: 'program "pi" was not found in PATH or the per-user bin directories' }).state, 'missing');
        eq(remoteState({ status: 2, out: '', err: '' }).state, 'unknown');
    });

    section('Programs: agents in this window');

    await test('git and pi are needed, markworkd is optional; Home lists only pi', async () => {
        const t = controller({ git: 'git version 2.43.0' });
        await t.programs.check();
        eq(states(t.programs), { git: 'installed', pi: 'missing', markworkd: 'missing (optional)' });
        const git = t.programs.data().programs.find(p => p.name === 'git')!;
        eq([git.version, git.path], ['git version 2.43.0', '/bin/git']);
        eq(t.local.runs.find(a => a[0] === '/bin/git'), ['/bin/git', '--version']);
        const setup = t.programs.setup()!;
        eq(setup.items.map(p => p.name), ['pi']);
        eq(setup.note, 'git is installed.');
        eq(setup.runHere, false);
        eq(t.programs.missingCount, 1);
    });

    await test('everything needed is there: no Set up section, and a missing optional program is no warning', async () => {
        const t = controller({ git: 'git version 2.43.0', pi: '1.0.3' });
        await t.programs.check();
        eq(t.programs.setup(), null);
        eq(t.programs.missingCount, 0);
        eq(t.programs.data().programs.find(p => p.name === 'pi')!.version, 'pi 1.0.3');
    });

    await test('hiding the section lasts until the list of missing programs changes', async () => {
        const t = controller({ git: 'git version 2.43.0' });
        await t.programs.check();
        t.programs.hideSetup();
        eq(t.programs.setup(), null, 'hidden');
        await t.programs.check();
        eq(t.programs.setup(), null, 'still hidden after looking again');
        t.settings.harnessMachine = 'local';
        await t.programs.check();
        eq(t.programs.setup()!.items.map(p => p.name), ['pi', 'markworkd'], 'markworkd became needed: shown again');
    });

    section('Programs: agents through markworkd on this computer');

    await test('markworkd is needed, and Home offers to run the agents in this window instead', async () => {
        const t = controller({ git: 'git version 2.43.0', pi: '1.0.3' });
        t.settings.harnessMachine = 'local';
        await t.programs.check();
        eq(states(t.programs), { git: 'installed', pi: 'installed', markworkd: 'missing' });
        const setup = t.programs.setup()!;
        eq(setup.items.map(p => p.name), ['markworkd']);
        eq(setup.runHere, true);
        eq(setup.note, 'git and pi are installed.');
        t.programs.runHere();
        eq(t.settings.harnessMachine, '');
    });

    await test('markworkd that runs as a service, not on the PATH, counts as installed', async () => {
        const t = controller({ git: 'git version 2.43.0', pi: '1.0.3' }, { state: { state: 'ready', detail: '' } });
        t.settings.harnessMachine = 'local';
        await t.programs.check();
        const markworkd = t.programs.data().programs.find(p => p.name === 'markworkd')!;
        eq(markworkd.state, 'installed');
        ok(markworkd.detail.includes('service'), markworkd.detail);
    });

    section('Programs: agents on an SSH machine');

    await test('markworkd, pi and git are checked there; git stays needed here', async () => {
        const daemon = new FakeDaemon();
        daemon.answer = program => program === 'pi' ? { status: 0, out: '1.0.3' } : null;
        daemon.git = () => ({ status: 0, out: 'git version 2.39.5\n' });
        const t = controller({ git: 'git version 2.43.0' }, { daemon });
        t.settings.machines = { vps: 'me@vps' };
        t.settings.machineProjects = { 'vps:shop': '/srv/shop' };
        t.settings.harnessMachine = 'vps';
        try {
            await t.programs.check();
            eq(states(t.programs), { git: 'installed', 'vps:markworkd': 'installed', 'vps:pi': 'installed', 'vps:git': 'installed' });
            const data = t.programs.data();
            eq(data.machineLabel, 'vps');
            eq(data.programs.find(p => p.id === 'vps:markworkd')!.version, 'markworkd 0.1.0');
            eq(data.programs.find(p => p.id === 'vps:pi')!.version, 'pi 1.0.3');
            eq(data.programs.find(p => p.id === 'vps:git')!.install.map(w => w.os), ['linux']);
            eq(daemon.requestsOf('spawn').map(r => [r.program, r.cwd]), [['pi', '/srv/shop'], ['git', '/srv/shop']]);
            eq(t.programs.setup(), null);
        } finally { t.close(); }
    });

    await test('a program the daemon refuses is not allowed, and one it cannot find is missing there', async () => {
        const daemon = new FakeDaemon();
        daemon.answer = () => ({ refuse: 'program_not_allowed', message: 'program "pi" is not in the configured programs' });
        daemon.git = () => ({ status: 127, err: 'program "git" was not found in PATH' });
        const t = controller({ git: 'git version 2.43.0' }, { daemon });
        t.settings.machines = { vps: 'me@vps' };
        t.settings.machineProjects = { 'vps:shop': '/srv/shop' };
        t.settings.harnessMachine = 'vps';
        try {
            await t.programs.check();
            eq(states(t.programs)['vps:pi'], 'not-allowed');
            const setup = t.programs.setup()!;
            eq(setup.items.map(p => p.id), ['vps:pi', 'vps:git']);
            ok(setup.items[0].detail.includes('configured programs'), setup.items[0].detail);
        } finally { t.close(); }
    });

    await test('without a project folder on the machine, pi and git there are unknown, not missing', async () => {
        const t = controller({ git: 'git version 2.43.0' });
        t.settings.machines = { vps: 'me@vps' };
        t.settings.harnessMachine = 'vps';
        try {
            await t.programs.check();
            eq(states(t.programs)['vps:pi'], 'unknown');
            ok(t.programs.data().programs.find(p => p.id === 'vps:pi')!.detail.includes('project folder'), 'says why');
            eq(t.programs.setup(), null, 'unknown is not a warning');
        } finally { t.close(); }
    });

    await test('a machine that answers ssh without a markworkd is missing it; one that does not answer is unknown', async () => {
        const gone = new FakeDaemon();
        gone.refuse = true;
        const missing = controller({ git: 'git version 2.43.0' }, { daemon: gone, state: { state: 'failed', detail: 'bash: line 1: markworkd: command not found' } });
        const away = controller({ git: 'git version 2.43.0' }, { daemon: gone, state: { state: 'waiting', detail: 'ssh: Could not resolve hostname vps' } });
        for (const t of [missing, away]) { t.settings.machines = { vps: 'me@vps' }; t.settings.harnessMachine = 'vps'; }
        try {
            await Promise.all([missing.programs.check(), away.programs.check()]);
            eq(states(missing.programs)['vps:markworkd'], 'missing');
            eq(missing.programs.setup()!.items.map(p => p.id), ['vps:markworkd']);
            eq(states(away.programs)['vps:markworkd'], 'unknown');
        } finally { missing.close(); away.close(); }
    });

    section('Programs: the actions');

    await test('the terminal opens here, or logged in to the machine; a target ssh would misread opens nothing', async () => {
        const t = controller({});
        t.settings.machines = { vps: 'me@vps', bad: '-oProxyCommand=x' };
        t.programs.openTerminal(null);
        t.programs.openTerminal('vps');
        t.programs.openTerminal('bad');
        t.programs.openTerminal('nowhere');
        eq(t.local.terminals, [null, ['ssh', '--', 'me@vps']]);
        t.programs.openSite('pi');
        t.programs.openSite('rm');
        eq(t.opened, ['https://pi.dev']);
    });

    await test('the real lookup finds git on the machine that runs the tests', async () => {
        // The one check against the real platform: the controller's default is platform().processes.
        if (!platform().processes.findProgram('git')) return;
        const t = controller({});
        const programs = new ProgramsController({ settings: t.settings, connection: () => { throw new Error('no daemon'); }, machineState: () => null, refresh: () => {}, openUri: () => {}, toast: () => {} });
        await programs.check();
        const git = programs.data().programs.find(p => p.name === 'git')!;
        eq(git.state, 'installed');
        ok(git.version.startsWith('git version'), git.version);
    });
}
