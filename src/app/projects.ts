// Preferences → Agents → Projects in the application layer: the projects the agents work on (on the machine they run on),
// and for each one how its cards are isolated (a worktree per card, how many at a time, the base branch, where the
// worktrees go, what happens after a merge) and the card worktrees that exist now. The dialog draws what it is sent and
// reports what the user did; a worktree it names is one the core listed for that project, and a change is checked here.

import { isRemoteMachine, machineProjectKey } from '../agent/daemon/machines.js';
import { BRANCH_PREFIX, listWorktrees, MAX_SLOTS, parseIsolation, removeWorktree, worktreeRoot, writeIsolation, type Isolation } from '../agent/worktree.js';
import type { GitRunner } from '../forge/contribute.js';
import type { AppSettings } from '../settings.js';
import { _ } from '../i18n.js';
import type { Awaitable } from '../awaitable.js';

// What the Projects page needs from the harness controller.
export interface ProjectsAccess {
    readonly machine: string;              // '' or 'local' = this computer, else an SSH machine
    readonly git: GitRunner;               // git where the project folders are
    projectKey(project: string): string;   // the project's key in the settings
}

export const AFTER_MERGE: Isolation['afterMerge'][] = ['remove', 'keep-branch'];

// One row of the group.
export interface ProjectRow {
    name: string;
    folder: string;
    worktrees: boolean;     // a worktree per card
}

// The page of one project.
export interface ProjectPage {
    name: string;
    folder: string;
    machine: string;        // where the folder is: a machine's name, or "this computer"
    remote: boolean;
    isolation: Isolation;
    defaultDir: string;     // where the worktrees go when `dir` is empty
    maxSlots: number;
    branchPrefix: string;
}

export interface WorktreeRow {
    branch: string;
    path: string;
}

// The card worktrees of a project; loading = git is being asked, error = why it could not be read or a removal failed.
export interface WorktreeList {
    project: string;
    loading: boolean;
    items: WorktreeRow[];
    error: string;
}

// The projects of the machine agents run on, as name → folder.
export function machineProjects(settings: AppSettings, machine: string): Record<string, string> {
    if (!isRemoteMachine(machine)) return settings.projects;
    const prefix = machineProjectKey(machine, '');
    return Object.fromEntries(Object.entries(settings.machineProjects).filter(([key]) => key.startsWith(prefix)).map(([key, folder]) => [key.slice(prefix.length), folder]));
}

export interface ProjectsDialogs {
    removeWorktree(branch: string): Awaitable<boolean>;   // "Remove the worktree of {branch}?"
}

export class ProjectsPages {
    private readonly listed = new Map<string, WorktreeRow[]>();   // project → the worktrees last sent

    constructor(private readonly settings: AppSettings, private readonly access: ProjectsAccess, readonly dialogs: ProjectsDialogs,
                private readonly sendWorktrees: (list: WorktreeList) => void) {}

    rows(): ProjectRow[] {
        return Object.entries(machineProjects(this.settings, this.access.machine)).map(([name, folder]) => ({
            name, folder, worktrees: this.isolation(name).worktrees,
        }));
    }

    private isolation(name: string): Isolation {
        return parseIsolation(this.settings.projectOptions[this.access.projectKey(name)]);
    }

    private folderOf(name: string): string | undefined {
        return Object.hasOwn(machineProjects(this.settings, this.access.machine), name) ? machineProjects(this.settings, this.access.machine)[name] : undefined;
    }

    // The page of a project the dialog was shown; null for a name that is not one.
    page(name: string): ProjectPage | null {
        const folder = this.folderOf(name);
        if (folder === undefined) return null;
        const remote = isRemoteMachine(this.access.machine);
        return {
            name, folder, machine: remote ? this.access.machine : _('this computer'), remote, isolation: this.isolation(name),
            defaultDir: worktreeRoot(folder), maxSlots: MAX_SLOTS, branchPrefix: BRANCH_PREFIX,
        };
    }

    // Change some of a project's isolation settings. An error message, or null once written; nothing is written on an error.
    set(name: string, patch: Partial<Isolation>): string | null {
        if (this.folderOf(name) === undefined) return 'there is no such project';
        const bad = this.problem(patch);
        if (bad) return bad;
        const key = this.access.projectKey(name);
        const known: Partial<Isolation> = {};
        for (const field of ['worktrees', 'slots', 'base', 'dir', 'afterMerge'] as const) if (field in patch) Object.assign(known, { [field]: patch[field] });
        this.settings.projectOptions = { ...this.settings.projectOptions, [key]: writeIsolation({ ...this.isolation(name), ...known }) };
        return null;
    }

    private problem(patch: Partial<Isolation>): string | null {
        if ('worktrees' in patch && typeof patch.worktrees !== 'boolean') return 'worktrees is a switch';
        if ('slots' in patch && !(Number.isInteger(patch.slots) && patch.slots! >= 1 && patch.slots! <= MAX_SLOTS)) return `cards at the same time: 1 to ${MAX_SLOTS}`;
        if ('base' in patch && typeof patch.base !== 'string') return 'the base branch is a name';
        if ('dir' in patch && (typeof patch.dir !== 'string' || (patch.dir !== '' && !patch.dir.startsWith('/')))) return _('The worktree folder must be an absolute path');
        if ('afterMerge' in patch && !AFTER_MERGE.includes(patch.afterMerge!)) return 'after merging: remove or keep the branch';
        return null;
    }

    // Read the project's card worktrees from git and send them: first "loading", then the list.
    async load(name: string): Promise<void> {
        const folder = this.folderOf(name);
        if (folder === undefined) return;
        this.sendWorktrees({ project: name, loading: true, items: this.listed.get(name) ?? [], error: '' });
        const listed = (await listWorktrees(this.access.git, folder)).filter(w => w.branch?.startsWith(BRANCH_PREFIX));
        const items = listed.map(w => ({ branch: w.branch ?? '', path: w.path }));
        this.listed.set(name, items);
        this.sendWorktrees({ project: name, loading: false, items, error: '' });
    }

    // Remove a worktree the core listed, with its branch, after asking. An error message, or null.
    async remove(name: string, path: string): Promise<string | null> {
        const folder = this.folderOf(name);
        const wt = this.listed.get(name)?.find(w => w.path === path);
        if (folder === undefined || !wt) return 'that worktree is not one of this project';
        if (!await this.dialogs.removeWorktree(wt.branch)) return null;
        const done = await removeWorktree(this.access.git, { path: wt.path, cwd: wt.path, branch: wt.branch, base: '', baseCommit: '', repo: folder });
        if (!done.ok) {
            this.sendWorktrees({ project: name, loading: false, items: this.listed.get(name) ?? [], error: done.message });
            return done.message;
        }
        await this.load(name);
        return null;
    }
}
