// The History tab and the history viewer: the commits of the active file,
// the uncommitted files of its repository with the commit form, and one commit or one file's changes in a large dialog. The core
// runs git and the commit message writer; this draws what it sends and reports what the user did.

import { useEffect, useMemo, useState } from 'react';
import type { ChangeKind, ChangedFile, WriteResult } from '../../../src/app/protocol/history';
import { DiffLines } from './Diff';
import { Icon } from './Icons';
import { Modal } from './Modals';
import { commitTime } from './notes';
import type { Client } from '../lib/client';
import { useClient, useStore } from '../lib/useClient';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { IconButton } from '../ui/icon-button';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';

const KIND_MARK: Record<ChangeKind, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };
const KIND_CLASS: Record<ChangeKind, string> = { modified: 'warning', added: 'success', deleted: 'error', renamed: 'warning', untracked: 'success' };

const discardLabel = (kind: ChangeKind) => kind === 'untracked' || kind === 'added' ? 'Delete this new file' : 'Discard the changes to this file';

// What a message writer that did not write says, for the line under the form.
const writeProblem = (result: WriteResult): string | null => {
    if (result.ok) return null;
    return result.reason === 'no-key' ? 'Add a DeepSeek API key in the Assistant first.' : result.message;
};

// The commit message box with the button that has the assistant write it. The core streams the text; the form shows it as it arrives.
function MessageBox({ streamed, rev, files, label, busy, onCommit, write, stop }: {
    streamed: string; rev: number; files: string[]; label: string; busy: boolean;
    onCommit: (message: string) => Promise<string | null>;
    write: () => Promise<WriteResult>; stop: () => void;
}) {
    const [text, setText] = useState('');
    const [writing, setWriting] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => { if (rev > 0) setText(streamed); }, [rev, streamed]);

    const commit = async () => {
        setProblem(null);
        const error = await onCommit(text);
        if (error) setProblem(error); else setText('');
    };
    const ask = async () => {
        setWriting(true);
        setProblem(null);
        const result = await write();
        setWriting(false);
        if (result.ok) setText(result.message); else setProblem(writeProblem(result));
    };
    return (
        <div className="commit-form">
            <div className="message-box">
                <Textarea aria-label="Commit message" placeholder="Message (Ctrl+Enter to commit)" rows={1} value={text} disabled={writing} onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit(); } }} />
                <IconButton className="message-assistant" size="icon-xs" label={writing ? 'Stop writing' : 'Write the message with the assistant'} disabled={!writing && files.length === 0}
                    onClick={() => { if (writing) stop(); else void ask(); }}>
                    <Icon name={writing ? 'media-playback-stop' : 'sparkle'} />
                </IconButton>
            </div>
            {problem && <div className="form-error" role="alert">{problem}</div>}
            <Button size="sm" className="w-full" disabled={busy || writing || !text.trim() || files.length === 0} onClick={() => void commit()}><Icon name="emblem-ok" />{label}</Button>
        </div>
    );
}

function ChangeRow({ change, checked, onCheck, client }: { change: ChangedFile; checked: boolean; onCheck: (on: boolean) => void; client: Client }) {
    const slash = change.name.lastIndexOf('/');
    const name = change.name.slice(slash + 1);
    const folder = slash < 0 ? '' : change.name.slice(0, slash);
    return (
        <div className="change-row" title={change.name}>
            <Checkbox checked={checked} aria-label={`Include ${change.name} in the commit`} onCheckedChange={on => onCheck(on === true)} />
            <Button variant="ghost" size="xs" aria-label={change.name} className="name justify-start font-normal text-left" onClick={() => client.openChanges(change.path)}>
                <Icon name="text-x-generic" size={14} />
                <span className="change-basename">{name}</span>
                {folder && <span className="change-folder">{folder}</span>}
            </Button>
            <IconButton label={`${discardLabel(change.kind)}: ${change.name}`}
                onClick={() => void client.discardFile(change.path).then(outcome => { if (typeof outcome === 'object') client.say(outcome.error); })}>
                <Icon name="edit-undo" />
            </IconButton>
            <span className={`mark ${KIND_CLASS[change.kind]}`} aria-label={change.kind}>{KIND_MARK[change.kind]}</span>
        </div>
    );
}

export function History() {
    const client = useClient();
    const { history } = useStore();
    const { changes, commits } = history;
    const changed = changes?.changed ?? [];
    const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
    const [folded, setFolded] = useState(false);
    // Every uncommitted file starts checked; a file the user unchecked stays so while it is in the list.
    const chosen = useMemo(() => changed.filter(c => !unchecked.has(c.path)).map(c => c.path), [changed, unchecked]);
    const state = changes?.state;

    return (
        <aside className="sidebar history" aria-label="History">
            <div className="side-head">
                <div className="side-title">History</div>
                <IconButton label="Reload history" onClick={() => client.refreshHistory()}><Icon name="view-refresh" /></IconButton>
            </div>
            <div className="history-body">
                {changed.length === 0 && changes?.file && state && state !== 'clean' && (
                    <Button variant="ghost" size="sm" className="uncommitted justify-start text-left" onClick={() => client.openChanges(changes.file!)}>
                        {state === 'untracked' ? '● New file, not committed yet' : '● Uncommitted changes'}
                    </Button>
                )}
                {changed.length > 0 && (
                    <section className="changes" aria-label="Uncommitted">
                        <MessageBox streamed={history.message} rev={history.messageRev} files={chosen} busy={false}
                            label={chosen.length ? `Commit ${chosen.length} ${chosen.length === 1 ? 'file' : 'files'}` : 'Commit'}
                            onCommit={message => client.commitFiles(chosen, message)}
                            write={() => client.writeMessage(chosen)} stop={() => client.stopWriting()} />
                        <Collapsible open={!folded} onOpenChange={open => setFolded(!open)}>
                            <h3><CollapsibleTrigger asChild><Button variant="ghost" size="xs" className="fold w-full justify-start rounded-none" aria-label={`Changes (${changed.length})`}>
                                <Icon name={folded ? 'pan-end' : 'pan-down'} size={12} />Changes
                                <Badge variant="secondary" className="ml-auto tabular-nums">{changed.length}</Badge>
                            </Button></CollapsibleTrigger></h3>
                            <CollapsibleContent>
                                {changed.map(c => (
                                    <ChangeRow key={c.path} change={c} client={client} checked={!unchecked.has(c.path)}
                                        onCheck={on => setUnchecked(old => { const next = new Set(old); if (on) next.delete(c.path); else next.add(c.path); return next; })} />
                                ))}
                            </CollapsibleContent>
                        </Collapsible>
                    </section>
                )}
                {commits.length === 0 && history.note && <p className="empty">{history.note}</p>}
                <div className="commits" aria-label="Commits">
                    {commits.map(c => (
                        <Button key={c.hash} variant="ghost" className="commit h-auto items-stretch font-normal text-left" onClick={() => client.openCommit(c.hash)}>
                            <span className="subject">{c.subject || '(no message)'}</span>
                            <span className="meta">{c.short} · {c.author} · {commitTime(c.time)}</span>
                        </Button>
                    ))}
                    {history.more && <Button variant="outline" size="sm" className="more" onClick={() => client.moreHistory()}>Load more</Button>}
                </div>
            </div>
        </aside>
    );
}

// One viewer: a commit has the tabs Changes and Contents; a file's uncommitted changes have the commit form and Discard.
function Viewer({ id }: { id: number }) {
    const client = useClient();
    const viewer = useStore().viewers.find(v => v.id === id);
    const [tab, setTab] = useState('changes');
    if (!viewer) return null;
    const { commit, file } = viewer;
    const name = file.split(/[\\/]/).pop() ?? file;
    const title = commit ? `${commit.subject || '(no message)'} · ${commit.short}` : `Changes to ${name}`;
    return (
        <Modal title={title} wide className="diff-viewer" onClose={() => client.closeViewer(id)}>
            <div className="viewer">
                {commit && <p className="viewer-meta">{commit.author} · {commitTime(commit.time)} · {name}</p>}
                {commit && (
                    <Tabs value={tab} onValueChange={setTab}>
                        <TabsList className="pref-tabs">
                            <TabsTrigger value="changes">Changes</TabsTrigger>
                            <TabsTrigger value="contents">Contents</TabsTrigger>
                        </TabsList>
                    </Tabs>
                )}
                {(!commit || tab === 'changes') && (
                    viewer.diff === null ? <p className="empty">Loading…</p>
                        : 'lines' in viewer.diff ? <DiffLines lines={viewer.diff.lines} className="large" /> : <p className="empty">{viewer.diff.text}</p>
                )}
                {commit && tab === 'contents' && (viewer.content === null ? <p className="empty">Loading…</p> : <pre className="contents">{viewer.content}</pre>)}
                {!commit && <ViewerForm viewer={viewer} />}
            </div>
        </Modal>
    );
}

function ViewerForm({ viewer }: { viewer: { id: number; message: string; messageRev: number } }) {
    const client = useClient();
    const [error, setError] = useState<string | null>(null);
    return (
        <div className="viewer-form">
            <MessageBox streamed={viewer.message} rev={viewer.messageRev} files={['file']} busy={false} label="Commit"
                onCommit={message => client.viewerCommit(viewer.id, message)}
                write={() => client.viewerWrite(viewer.id)} stop={() => client.viewerStopWriting(viewer.id)} />
            {error && <div className="form-error" role="alert">{error}</div>}
            <Button variant="ghost" size="sm" className="self-start text-destructive hover:text-destructive" onClick={() => void client.viewerDiscard(viewer.id).then(o => { if (typeof o === 'object') setError(o.error); })}>Discard Changes…</Button>
        </div>
    );
}

// The viewers that are open: the latest is in front, and closing it shows the one before.
export function HistoryViewers() {
    const { viewers } = useStore();
    const latest = viewers.at(-1);
    return latest ? <Viewer key={latest.id} id={latest.id} /> : null;
}
