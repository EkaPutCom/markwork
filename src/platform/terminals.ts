// The terminals a system may have, in the order to try them, and the walk that opens the first one that is installed. Both
// ports use it (they only say how a program is found and started), so the list is written once; a frontend that has a
// terminal of its own never calls it. Imports only the contract.

import type { OS, Processes } from './index';

// Each candidate is an argv: a folder to start in, or a command to run (ssh to the agents' machine). Linux has the GNOME
// ones; macOS has Terminal; Windows has Windows Terminal, then a console window of cmd.
export function terminals(os: OS, folder: string, command: string[] | null): string[][] {
    if (os === 'darwin') {
        const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
        const script = command ? command.map(quote).join(' ') : `cd ${quote(folder)}`;
        const apple = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return [['osascript', '-e', `tell application "Terminal" to do script "${apple}"`, '-e', 'tell application "Terminal" to activate']];
    }
    if (os === 'win32') {
        return command
            ? [['wt.exe', ...command], ['cmd.exe', '/c', 'start', '', ...command]]
            : [['wt.exe', '-d', folder], ['cmd.exe', '/c', 'start', '', '/D', folder, 'cmd.exe']];
    }
    return command
        ? [['kgx', '--', ...command], ['ptyxis', '--', ...command], ['gnome-terminal', '--', ...command], ['xdg-terminal-exec', ...command]]
        : [['kgx', `--working-directory=${folder}`], ['ptyxis', `--working-directory=${folder}`], ['gnome-terminal', `--working-directory=${folder}`], ['xdg-terminal-exec', `--dir=${folder}`]];
}

// Starts the first candidate whose program is installed and lets it run on its own; false when none could be started.
export function openFirstTerminal(os: OS, processes: Pick<Processes, 'findProgram' | 'launch'>, folder: string, command: string[] | null): boolean {
    return terminals(os, folder, command).some(argv => processes.findProgram(argv[0]) !== null && processes.launch(argv));
}
