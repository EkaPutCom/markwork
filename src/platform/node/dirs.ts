// Where a user's files go on each system, as a pure function of the system, the environment, and the home folder, so the
// three can be tested on one. Linux follows XDG; macOS has ~/Library; Windows has %APPDATA% (roaming settings) and
// %LOCALAPPDATA% (data that stays on the machine).

import type { OS } from '../index.js';

export interface UserDirs { config: string; data: string; runtime: string }

// XDG_CONFIG_HOME and XDG_DATA_HOME win on macOS and Windows too: nothing sets them there, so one that is set was meant
// (a test run keeps its settings apart that way on every system).
export function userDirs(os: OS, env: Record<string, string | undefined>, home: string, join: (...parts: string[]) => string): UserDirs {
    if (os === 'darwin') {
        const support = join(home, 'Library', 'Application Support');
        return { config: env.XDG_CONFIG_HOME || support, data: env.XDG_DATA_HOME || support, runtime: env.TMPDIR || join(home, 'Library', 'Caches') };
    }
    if (os === 'win32') {
        const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
        return { config: env.XDG_CONFIG_HOME || env.APPDATA || join(home, 'AppData', 'Roaming'), data: env.XDG_DATA_HOME || local, runtime: join(local, 'Temp') };
    }
    return {
        config: env.XDG_CONFIG_HOME || join(home, '.config'),
        data: env.XDG_DATA_HOME || join(home, '.local', 'share'),
        runtime: env.XDG_RUNTIME_DIR || env.XDG_CACHE_HOME || join(home, '.cache'),
    };
}

// Whether two paths name the same place (Paths.same): resolved, then compared ignoring case where the system does.
export function samePath(os: OS, a: string, b: string, resolve: (path: string) => string): boolean {
    const x = resolve(a), y = resolve(b);
    return os === 'linux' ? x === y : x.toLowerCase() === y.toLowerCase();
}

// The file names to try for `name`: on Windows a bare name gets each extension of PATHEXT (git → git.exe, git.cmd), and a
// name that already has one of them is tried as it is.
export function programNames(os: OS, name: string, pathExt: string | undefined): string[] {
    if (os !== 'win32') return [name];
    const exts = (pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    return exts.some(e => name.toLowerCase().endsWith(e.toLowerCase())) ? [name] : [name, ...exts.map(e => name + e.toLowerCase())];
}
