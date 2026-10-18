// The data behind the Home tab (recent files, due tasks, agent runs, inboxes, today's journal) and the actions
// taken from it. Everything is recomputed from the files on every render.

import { fileExists, insideName } from '../files.js';
import { platform } from '../platform/index.js';
import type { AppSettings } from '../settings.js';
import type { WorkspaceRepository } from '../workspace.js';
import type { ConnectionState } from '../agent/daemon/connection.js';
import { cardProject, isActive, type Run, type RunStatus } from '../agent/harness.js';
import { dueTasks, localDate, openInboxes, splitRecent, type InboxCount, type RecentFile, type Task } from '../markdown/home.js';
import { isStructured } from '../markdown/layout.js';
import { updateCard, type Board } from '../markdown/kanban.js';
import { _, fmt } from '../i18n.js';
import type { DocumentHost } from './document.js';

// The Continue cards fill a full row in a wide window; in a narrow window the frontend folds them.
export const RESUME_CARDS = 3;

// The recent files that still exist. With a work folder, only its files: another workspace's files do not belong in its
// Home or its Recent menu.
export function existingRecent(files: readonly RecentFile[], root: string | null): RecentFile[] {
    return files.filter(r => (!root || insideName(root, r.path) !== null) && fileExists(r.path) && !platform().fs.isDirectory(r.path));
}

// One file in a Continue card or in the Recent files list.
export interface HomeEntry {
    path: string;
    title: string;      // card: folder name; list: file name
    subtitle: string;   // card: file name; list: relative folder
    time: number;       // Unix seconds
}

export interface HomeRun {
    id: number;
    agent: string;
    title: string;
    status: RunStatus;
}

// The machine agents run on (not shown when they run as children of this window), and whether it can be reached.
export interface HomeAgentHost {
    label: string;
    state: ConnectionState;
    detail: string;
}

export interface HomeJournal {
    exists: boolean;    // today's journal file already exists
    notes: number;      // bullets in the Notes section
    activity: number;   // activities recorded today (log), including those not yet in the file
}

// Everything the Home page shows; the frontend only draws it.
export interface HomeData {
    now: number;                  // the moment the page was made, in milliseconds since 1970
    name: string | null;          // the user's first name, null = a greeting without a name
    workspace: string | null;     // work folder; null = none yet, due dates and the inbox cannot be read
    resume: HomeEntry[];
    recent: HomeEntry[];
    tasks: Task[];
    runs: HomeRun[];
    agentHost: HomeAgentHost | null;
    inboxes: InboxCount[];
    journal: HomeJournal | null;  // null = no work folder
}

export interface HomeHost extends DocumentHost {
    readonly settings: AppSettings;
    readonly workspace: WorkspaceRepository;
    agentHost(): HomeAgentHost | null;          // null when agents run as children of this window
    runs(): readonly Run[];
    journalSummary(root: string, date: string): HomeJournal | null;
    updateBoardFile(file: string, edit: (board: Board) => Board): string | null;
    refreshHome(): void;
}

export class HomeController {
    constructor(private readonly host: HomeHost) {}

    data(now = new Date()): HomeData {
        const root = this.host.root();
        const recent = existingRecent(this.host.settings.recentFiles, root);
        const { resume, others } = splitRecent(recent, RESUME_CARDS);
        // Boards and inboxes come from the workspace (cached by modification time; unsaved tabs from their editor).
        const files = root ? this.host.workspace.files(root, { keep: isStructured }) : [];
        const realName = platform().realName();
        return {
            now: now.getTime(),
            name: realName ? realName.split(/\s+/)[0] : null,
            workspace: root,
            resume: resume.map(r => this.entry(r, true)),
            recent: others.map(r => this.entry(r, false)),
            tasks: dueTasks(files, localDate(now), cardProject),
            agentHost: this.host.agentHost(),
            runs: this.host.runs().filter(r => isActive(r.status) && (!root || insideName(root, r.board) !== null)).map(r => ({ id: r.id, agent: r.agent, title: r.title, status: r.status })),
            inboxes: openInboxes(files),
            journal: root ? this.host.journalSummary(root, localDate(now)) : null,
        };
    }

    // Card: folder name above the file name. List: file name above its folder (relative to the work folder if inside it).
    private entry(r: RecentFile, card: boolean): HomeEntry {
        const root = this.host.root();
        const { paths } = platform();
        const dir = paths.dirname(r.path), file = paths.basename(r.path);
        if (card) return { path: r.path, title: paths.basename(dir), subtitle: file, time: r.time };
        const folder = root && dir === root ? paths.basename(root)
            : (root && insideName(root, dir)) || dir.replace(paths.homeDir(), '~');
        return { path: r.path, title: file, subtitle: folder, time: r.time };
    }

    openWorkspaceFile(name: string): void {
        const root = this.host.root();
        if (root) this.host.openInTab(platform().paths.join(root, ...name.split('/')));
    }

    // A check from Home: written to its board (through the editor if open). A card that has changed is not touched.
    toggleTask(task: Task, done: boolean): boolean {
        const root = this.host.root();
        if (!root) return false;
        let changed = false;
        const error = this.host.updateBoardFile(platform().paths.join(root, ...task.file.split('/')), board => {
            const card = board.columns[task.at.column]?.cards[task.at.index];
            if (card?.text !== task.card) { changed = true; return board; }
            return updateCard(board, task.at, { done: done ? true : task.box ? false : null });
        });
        if (error || changed) {
            this.host.toast(error ? fmt(_('Cannot change the card: {error}'), { error }) : _('The card has changed; open the board to check'));
            // Deferred: the checked row is still running its handler.
            platform().scheduler.idleAfter(0, () => this.host.refreshHome());
            return false;
        }
        return true;
    }
}
