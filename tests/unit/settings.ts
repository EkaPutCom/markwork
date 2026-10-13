// Settings tests (GSettings with the memory backend).

import { AppSettings } from '../../src/settings.js';
import { section, test, eq } from '../framework.js';

export function settingsTests(): void {
    section('Settings');
    test('default values match the schema', () => {
        const s = AppSettings.inMemory();
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
    });
    test('settings are written and read back, including compound types', () => {
        const s = AppSettings.inMemory();
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
        s.dark = null;
        s.folder = null;
        eq(s.dark, null, 'dark goes back to the system');
        eq(s.folder, null, 'empty folder');
    });
}
