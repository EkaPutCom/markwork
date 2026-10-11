// The data behind the Home tab (recent files, due tasks, agent runs, inboxes, today's journal) and the actions
// taken from it. Everything is recomputed from the files on every render.

import GLib from 'gi://GLib';
import { fileExists } from '../files.js';
import type { AppSettings } from '../settings.js';
import type { WorkspaceRepository } from '../workspace.js';
import { cardProject, isActive } from '../agent/harness.js';
import { isDirectory } from '../ui/filetree.js';
import { RESUME_CARDS, type HomeData, type HomeEntry } from '../ui/home.js';
import { dueTasks, localDate, openInboxes, splitRecent, type RecentFile, type Task } from '../markdown/home.js';
import { isBoard, isList } from '../markdown/layout.js';
import { updateCard, type Board } from '../markdown/kanban.js';
import { _, fmt } from '../i18n.js';
import type { DocumentHost } from './doc.js';
import type { HarnessController } from './harness.js';
import type { JournalController } from './journal.js';

export interface HomeHost extends DocumentHost {
    readonly settings: AppSettings;
    readonly harness: HarnessController;
    readonly journal: JournalController;
    readonly workspace: WorkspaceRepository;
    updateBoardFile(file: string, edit: (board: Board) => Board): string | null;
    refreshHome(): void;
}

export class HomeController {
    constructor(private readonly host: HomeHost) {}

    data(now = new Date()): HomeData {
        const root = this.host.root();
        const recent = this.host.settings.recentFiles.filter(r => fileExists(r.path) && !isDirectory(r.path));
        const { resume, others } = splitRecent(recent, RESUME_CARDS);
        // Boards and inboxes come from the workspace (cached by modification time; unsaved tabs from their editor).
        const files = root ? this.host.workspace.files(root, { keep: text => isBoard(text) || isList(text) }) : [];
        const realName = GLib.get_real_name();
        return {
            now,
            name: realName && realName !== 'Unknown' ? realName.split(/\s+/)[0] : null,
            workspace: root,
            resume: resume.map(r => this.entry(r, true)),
            recent: others.map(r => this.entry(r, false)),
            tasks: dueTasks(files, localDate(now), cardProject),
            runs: this.host.harness.orchestrator.queue.runs.filter(r => isActive(r.status)).map(r => ({ id: r.id, agent: r.agent, title: r.title, status: r.status })),
            inboxes: openInboxes(files),
            journal: root ? this.host.journal.summary(root, localDate(now)) : null,
        };
    }

    // Card: folder name above the file name. List: file name above its folder (relative to the work folder if inside it).
    private entry(r: RecentFile, card: boolean): HomeEntry {
        const root = this.host.root();
        const dir = GLib.path_get_dirname(r.path), file = GLib.path_get_basename(r.path);
        if (card) return { path: r.path, title: GLib.path_get_basename(dir), subtitle: file, time: r.time };
        const folder = root && dir === root ? GLib.path_get_basename(root)
            : root && dir.startsWith(`${root}/`) ? dir.slice(root.length + 1)
            : dir.replace(GLib.get_home_dir(), '~');
        return { path: r.path, title: file, subtitle: folder, time: r.time };
    }

    openWorkspaceFile(name: string): void {
        const root = this.host.root();
        if (root) this.host.openInTab(GLib.build_filenamev([root, ...name.split('/')]));
    }

    // A check from Home: written to its board (through the editor if open). A card that has changed is not touched.
    toggleTask(task: Task, done: boolean): boolean {
        const root = this.host.root();
        if (!root) return false;
        let changed = false;
        const error = this.host.updateBoardFile(GLib.build_filenamev([root, ...task.file.split('/')]), board => {
            const card = board.columns[task.at.column]?.cards[task.at.index];
            if (card?.text !== task.card) { changed = true; return board; }
            return updateCard(board, task.at, { done: done ? true : task.box ? false : null });
        });
        if (error || changed) {
            this.host.toast(error ? fmt(_('Cannot change the card: {error}'), { error }) : _('The card has changed; open the board to check'));
            // Deferred: the checked row is still running its handler.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.host.refreshHome(); return GLib.SOURCE_REMOVE; });
            return false;
        }
        return true;
    }
}
