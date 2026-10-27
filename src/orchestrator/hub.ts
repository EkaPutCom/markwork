// The connections to the machines where markworkd runs agents: this computer, and the SSH machines the user added.
// A connection is made when something first needs it and kept; the window listens to their state to tell the user
// when a machine cannot be reached.

import type { Link } from '../agent/daemon/client';
import { DaemonConnection, type ConnectionState } from '../agent/daemon/connection';
import { LOCAL_MACHINE, isValidSshTarget } from '../agent/daemon/machines';
import { openCommandLink, openSocketLink, sshBridgeArgv } from '../agent/daemon/streamlink';
import { findProgram } from './index';
import { platform } from '../platform/index';
import { _, fmt } from '../base/i18n';

export { LOCAL_MACHINE };

export interface HubSettings {
    machines(): Record<string, string>;   // name → SSH target
    daemonCommand(): string;              // markworkd on the remote machines; '' = "markworkd"
}

// How links are made; tests replace them.
export interface Openers {
    socket(path: string): Link;
    command(argv: string[]): Link;
}

const REAL: Openers = { socket: openSocketLink, command: openCommandLink };

export function localSocketPath(): string {
    return platform().paths.join(platform().paths.runtimeDir(), 'markworkd', 'markworkd.sock');
}

export class DaemonHub {
    private readonly connections = new Map<string, DaemonConnection>();
    private readonly built = new Map<string, string>();   // what each connection was made from, to notice a change
    private readonly states = new Map<string, { state: ConnectionState; detail: string }>();
    private readonly listeners = new Set<(machine: string, state: ConnectionState, detail: string) => void>();

    constructor(private readonly settings: HubSettings, private readonly openers: Openers = REAL, private readonly find: (program: string) => string | null = findProgram) {}

    // The connection to a machine. Throws an Error with a sentence for the user if the machine is not defined.
    connection(machine: string): DaemonConnection {
        const known = this.connections.get(machine);
        if (known) return known;
        const conn = machine === LOCAL_MACHINE ? this.localConnection() : this.sshConnection(machine);
        conn.onState((state, detail) => {
            this.states.set(machine, { state, detail });
            for (const fn of [...this.listeners]) fn(machine, state, detail);
        });
        this.connections.set(machine, conn);
        this.built.set(machine, this.signature(machine));
        return conn;
    }

    private signature(machine: string): string {
        return machine === LOCAL_MACHINE ? machine : `${this.settings.machines()[machine] ?? ''}|${this.settings.daemonCommand()}`;
    }

    // The settings of the machines changed: a connection made from other values is dropped (the next use makes a new
    // one); the others stay, because runs are being followed through them.
    refresh(): void {
        for (const [machine, signature] of [...this.built]) {
            if (machine !== LOCAL_MACHINE && this.signature(machine) !== signature) this.forget(machine);
        }
    }

    // On this computer: `markworkd bridge` when the program is installed (it starts the daemon if it is not
    // running); otherwise the socket, which a systemd user service or a daemon started by hand listens on. A
    // sandboxed app cannot run the host's programs, so it only has the socket.
    private localConnection(): DaemonConnection {
        const program = this.find('markworkd');
        if (program) return new DaemonConnection({ name: 'markwork', open: () => this.openers.command([program, 'bridge']), expectBridge: true });
        const path = localSocketPath();
        return new DaemonConnection({
            name: 'markwork',
            open: () => {
                try { return this.openers.socket(path); } catch {
                    throw new Error(fmt(_('markworkd is not running on this computer ({path}). Start it with “markworkd start” or its systemd user service.'), { path }));
                }
            },
        });
    }

    private sshConnection(machine: string): DaemonConnection {
        const target = this.settings.machines()[machine];
        if (!target) throw new Error(fmt(_('The machine “{name}” is not defined; add it in Preferences.'), { name: machine }));
        if (!isValidSshTarget(target)) throw new Error(fmt(_('“{target}” is not a valid SSH host.'), { target }));
        const command = this.settings.daemonCommand().trim();
        const argv = sshBridgeArgv({ host: target, remoteCommand: `${command || 'markworkd'} bridge` });
        return new DaemonConnection({ name: 'markwork', open: () => this.openers.command(argv), expectBridge: true });
    }

    // The last known state of a machine's connection; null if there was none yet.
    state(machine: string): { state: ConnectionState; detail: string } | null {
        return this.states.get(machine) ?? null;
    }

    onState(fn: (machine: string, state: ConnectionState, detail: string) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    // The machine's settings changed: the next use makes a new connection.
    forget(machine: string): void {
        this.connections.get(machine)?.dispose();
        this.connections.delete(machine);
        this.built.delete(machine);
        this.states.delete(machine);
    }

    dispose(): void {
        for (const conn of this.connections.values()) conn.dispose();
        this.connections.clear();
    }
}
