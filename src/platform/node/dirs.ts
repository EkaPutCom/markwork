// Where a user's files go on each system, as a pure function of the system, the environment, and the home folder, so the
// three can be tested on one. Linux follows XDG; macOS has ~/Library; Windows has %APPDATA% (roaming settings) and
// %LOCALAPPDATA% (data that stays on the machine).

import type { OS } from '../index.js';

export interface UserDirs { config: string; data: string; runtime: string }

export function userDirs(os: OS, env: Record<string, string | undefined>, home: string, join: (...parts: string[]) => string): UserDirs {
    if (os === 'darwin') {
        const support = join(home, 'Library', 'Application Support');
        return { config: support, data: support, runtime: env.TMPDIR || join(home, 'Library', 'Caches') };
    }
    if (os === 'win32') {
        const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        return { config: env.APPDATA || join(home, 'AppData', 'Roaming'), data: local, runtime: join(local, 'Temp') };
    }
    return {
        config: env.XDG_CONFIG_HOME || join(home, '.config'),
        data: env.XDG_DATA_HOME || join(home, '.local', 'share'),
        runtime: env.XDG_RUNTIME_DIR || env.XDG_CACHE_HOME || join(home, '.cache'),
    };
}

// The file names to try for `name`: on Windows a bare name gets each extension of PATHEXT (git → git.exe, git.cmd), and a
// name that already has one of them is tried as it is.
export function programNames(os: OS, name: string, pathExt: string | undefined): string[] {
    if (os !== 'win32') return [name];
    const exts = (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    return exts.some(e => name.toLowerCase().endsWith(e.toLowerCase())) ? [name] : [name, ...exts.map(e => name + e.toLowerCase())];
}
