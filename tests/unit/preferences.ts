// Preferences without GTK: PreferencesController (app/preferences.ts) in an AppSession, with a view that records what it
// is sent. The dialog only reports a key and a value; what may be written, and what goes with a removed machine, is the
// core's. Runs on GJS and on Node.

import { AppSession } from '../../src/app/session.js';
import type { MachineDraft, PreferencesData, PreferencesView } from '../../src/app/preferences.js';
import { section, test, eq, ok } from '../framework.js';
import { fakeFrontend, memorySettings, quiet } from './appsession.js';

export async function preferencesTests(): Promise<void> {
    section('Preferences in the application session (no GTK)');
    const setup = (preset: (s: ReturnType<typeof memorySettings>) => void = () => {}) => {
        const settings = memorySettings();
        preset(settings);
        const opened: PreferencesData[] = [];
        const updates: PreferencesData[] = [];
        const view = quiet<PreferencesView>({ open: d => { opened.push(d); }, showValues: d => { updates.push(d); } });
        const answers: (MachineDraft | null)[] = [];
        const taken: string[][] = [];
        const session = new AppSession(fakeFrontend(settings, [], undefined, { preferencesView: view }));
        Object.assign(session.preferences.dialogs, { machine: (t: string[]) => { taken.push(t); return answers.shift() ?? null; } });
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
}
