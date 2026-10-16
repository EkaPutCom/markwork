// Settings tests: GSettings with the memory backend, and the typed AppSettings on a plain in-memory store.

import { AppSettings } from '../../src/settings.js';
import type { SettingValue, SettingsStore } from '../../src/platform/index.js';
import { section, test, eq, ok } from '../framework.js';
import { inMemorySettings } from '../../src/platform/gjs/settings.js';

export function settingsTests(): void {
    section('Settings');
    test('default values match the schema', () => {
        const s = inMemorySettings();
        eq(s.focus, false, 'focus');
        eq(s.autosave, true, 'autosave');
        eq(s.dark, null, 'dark = follow the system');
        eq(s.folder, null, 'folder');
        eq(s.tabs, [], 'tabs');
        eq(s.projects, {}, 'projects');
        eq(s.sidebarPage, 'files', 'sidebarPage');
        eq(s.activeTab, -1, 'activeTab');
        eq(s.home, true, 'home');
        eq(s.recentFiles, [], 'recentFiles');
        eq([s.harnessMachine, s.machines, s.machineProjects, s.daemonCommand], ['', {}, {}, ''], 'where harnesses run: in this window, no machines');
    });
    test('settings are written and read back, including compound types', () => {
        const s = inMemorySettings();
        s.focus = true;
        s.dark = false;
        s.folder = '/tmp/project';
        s.tabs = [{ file: '/tmp/a.md', cursor: 7 }, { file: '/tmp/b.md', cursor: 0 }];
        s.projects = { shop: '/tmp/shop' };
        s.sidebarPage = 'collab';
        s.recentFiles = [{ path: '/tmp/a.md', time: 1791360000 }];
        eq(s.recentFiles, [{ path: '/tmp/a.md', time: 1791360000 }], 'recentFiles');
        eq(s.focus, true, 'focus');
        eq(s.dark, false, 'dark');
        eq(s.folder, '/tmp/project', 'folder');
        eq(s.tabs, [{ file: '/tmp/a.md', cursor: 7 }, { file: '/tmp/b.md', cursor: 0 }], 'tabs');
        eq(s.projects, { shop: '/tmp/shop' }, 'projects');
        eq(s.sidebarPage, 'collab', 'sidebarPage');
        Object.assign(s, { harnessMachine: 'vps', machines: { vps: 'eka@vps.example.com' }, machineProjects: { 'vps:shop': '/srv/shop' }, daemonCommand: '~/.local/bin/markworkd' });
        eq([s.harnessMachine, s.machines, s.machineProjects, s.daemonCommand], ['vps', { vps: 'eka@vps.example.com' }, { 'vps:shop': '/srv/shop' }, '~/.local/bin/markworkd'], 'machines');
        s.dark = null;
        s.folder = null;
        eq(s.dark, null, 'dark goes back to the system');
        eq(s.folder, null, 'empty folder');
    });
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
    test('GSettings refuses a key that is not in the schema', () => {
        let threw = false;
        try { inMemorySettings().store.set('no-such-key', true); } catch (e) { threw = true; }
        ok(threw, 'unknown key accepted');
    });
}
