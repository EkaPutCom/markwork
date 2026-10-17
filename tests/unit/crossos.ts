// What the core does differently per system, as pure functions that run on any of them: where the user's folders are, which
// file names a program may have, and which terminals are tried.

import { posix, win32 } from 'node:path';
import { programNames, userDirs } from '../../src/platform/node/dirs.js';
import { terminals } from '../../src/app/harnessreview.js';
import { section, test, eq } from '../framework.js';

export async function crossOsTests(): Promise<void> {
    section('Per system: folders, programs, terminals');

    await test('user folders: XDG on Linux, ~/Library on macOS, %APPDATA% and %LOCALAPPDATA% on Windows', () => {
        eq(userDirs('linux', {}, '/home/eka', posix.join), { config: '/home/eka/.config', data: '/home/eka/.local/share', runtime: '/home/eka/.cache' });
        eq(userDirs('linux', { XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', XDG_RUNTIME_DIR: '/r' }, '/home/eka', posix.join), { config: '/c', data: '/d', runtime: '/r' });
        eq(userDirs('darwin', {}, '/Users/eka', posix.join), { config: '/Users/eka/Library/Application Support', data: '/Users/eka/Library/Application Support', runtime: '/Users/eka/Library/Caches' });
        eq(userDirs('win32', { APPDATA: 'C:\\Users\\eka\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\eka\\AppData\\Local' }, 'C:\\Users\\eka', win32.join),
            { config: 'C:\\Users\\eka\\AppData\\Roaming', data: 'C:\\Users\\eka\\AppData\\Local', runtime: 'C:\\Users\\eka\\AppData\\Local\\Temp' });
        eq(userDirs('win32', {}, 'C:\\Users\\eka', win32.join).config, 'C:\\Users\\eka\\AppData\\Roaming', 'without the variables');
    });

    await test('program names: a bare name gets each PATHEXT extension on Windows only', () => {
        eq(programNames('linux', 'git', '.EXE'), ['git']);
        eq(programNames('win32', 'git', '.COM;.EXE;.CMD'), ['git', 'git.com', 'git.exe', 'git.cmd']);
        eq(programNames('win32', 'GIT.EXE', '.COM;.EXE'), ['GIT.EXE'], 'it already has one');
        eq(programNames('win32', 'git', undefined), ['git', 'git.com', 'git.exe', 'git.bat', 'git.cmd'], 'the default PATHEXT');
    });

    await test('terminals: GNOME on Linux, Terminal on macOS, Windows Terminal then cmd on Windows', () => {
        eq(terminals('linux', '/w', null)[0], ['kgx', '--working-directory=/w']);
        eq(terminals('linux', '/w', ['ssh', 'h'])[2], ['gnome-terminal', '--', 'ssh', 'h']);
        eq(terminals('win32', 'C:\\w', null), [['wt.exe', '-d', 'C:\\w'], ['cmd.exe', '/c', 'start', '', '/D', 'C:\\w', 'cmd.exe']]);
        eq(terminals('win32', 'C:\\w', ['ssh', 'h'])[0], ['wt.exe', 'ssh', 'h']);
        const mac = terminals('darwin', "/Users/eka/it's", null)[0];
        eq(mac[0], 'osascript');
        eq(mac[2], `tell application "Terminal" to do script "cd '/Users/eka/it'\\\\''s'"`, 'quotes for the shell, then for AppleScript');
    });
}
