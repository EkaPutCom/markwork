// The typed settings (settings.ts AppSettings) on a plain in-memory store: what every frontend's store sits under.

import { AppSettings } from '../../src/settings.js';
import type { SettingValue, SettingsStore } from '../../src/platform/index.js';
import { section, test, eq } from '../framework.js';

export function appSettingsTests(): void {
    section('Settings: AppSettings on any store');
    test('AppSettings needs only a SettingsStore: typed values, and onChanged hears only the keys it asks for', () => {
        const values = new Map<string, SettingValue>([['color-scheme', 'system'], ['tabs', []], ['machines', {}], ['width', 0]]);
        const listeners = new Set<(key: string) => void>();
        const store: SettingsStore = {
            get: key => values.get(key)!,
            set: (key, value) => { values.set(key, value); for (const l of listeners) l(key); },
            onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        };
        const s = new AppSettings(store);
        const heard: string[] = [];
        const stop = s.onChanged(['machines'], key => heard.push(key));
        s.dark = true;
        s.width = 801.6;
        s.tabs = [{ file: '/a.md', cursor: 3 }];
        s.machines = { vps: 'eka@vps' };
        eq([values.get('color-scheme'), values.get('width'), values.get('tabs')], ['dark', 802, [['/a.md', 3]]]);
        eq(heard, ['machines']);
        s.machines.extra = 'x';   // a copy: changing it does not write behind the store's back
        eq(s.machines, { vps: 'eka@vps' });
        stop();
        s.machines = {};
        eq(heard, ['machines']);
    });
    test('projects belong to the work folder; a folder seen for the first time starts with the earlier ones', () => {
        const values = new Map<string, SettingValue>([['projects', { shop: '/srv/shop' }], ['project-options', { shop: 'w1' }], ['machine-projects', {}]]);
        const store: SettingsStore = { get: key => values.get(key)!, set: (key, value) => { values.set(key, value); }, onChanged: () => () => {} };
        const s = new AppSettings(store);
        eq(s.projects, { shop: '/srv/shop' }, 'no folder: the earlier projects');
        s.useWorkspace('/w/a');
        eq([s.projects, s.projectOptions], [{ shop: '/srv/shop' }, { shop: 'w1' }], 'first time: a copy of the earlier ones');
        s.projects = { ...s.projects, api: '/srv/api' };
        s.useWorkspace('/w/b');
        eq(s.projects, { shop: '/srv/shop' }, 'another folder does not see the first one\'s project');
        s.projects = {};
        s.useWorkspace('/w/a');
        eq(s.projects, { shop: '/srv/shop', api: '/srv/api' }, 'back in the first folder, its projects are kept');
        s.useWorkspace('/w/b');
        eq(s.projects, {}, 'an emptied list stays empty, it is not seeded again');
        s.useWorkspace(null);
        eq(s.projects, { shop: '/srv/shop' }, 'without a folder the earlier projects are untouched');
    });
}
