// Preferences: PreferencesController (app/preferences.ts) in an AppSession, with a view that records what it
// is sent. The dialog only reports a key and a value; what may be written, and what goes with a removed machine, is the
// core's.

import { AppSession } from '../../src/app/session.js';
import type { MachineDraft, PreferencesData, PreferencesView } from '../../src/app/preferences.js';
import type { ProjectPage, WorktreeList } from '../../src/app/projects.js';
import type { Question } from '../../src/app/dialogs.js';
import { runGit } from '../../src/git.js';
import { section, test, eq, ok, within, until, tmp, disk, slash } from '../framework.js';
import { host as testHost } from '../host.js';
import { fakeFrontend, memorySettings, quiet } from './appsession.js';

export async function preferencesTests(): Promise<void> {
    section('Preferences in the application session');
    const setup = (preset: (s: ReturnType<typeof memorySettings>) => void = () => {}) => {
        const settings = memorySettings();
        preset(settings);
        const opened: PreferencesData[] = [];
        const updates: PreferencesData[] = [];
        const view = quiet<PreferencesView>({ open: d => { opened.push(d); }, showValues: d => { updates.push(d); } });
        const answers: (MachineDraft | null)[] = [];
        const taken: string[][] = [];
        const session = new AppSession(fakeFrontend(settings, [], undefined, { preferencesView: view }));
        Object.assign(session.preferences.dialogs, { machine: async (t: string[]) => { taken.push(t); return answers.shift() ?? null; } });
        session.start();
        return { settings, session, view, opened, updates, answers, taken };
    };

    await test('the dialog opens with every value as plain data, and the choices of where agents run', () => {
        const { session, opened } = setup(s => { s.machines = { vps: 'eka@vps.example.com' }; s.dark = null; s.forgePollSeconds = 60; s.chatModel = 'deepseek-flash'; });
        session.preferences.open();
        const [data] = opened;
        eq(JSON.parse(JSON.stringify(data)), data, 'not plain data');
        eq([data.colorScheme, data.forgePollSeconds >= 30, data.chatModels.includes(data.chatModel)], ['system', true, true]);
        eq(data.machineChoices.map(c => c.value), ['', 'local', 'vps']);
        eq(data.machines, [{ name: 'vps', target: 'eka@vps.example.com' }]);
        session.dispose();
    });

    await test('a change from the dialog writes the setting, and the dialog is sent the values again while it is open', () => {
        const { settings, session, view, updates } = setup();
        view.onSet('focus', true);
        eq(updates.length, 0, 'closed: nothing is sent');
        session.preferences.open();
        view.onSet('focus', true);
        view.onSet('colorScheme', 'dark');
        view.onSet('forgePollSeconds', 120);
        view.onSet('chatModel', 'deepseek-v4-pro');
        eq([settings.focus, settings.dark, settings.forgePollSeconds, settings.chatModel], [true, true, 120, 'deepseek-v4-pro']);
        eq([updates.at(-1)!.colorScheme, updates.at(-1)!.forgePollSeconds], ['dark', 120]);
        settings.typewriter = true;   // changed elsewhere: the menu, another window
        ok(updates.at(-1)!.typewriter, 'the dialog follows');
        session.preferences.closed();
        const count = updates.length;
        settings.typewriter = false;
        eq(updates.length, count, 'closed again');
        session.dispose();
    });

    await test('a key or value the dialog does not have is refused', () => {
        const { settings, session } = setup();
        const { preferences } = session;
        const before = JSON.stringify(preferences.data());
        const refused = [
            preferences.set('tabs' as never, 'x'), preferences.set('__proto__' as never, true), preferences.set('constructor' as never, true),
            preferences.set('focus', 'yes'), preferences.set('colorScheme', 'purple'), preferences.set('chatModel', 'gpt'),
            preferences.set('forgePollSeconds', 5), preferences.set('forgePollSeconds', 61.5), preferences.set('forgePollSeconds', '60'),
            preferences.set('harnessMachine', 'nowhere'), preferences.set('daemonCommand', 3),
        ];
        eq(refused, refused.map(() => false));
        eq(JSON.stringify(preferences.data()), before, 'nothing changed');
        eq(settings.tabs, [], 'tabs untouched');
        ok(preferences.set('daemonCommand', 'markworkd'), 'a string command');
        session.dispose();
    });

    await test('a machine is added once its name and host are valid and not taken', async () => {
        const { settings, session, view, answers, taken } = setup(s => { s.machines = { vps: 'a@b' }; });
        answers.push({ name: 'nas', target: 'nas.local' });
        await view.onAddMachine();
        eq(taken, [['vps']], 'the dialog is told the names in use');
        eq(settings.machines, { vps: 'a@b', nas: 'nas.local' });
        for (const bad of [{ name: 'vps', target: 'x' }, { name: 'local', target: 'x' }, { name: 'a b', target: 'x' }, { name: 'ok', target: '-oProxyCommand=x' }, null]) {
            answers.push(bad);
            await view.onAddMachine();
        }
        eq(Object.keys(settings.machines), ['vps', 'nas'], 'refused ones');
        session.dispose();
    });

    await test('removing a machine forgets the choice of where agents run and its project folders; other machines are kept', () => {
        const { settings, session, view } = setup(s => {
            s.machines = { vps: 'a@b', nas: 'nas' };
            s.harnessMachine = 'nas';
            s.machineProjects = { 'vps:shop': '/srv/shop', 'nas:shop': '/data/shop' };
        });
        view.onRemoveMachine('nas');
        eq(Object.keys(settings.machines), ['vps']);
        eq(settings.harnessMachine, '');
        eq(settings.machineProjects, { 'vps:shop': '/srv/shop' });
        view.onRemoveMachine('ghost');
        eq(Object.keys(settings.machines), ['vps'], 'an unknown name changes nothing');
        session.dispose();
    });

    // A repository with one card worktree, and a session whose preferences are open on it.
    const gitIn = async (cwd: string, ...args: string[]): Promise<string> => {
        const run = await within(runGit(cwd, args));
        if (run?.status !== 0) throw new Error(`git ${args.join(' ')}: ${run?.err}`);
        return run.out.trim();
    };
    let n = 0;
    const projectSetup = async () => {
        for (const [name, value] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com' })) testHost().setenv(name, value);
        const parent = disk.join(tmp, `projects-${++n}`);
        const repo = disk.join(parent, 'shop');
        disk.mkdirs(repo);
        await gitIn(repo, 'init', '-q', '-b', 'main');
        disk.write(disk.join(repo, 'a.txt'), 'a\n');
        await gitIn(repo, 'add', '-A');
        await gitIn(repo, 'commit', '-q', '-m', 'First');
        // Git lists a worktree by its real path (macOS keeps /var/folders behind the symlink /private/var).
        const realParent = disk.dirname(await gitIn(repo, 'rev-parse', '--show-toplevel'));
        const wt = disk.join(realParent, '.markwork-worktrees', 'shop', 'fix-login');
        await gitIn(repo, 'worktree', 'add', '-q', '-b', 'markwork/fix-login', wt);
        const pages: ProjectPage[] = [];
        const lists: WorktreeList[] = [];
        const removals: string[] = [];
        const answers = { remove: true };
        const settings = memorySettings();
        settings.harnessMachine = '';
        settings.projects = { shop: repo };
        const view = quiet<PreferencesView>({ showProject: p => { pages.push(p); }, showWorktrees: l => { lists.push(l); } });
        const session = new AppSession(fakeFrontend(settings, [], undefined, { preferencesView: view }));
        // The question is the core's: the branch is named in its sentence.
        Object.assign(session.preferences.dialogs, { removeWorktree: async (q: Question) => { removals.push(q.message.match(/of (\S+)\?$/)?.[1] ?? q.message); return answers.remove; } });
        session.start();
        return { session, settings, view, pages, lists, removals, answers, repo, wt };
    };

    await test('the Projects group is sent as plain rows; a project\'s page and its card worktrees follow when it is chosen', async () => {
        const { session, view, pages, lists, repo, wt } = await projectSetup();
        eq(session.preferences.data().projects, [{ name: 'shop', folder: repo, worktrees: true }]);
        view.onOpenProject('ghost');
        eq(pages.length, 0, 'a project that is not one');
        view.onOpenProject('shop');
        eq([pages[0].name, pages[0].folder, pages[0].remote, pages[0].isolation.slots, pages[0].branchPrefix], ['shop', repo, false, 2, 'markwork/']);
        eq(JSON.parse(JSON.stringify(pages[0])), pages[0], 'not plain data');
        await until(() => lists.some(l => !l.loading));
        eq(lists[0].loading, true, 'first "looking"');
        eq(lists.at(-1)!.items.map(w => ({ ...w, path: slash(w.path) })), [{ branch: 'markwork/fix-login', path: slash(wt) }]);
        session.dispose();
    });

    await test('a change to a project is checked before it is written; a field that is not an isolation setting is left out', async () => {
        const { session, settings, view } = await projectSetup();
        const stored = () => JSON.parse(settings.projectOptions.shop ?? '{}');
        eq(await view.onSetProject('shop', { slots: 3 }), null);
        eq(stored().slots, 3);
        for (const bad of [{ slots: 99 }, { slots: 1.5 }, { slots: 0 }, { dir: 'relative/path' }, { afterMerge: 'bogus' as never }, { worktrees: 'yes' as never }, { base: 3 as never }]) {
            ok(await view.onSetProject('shop', bad) !== null, JSON.stringify(bad));
        }
        eq(stored().slots, 3, 'nothing else was written');
        ok(await view.onSetProject('ghost', { slots: 2 }) !== null, 'an unknown project');
        eq(await view.onSetProject('shop', { base: 'main', evil: 1 } as never), null);
        eq(Object.keys(stored()).sort(), ['afterMerge', 'base', 'dir', 'slots', 'worktrees'], 'only isolation settings');
        eq(await view.onSetProject('shop', { dir: '/srv/trees', worktrees: false }), null);
        eq([stored().dir, stored().worktrees], ['/srv/trees', false]);
        session.dispose();
    });

    await test('removing a worktree: only one the core listed, only after asking, then the list is sent again', async () => {
        const { session, view, lists, removals, answers, repo, wt } = await projectSetup();
        view.onOpenProject('shop');
        await until(() => lists.some(l => !l.loading));
        ok(await view.onRemoveWorktree('shop', repo) !== null, 'the project folder itself is not a card worktree');
        ok(await view.onRemoveWorktree('shop', '/etc') !== null, 'a path that was not listed');
        eq(removals, [], 'no question for those');
        answers.remove = false;
        eq(await view.onRemoveWorktree('shop', wt), null);
        eq([removals, disk.exists(wt)], [['markwork/fix-login'], true], 'asked, declined, kept');
        answers.remove = true;
        eq(await view.onRemoveWorktree('shop', wt), null);
        eq(disk.exists(wt), false, 'the worktree folder is gone');
        eq(lists.at(-1)!.items, [], 'the list was read again');
        eq(await gitIn(repo, 'branch', '--list', 'markwork/*'), '', 'with its branch');
        session.dispose();
    });
}
