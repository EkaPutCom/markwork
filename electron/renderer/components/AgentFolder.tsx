// Agent conversations use the same chat components/model; only the model's session-scoped link differs.
import { useEffect, useMemo } from 'react';
import { ClientContext, useClient, useStore } from '../lib/useClient';
import type { Client } from '../lib/client';
import { Chat, ChatReview } from './Chat';
import { LogViewer } from './LogViewer';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Icon } from './Icons';

function ScopedChat({ id, children }: { id: string; children: React.ReactNode }) {
    const client = useClient();
    const scoped = useMemo(() => new Proxy(client, {
        get(target, key) {
            if (key === 'chat') return target.folderChat(id);
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as Client, [client, id]);
    return <ClientContext.Provider value={scoped}>{children}</ClientContext.Provider>;
}

export function AgentConversation({ id }: { id: string }) {
    const client = useClient();
    const { folderAgents } = useStore();
    useEffect(() => { void client.folderChat(id).sync(); }, [client, id]);
    return <ScopedChat id={id}><Chat embedded title={folderAgents?.name ?? 'Agent'} /></ScopedChat>;
}

export function AgentReviews() {
    const client = useClient();
    useStore();
    return <>{client.folderModels().map(([id]) => <ScopedChat key={id} id={id}><ChatReview /><LogViewer /></ScopedChat>)}</>;
}

export function AgentSessions() {
    const client = useClient();
    const { folderAgents: state, active, tabs } = useStore();
    if (!state?.root) return null;
    const selected = tabs.find(t => t.id === active)?.file;
    return (
        <aside className="chat agent-sessions" aria-label="Agent sessions">
            <div className="chat-head"><span className="side-title">Sessions</span><Badge variant="secondary">{state.sessions.length}</Badge></div>
            <div className="agent-session-body">
                <p className="text-sm font-medium">{state.name}</p>
                {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
                {!state.activated && <div className="flex flex-col gap-2"><p className="text-xs text-muted-foreground">Not activated. pi can write files, run commands, and access the network without Apply. The workspace is not a sandbox.</p><Button size="sm" disabled={!!state.error} onClick={() => void client.enableFolderAgent(state.root!)}>Activate pi agent</Button></div>}
                <Button variant="outline" size="sm" disabled={!!state.error} onClick={() => void client.newAgentChat()}><Icon name="list-add" />New chat</Button>
                <div className="agent-session-list">
                    {state.sessions.map(session => (
                        <Button key={session.id} variant="ghost" className="agent-session-row" aria-pressed={selected === session.id}
                            onClick={() => void client.openAgentSession(session.id)}>
                            <span className="font-medium">{session.title}</span>
                            <span className="text-xs text-muted-foreground">{session.queued ? 'Queued' : session.busy ? 'Working…' : session.interrupted ? 'Interrupted · restore native session' : 'Saved conversation'}</span>
                        </Button>
                    ))}
                </div>
                {state.activated && selected && <Button variant="outline" size="sm" disabled={state.sessions.some(session => session.busy)} onClick={() => void client.restoreFolderSession(selected)}>Restore native session</Button>}
                {!!state.conflicts?.length && <section className="flex flex-col gap-3" aria-label="Disk conflicts"><p role="alert" className="text-sm text-destructive">Disk changes conflict with unsaved drafts. Saves are paused.</p>{state.conflicts.map(conflict => <div key={conflict.path} className="flex flex-col gap-2"><span className="text-ui break-all">{conflict.name}</span><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void client.resolveFolderConflict(conflict.path, 'reload')}>Use disk version</Button><Button variant="outline" size="sm" onClick={() => void client.resolveFolderConflict(conflict.path, 'keep')}>Keep draft for saving</Button></div></div>)}</section>}
            </div>
            <div className="agent-runtime text-xs text-muted-foreground" role="status"><p>{state.runtime === 'background' ? 'Background available · markworkd connected' : state.runtime === 'reconnecting' ? 'Reconnecting to markworkd…' : state.runtime === 'checking' ? 'Checking background runtime…' : 'Runs while Markwork is open'}</p><p>{state.runtimeDetail}</p><Button variant="link" size="xs" onClick={() => client.openPrograms()}>Programs</Button></div>
        </aside>
    );
}
