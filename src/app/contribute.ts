// "Send changes as pull request": checks that the folder is connected to a forge and has changes, asks what to send, and
// hands the sending to forge/contribute.ts. The result is told in a toast; the pull request itself shows up in the list.

import { repoChanges, runGit } from '../base/git';
import { sendChanges, type SendContext, type SendResult, type SendVia } from '../forge/contribute';
import type { ForgeProvider, RepoRef } from '../forge/types';
import type { FileChange } from '../base/gitlog';
import { _, fmt } from '../base/i18n';
import type { DocumentHost } from './document';

// What the "Send changes as pull request" dialog is shown, and what it answers.
export interface SendChangesOptions {
    repository: string;                  // owner/repo, shown so the user knows where it goes
    base: string;                        // the branch the pull request asks to merge into
    folder: string;                      // changes are shown relative to it
    changes: readonly FileChange[];      // absolute paths
    canPush: boolean;                    // the token may push branches to the repository itself
}

export interface SendChangesAnswer {
    title: string;
    body: string;
    branch: string;
    via: SendVia;
    files: string[];
}

export interface ContributeDialogs {
    send(options: SendChangesOptions): Promise<SendChangesAnswer | null>;   // null = cancelled
}

export interface ContributeHost extends DocumentHost {
    saveAll(): boolean;       // write the open documents to disk first; false = the user cancelled
    refreshTree(): void;
}

// What contributing needs from the collaboration controller.
export interface ContributeAccess {
    session(): { provider: ForgeProvider; repo: RepoRef; token: string } | null;
    refresh(): void;
}

export class ContributeController {
    git: SendContext['git'] = runGit;

    // dialogs: the frontend's send dialog; tests replace it with an immediate answer.
    constructor(private readonly host: ContributeHost, private readonly access: ContributeAccess, public dialogs: ContributeDialogs) {}

    async start(): Promise<void> {
        const session = this.access.session(), folder = this.host.root();
        if (!session) return this.host.toast(_('Connect to a server first: add an access token in the pull requests tab.'));
        if (!folder) return this.host.toast(_('Open a folder first.'));
        if (!this.host.saveAll()) return;
        const changes = await repoChanges(folder);
        if (!changes.ok) return this.host.toast(changes.message || _('The changes of this folder could not be read.'));
        if (!changes.changes.length) return this.host.toast(_('There are no changes to send.'));
        let info;
        try {
            info = await session.provider.repoInfo();
        } catch (e) {
            return this.host.toast(e instanceof Error ? e.message : String(e));
        }
        if (!info) return this.host.toast(_('The server does not know this repository, or the token cannot see it.'));
        const answer = await this.dialogs.send({
            repository: `${session.repo.owner}/${session.repo.repo}`, base: info.defaultBranch, folder, changes: changes.changes, canPush: info.canPush,
        });
        if (!answer) return;
        this.host.toast(_('Sending…'));
        const context: SendContext = { provider: session.provider, repo: session.repo, token: session.token, git: this.git };
        const result = await sendChanges(context, { folder, files: answer.files, title: answer.title, body: answer.body, branch: answer.branch, via: answer.via });
        this.host.toast(this.told(result));
        this.host.refreshTree();
        this.access.refresh();
    }

    private told(result: SendResult): string {
        if (!result.ok) return fmt(_('Could not send the changes: {message}'), { message: result.message });
        const where = fmt(_('The folder is now on the branch {branch}.'), { branch: result.branch });
        return `${result.pull ? fmt(_('Opened pull request #{number}.'), { number: result.pull.number }) : _('Sent. The pull request appears in the list shortly.')} ${where}`;
    }
}
