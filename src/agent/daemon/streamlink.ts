// Links to a markworkd: a Unix socket (the daemon on this machine) or the stdio of a command (`ssh host markworkd
// bridge`, or `markworkd bridge` itself). The descriptors are the platform's (platform/node/links.ts); what
// stays here is how the SSH bridge is reached.

import { platform } from '../../platform/index';
import type { Link } from './client';

// Connects to a daemon listening on a Unix socket on this machine. Throws if nobody listens there.
export const openSocketLink = (path: string): Link => platform().links.socket(path);

// Runs a command and talks over its stdin and stdout. The link ends when the command does; its stderr tail is the
// reason, so "Permission denied" from ssh reaches the user.
export const openCommandLink = (argv: string[]): Link => platform().links.command(argv);

export interface SshTarget {
    host: string;                  // a name from ~/.ssh/config, or user@host
    remoteCommand?: string;        // default "markworkd bridge"; give a full path if it is not on the non-interactive PATH
    options?: string[];            // extra ssh arguments, e.g. ['-p', '2222', '-i', '/path/key']
}

// The command that reaches a remote daemon: `ssh -T host markworkd bridge`. BatchMode makes a missing key or
// passphrase fail at once instead of waiting for a terminal this app does not have; the keep-alive notices a link
// that died without a clean close.
export function sshBridgeArgv(t: SshTarget): string[] {
    return [
        'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
        ...(t.options ?? []), '--', t.host, t.remoteCommand ?? 'markworkd bridge',
    ];
}
