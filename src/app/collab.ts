// Collaboration: finds the forge behind the work folder's git remote, watches its open pull requests, and tells the user
// when one is opened or updated. The forge layer does the talking; this controller connects it to the sidebar tab,
// the token dialog, and desktop notifications.

import { runGit } from '../git.js';
import { GiteaProvider } from '../forge/gitea.js';
import { PullMonitor, type PullEvent } from '../forge/monitor.js';
import { parseRemote } from '../forge/remote.js';
import { systemTokenStore, type TokenSource, type TokenStore } from '../forge/token.js';
import { ForgeError, type ForgeProvider, type PullRequest, type RepoRef, type Transport } from '../forge/types.js';
import { platform } from '../platform/index.js';
import type { AppSettings } from '../settings.js';
import { _, fmt } from '../i18n.js';
import type { DocumentHost } from './document.js';

// The pull requests tab: it draws what it is given and reports the user's actions through the on* callbacks.
export interface CollabView {
    onOpen: (pull: PullRequest) => void;
    onRefresh: () => void;
    onServer: () => void;
    onSend: () => void;
    setNote(text: string | null): void;
    setServer(label: string | null): void;
    setPulls(pulls: readonly PullRequest[]): void;
}

// The token dialog; null = cancelled, '' = forget the saved token.
export interface CollabDialogs {
    token(repo: RepoRef, hasToken: boolean, source?: TokenSource): Promise<string | null>;
}

export interface CollabHost extends DocumentHost {
    readonly settings: AppSettings;
    readonly collabPanel: CollabView;
    isActive(): boolean;                                   // the window has the focus: a toast reaches the user
    notify(id: string, title: string, body: string): void;   // a desktop notification, for when it does not
    openUri(uri: string): void;                            // in the browser
}

// What the controller reaches outside the process through; tests replace them.
export interface CollabServices {
    tokens: TokenStore;
    transport: Transport;
    remoteUrl: (folder: string) => Promise<string | null>;
}

const defaultServices: CollabServices = {
    tokens: systemTokenStore,
    transport: request => platform().http(request),
    async remoteUrl(folder) {
        const run = await runGit(folder, ['remote', 'get-url', 'origin']);
        return run && run.status === 0 && run.out.trim() ? run.out.trim() : null;
    },
};

// These two stay on screen until the user acts (a new token, another folder); the others are likely to pass by themselves.
const LASTING: ReadonlySet<ForgeError['failure']> = new Set(['auth', 'not-found']);

export class CollabController {
    private monitor: PullMonitor | null = null;
    private forge: ForgeProvider | null = null;
    private accessToken = '';
    private repo: RepoRef | null = null;
    private folder: string | null = null;
    private generation = 0;                 // a folder change makes the answers of the previous folder stale
    private failing = false;                // the last round failed: report the next failure only after a success
    private notified = new Set<string>();
    // dialogs: the frontend's token dialog (it can try a token with test()); tests replace it with an immediate answer.
    constructor(private readonly host: CollabHost, public dialogs: CollabDialogs, readonly services: CollabServices = { ...defaultServices }) {
        const panel = host.collabPanel;
        panel.onRefresh = () => void this.refresh();
        panel.onServer = () => void this.editToken();
        panel.onSend = () => this.onSend();
        panel.onOpen = pull => this.onOpenPull(pull);
        host.settings.onChanged(['forge-poll-seconds'], () => this.monitor?.start(host.settings.forgePollSeconds));
    }

    // A pull request was chosen in the list; the window connects this to the review (the browser page until then).
    onOpenPull: (pull: PullRequest) => void = pull => { if (pull.url) this.host.openUri(pull.url); };

    // The send button of the tab; the window connects it to ContributeController.
    onSend: () => void = () => {};

    get pulls(): readonly PullRequest[] { return this.monitor?.pulls ?? []; }
    provider(): ForgeProvider | null { return this.forge; }
    // What sending changes needs: the forge, where the folder's repository is, and the token to push with.
    session(): { provider: ForgeProvider; repo: RepoRef; token: string } | null {
        return this.forge && this.repo ? { provider: this.forge, repo: this.repo, token: this.accessToken } : null;
    }

    // The work folder changed (or the window just opened one): look for its forge from scratch.
    async setFolder(folder: string | null): Promise<void> {
        const generation = ++this.generation;
        this.disconnect();
        this.folder = folder;
        const panel = this.host.collabPanel;
        panel.setPulls([]);
        panel.setServer(null);
        if (!folder) return panel.setNote(_('Open a folder to see the pull requests of its repository'));
        const url = await this.services.remoteUrl(folder);
        if (generation !== this.generation) return;
        const repo = url ? parseRemote(url) : null;
        if (!repo) return panel.setNote(url ? _('The git remote of this folder does not look like a hosted repository') : _('This folder has no git remote, so there are no pull requests to show'));
        this.repo = repo;
        panel.setServer(`${repo.host} · ${repo.owner}/${repo.repo}`);
        const saved = await this.services.tokens.get(repo.host);
        if (generation !== this.generation) return;
        if (!saved) return panel.setNote(fmt(_('Add an access token for {host} to see its pull requests'), { host: repo.host }));
        panel.setNote(_('Loading…'));
        this.connect(repo, saved.token);
    }

    private connect(repo: RepoRef, token: string): void {
        const provider = new GiteaProvider(repo, token, this.services.transport);
        this.forge = provider;
        this.accessToken = token;
        const monitor = new PullMonitor(provider);
        monitor.onChange = (pulls, events) => {
            this.failing = false;
            this.host.collabPanel.setPulls(pulls);
            this.announce(events);
        };
        monitor.onError = error => this.fail(error, monitor);
        this.monitor = monitor;
        monitor.start(this.host.settings.forgePollSeconds);
    }

    private disconnect(): void {
        this.monitor?.stop();
        this.monitor = null;
        this.forge = null;
        this.accessToken = '';
        this.repo = null;
        this.failing = false;
        this.notified.clear();
    }

    dispose(): void {
        this.generation++;
        this.disconnect();
    }

    async refresh(): Promise<void> {
        if (this.monitor) await this.monitor.poll();
        else await this.setFolder(this.folder);
    }

    private fail(error: ForgeError, monitor: PullMonitor): void {
        const panel = this.host.collabPanel;
        if (LASTING.has(error.failure) || monitor.pulls.length === 0) {
            panel.setNote(error.message);
            return;
        }
        // A list we already have stays; say once that it may be out of date.
        if (!this.failing) this.host.toast(fmt(_('Could not refresh pull requests: {message}'), { message: error.message }));
        this.failing = true;
    }

    // In the window a toast is enough; a notification is for when the user is somewhere else.
    private announce(events: PullEvent[]): void {
        if (!this.host.settings.forgeNotify) return;
        for (const event of events) {
            if (event.kind === 'closed') continue;
            const key = `${event.kind}:${event.pull.number}:${event.pull.updatedAt}`;
            if (this.notified.has(key)) continue;
            this.notified.add(key);
            const title = event.kind === 'opened'
                ? fmt(_('{author} opened pull request #{number}'), { author: event.pull.author, number: event.pull.number })
                : fmt(_('Pull request #{number} was updated'), { number: event.pull.number });
            if (this.host.isActive()) this.host.toast(`${title}: ${event.pull.title}`);
            else this.host.notify(`pull-${event.pull.number}`, title, event.pull.title);
        }
    }

    // Tries a token against the forge without saving it; resolves to a sentence, rejects with the reason.
    async test(repo: RepoRef, token: string): Promise<string> {
        const typed = token || (await this.services.tokens.get(repo.host))?.token || '';
        const pulls = await new GiteaProvider(repo, typed, this.services.transport).listPulls('open');
        return fmt(_('Connected — {count} open pull requests'), { count: pulls.length });
    }

    async editToken(): Promise<void> {
        const repo = this.repo ?? (this.folder ? parseRemote((await this.services.remoteUrl(this.folder)) ?? '') : null);
        if (!repo) return;
        const saved = await this.services.tokens.get(repo.host);
        const answer = await this.dialogs.token(repo, !!saved, saved?.source);
        if (answer === null) return;
        if (answer === '') await this.services.tokens.clear(repo.host);
        else await this.services.tokens.set(repo.host, answer);
        await this.setFolder(this.folder);
    }
}
