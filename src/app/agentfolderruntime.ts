// The app follows a daemon-owned headless engine. Only this application applies its proposals, against live buffers.
import type { DaemonConnection, Follower } from '../agent/daemon/connection';
import { DaemonError, parseExit, type DaemonRecord, type RunSummary } from '../agent/daemon/protocol';
import { daemonRun, newRunId } from '../orchestrator/daemon';
import { platform } from '../platform/index';
import { changeFiles } from '../agent/changes';
import { isAgentReserved } from '../agent/folder';
import type { Change } from '../agent/changes';
import type { ProposalResult } from '../agent/session';
import type { SourceFile } from '../agent/context';
import { insideName } from '../base/files';
import type { SavedChat } from '../agent/transcript';
import type { AgentWriteHost } from './agentwrites';
import { applyChangeBatch } from './agentwrites';
import type { FolderPanel, FolderChatPayload, FolderAgentView } from './folderpanel';

export async function bounded<T>(work: Promise<T>, ms = 10000): Promise<T> {
    let stop = () => {};
    const timeout = new Promise<never>((_, reject) => { stop = platform().scheduler.idleAfter(ms, () => reject(Error('Background runtime did not answer in time'))); });
    try { return await Promise.race([work, timeout]); } finally { stop(); }
}
export async function backgroundAvailable(conn: DaemonConnection, root: string): Promise<{ available: boolean; detail: string }> {
    try {
        await bounded(conn.ready());
        const result = await bounded(daemonRun(conn, ['markwork-agent', '--check'], root));
        const check = result?.status === 0 ? JSON.parse(result.out) : null;
        if (check?.version !== 1) return { available: false, detail: result?.err || 'Configure the markwork-agent program and this folder in markworkd.' };
        if (!check.available) return { available: false, detail: 'The background worker cannot access a model credential. Configure its environment or system keyring.' };
        return { available: check.agent === true, detail: check.agent ? 'Started work continues after the window closes; proposals still wait for Apply.' : 'The worker could not load agent.json.' };
    } catch { return { available: false, detail: 'markworkd could not be reached. Local chat is still available.' }; }
}
interface Pending {
    changes: Change[];
    batch: boolean;
    result: ProposalResult;
    offered: boolean;
    buffers: SourceFile[];
}
export class BackgroundConversation {
    private follower: Follower | null = null;
    private readonly proposals = new Map<number, Pending>();
    private disposed = false;
    private upTo = 0;
    private run = '';
    private compatible = false;
    private completed = false;
    private receivedDone = false;
    private finish: (() => void) | null = null;
    private watchdog: (() => void) | null = null;
    active = false;

    constructor(private readonly conn: DaemonConnection, private readonly root: string, private readonly id: string,
        private readonly panel: FolderPanel, private readonly view: FolderAgentView, private readonly host: AgentWriteHost,
        private readonly snapshot: (chat: SavedChat) => void, private readonly applied: (ask: number, changes: Change[]) => void, private readonly ended: () => void) {}

    async start(text: string, model: string, thinking: boolean): Promise<void> {
        if (this.active) throw Error('This session is already working');
        this.run = newRunId();
        this.active = true;
        this.panel.busyChanged(true);
        const input = JSON.stringify({ id: this.run + '-send', op: 'send', text, model, thinking });
        try {
            const client = await bounded(this.conn.ready());
            const started = await bounded(client.spawn({ run: this.run, program: 'markwork-agent', args: [platform().paths.basename(this.id)], cwd: this.root,
                lane: 'folder-agent:' + this.root, lane_slots: 1, labels: { kind: 'folder-agent', root: this.root, session: this.id }, initial_input: [input], idle_ttl_sec: 86400 }));
            this.panel.queued = started.state === 'queued';
            this.panel.busyChanged(true);
        } catch (error) {
            if (error instanceof DaemonError && !['timeout', 'connection_closed'].includes(error.code)) { this.panel.receive('chat.error', { error: error.message }); this.complete(); return; }
            // The spawn may have succeeded before its reply was lost. Follow the same identity; never retry the model call.
            this.panel.receive('chat.error', { error: 'Background startup is unconfirmed. Reconnecting to the original run.' });
        }
        if (this.disposed || this.completed) return;
        return new Promise(resolve => { this.finish = resolve; this.follow(1); });
    }

    adopt(run: RunSummary): void {
        this.run = run.run;
        this.upTo = run.last_seq;
        this.active = run.state !== 'exited';
        this.panel.queued = run.state === 'queued';
        this.panel.busyChanged(this.active);
        this.follow(1);
    }
    private follow(from: number): void {
        this.watchdog = platform().scheduler.idleAfter(86400000, () => this.fail('Background work exceeded its recovery window. Reopen the session to inspect it.'));
        this.follower = this.conn.follow(this.run, from, {
            record: record => this.record(record),
            end: () => this.complete(),
            failed: error => this.fail(error.message),
        });
    }
    private record(record: DaemonRecord): void {
        if (record.kind === 'out' && record.truncated) { this.fail('Background output exceeded the daemon line limit. Stop and inspect this session before continuing.'); return; }
        if (record.kind === 'exit' && !this.receivedDone) {
            const exit = parseExit(record.line);
            this.panel.receive('chat.error', { error: 'Background work interrupted (' + exit.reason + '). Review the saved conversation before continuing.' });
        }
        if (record.kind === 'start') { this.panel.queued = false; this.panel.busyChanged(true); }
        if (record.kind === 'out' && !record.truncated) {
            try {
                const message = JSON.parse(record.line) as { event: string; data: Record<string, unknown> };
                this.receive(message.event, message.data);
            } catch (e) { this.fail(e instanceof Error ? e.message : String(e)); }
        }
        if (this.upTo && record.seq >= this.upTo) {
            this.upTo = 0;
            for (const [ask, proposal] of this.proposals) this.offer(ask, proposal);
        }
    }
    private receive(event: string, data: Record<string, unknown>): void {
        if (event === 'hello') {
            if (data.version !== 1 || data.session !== this.id) throw Error('The background worker protocol or session does not match');
            this.compatible = true;
            return;
        }
        if (!this.compatible) throw Error('The background worker did not identify itself');
        if (event === 'snapshot') {
            const chat = data.chat as SavedChat;
            this.snapshot(chat);
            this.panel.base = chat;
            this.view.history?.(this.id, chat);
        } else if (event === 'proposal') {
            const ask = Number(data.ask);
            const proposal: Pending = { changes: data.changes as Change[], batch: data.batch === true, result: { applied: false }, offered: false, buffers: [] };
            this.proposals.set(ask, proposal);
            this.panel.setWaiting(true);
            if (!this.upTo) this.offer(ask, proposal);
        } else if (event === 'decided') {
            this.proposals.delete(Number(data.ask));
            this.panel.setWaiting(false);
        } else if (event === 'error') this.fail(String(data.error));
        else if (event === 'done') { this.receivedDone = true; this.snapshot(data.chat as SavedChat); }
        else if (event.startsWith('chat.')) this.panel.receive(event, data as FolderChatPayload);
    }
    private offer(ask: number, proposal: Pending): void {
        if (this.disposed || proposal.offered) return;
        proposal.offered = true;
        void this.view.review(this.id, { id: ask, changes: proposal.changes, batch: proposal.batch }).then(answer => {
            if (this.disposed) return;
            void this.write({ id: this.run + '-decision-' + ask, op: 'decision', ask, result: { ...proposal.result, note: answer.note }, buffers: proposal.buffers }).catch(error => this.fail(String(error)));
        }).catch(error => this.fail(String(error)));
    }
    async apply(ask: number, chosen: number[] | null): Promise<string | null> {
        const proposal = this.proposals.get(ask);
        if (!proposal || proposal.result.applied || this.disposed) return 'That proposal is no longer available';
        const indices = chosen ?? proposal.changes.map((_, i) => i);
        if (proposal.changes.some(c => changeFiles(c).some(isAgentReserved))) return 'Agent configuration and session storage require an explicit user edit';
        if (new Set(indices).size !== indices.length) return 'Choose each file only once';
        if (!indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= proposal.changes.length)) return 'Choose valid files from this proposal';
        const error = applyChangeBatch(this.host, indices.map(i => proposal.changes[i]));
        if (!error) {
            proposal.result = { applied: true, accepted: indices };
            this.applied(ask, indices.map(i => proposal.changes[i]));
            proposal.buffers = await this.approvedBuffers(indices.flatMap(i => changeFiles(proposal.changes[i])));
        }
        return error;
    }
    private async approvedBuffers(files: string[]): Promise<SourceFile[]> {
        const snapshots: Promise<SourceFile>[] = [];
        for (const doc of this.host.docs()) {
            const name = doc.file ? insideName(this.root, doc.file) : null;
            if (!name || !files.includes(name)) continue;
            snapshots.push(bounded(new Promise(resolve => {
                doc.editor.update(text => { resolve({ name, text }); return null; });
            })));
        }
        return Promise.all(snapshots);
    }
    private async write(command: Record<string, unknown>): Promise<void> {
        const client = await bounded(this.conn.ready());
        await bounded(client.write(this.run, JSON.stringify(command)));
    }
    stop(): void {
        if (!this.active) return;
        void bounded(this.conn.ready()).then(client => client.stop(this.run, 5000)).catch(error => this.fail(String(error)));
    }
    private fail(error: string): void {
        this.panel.receive('chat.error', { error });
        // A failed subscription does not prove the process stopped. Keep its identity until Stop is acknowledged.
        void bounded(this.conn.ready()).then(client => bounded(client.stop(this.run, 5000))).then(() => this.complete(), () => {
            this.panel.receive('chat.error', { error: 'Background state is unknown. Reconnect before continuing this session.' });
        });
    }
    private complete(): void {
        if (this.completed) return;
        this.completed = true;
        this.active = false;
        for (const ask of this.proposals.keys()) this.view.cancelReview(this.id, ask);
        this.proposals.clear();
        this.follower?.stop();
        this.watchdog?.(); this.watchdog = null;
        this.panel.setWaiting(false);
        this.panel.busyChanged(false);
        this.finish?.(); this.finish = null;
        this.ended();
    }
    detach(): void {
        if (this.active) void this.write({ id: this.run + '-release', op: 'release_buffers' }).catch(() => {});
        this.disposed = true;
        this.watchdog?.();
        this.follower?.stop();
        this.finish?.(); this.finish = null;
    }
}
