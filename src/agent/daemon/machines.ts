// What the user types to define a machine: a name, and an SSH host. Pure, so it can be checked wherever it is read.

// The machine name that means the daemon on this computer; the others are names the user gave to SSH machines.
export const LOCAL_MACHINE = 'local';

export const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,30}$/;

export function isValidMachineName(name: string): boolean {
    return MACHINE_NAME.test(name) && name !== LOCAL_MACHINE;
}

// A host that ssh would take for an option (-oProxyCommand=...) must never be passed on, and a name with spaces is
// not a host. The `--` in sshBridgeArgv guards the same thing a second time.
export function isValidSshTarget(target: string): boolean {
    return /^[A-Za-z0-9_.][A-Za-z0-9_.@:%-]*$/.test(target);
}

// Agents on another machine run in folders of that machine, which this computer cannot browse.
export const isRemoteMachine = (machine: string): boolean => machine !== '' && machine !== LOCAL_MACHINE;

// Where a project's folder is remembered for a machine.
export const machineProjectKey = (machine: string, project: string): string => `${machine}:${project}`;
