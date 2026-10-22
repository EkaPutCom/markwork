// The review of one pull request, a page of the content area: the changed files, each one as a note or as a raw
// diff, the discussion, and the merge. The core reads the forge and decides; this draws what it sends and reports what the user did.

import { useEffect, useState } from 'react';
import { relativeTime } from '../../../src/base/gitlog.js';
import type { FileStatus, MergeMethod, PullComment, PullRequest } from '../../../src/app/protocol/collab.js';
import { DiffLines } from './Diff.js';
import { Icon } from './Icons.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Select } from '../ui/select.js';

const METHOD_NAME: Record<MergeMethod, string> = { merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };
const MARK: Record<FileStatus, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const MARK_CLASS: Record<FileStatus, string> = { added: 'success', modified: 'warning', deleted: 'error', renamed: 'warning' };

// What the page says above the files: why it cannot be merged, or what the local merge needs next.
function bannerOf(pull: PullRequest, resolving: number | null): { text: string; action: 'resolve' | 'finish' | null } | null {
    if (resolving !== null) {
        const text = resolving
            ? `${resolving} ${resolving === 1 ? 'file still has' : 'files still have'} conflict markers. Choose a side above each conflict in ${resolving === 1 ? 'its tab' : 'their tabs'}, then finish.`
            : 'The conflicts are resolved. Finish to push the merge to the server.';
        return { text, action: 'finish' };
    }
    if (pull.state === 'merged') return { text: 'This pull request has been merged.', action: null };
    if (pull.state === 'closed') return { text: 'This pull request is closed.', action: null };
    if (pull.mergeable === false) return { text: `This pull request conflicts with ${pull.baseRef}. Resolve the conflicts on this computer, or ask the author to.`, action: 'resolve' };
    if (pull.mergeable === null) return { text: 'Checking whether it can be merged…', action: null };
    return null;
}

function Comment({ author, body, time, description }: { author: string; body: string; time: string; description: boolean }) {
    const hue = Array.from(author).reduce((sum, ch) => sum + ch.codePointAt(0)!, 0) % 6;
    return (
        <article className={`comment${description ? ' description' : ''}`}>
            <span className={`avatar hue-${hue}`} aria-hidden="true">{(Array.from(author.trim())[0] ?? '?').toUpperCase()}</span>
            <div className="text">
                <header><strong>{author || 'Someone'}</strong><span className="time">{time ? relativeTime(Date.parse(time) / 1000, Date.now() / 1000) : ''}</span></header>
                <div className="body">{body}</div>
            </div>
        </article>
    );
}

function Discussion({ pull, comments, commenting, cleared }: { pull: PullRequest; comments: readonly PullComment[]; commenting: boolean; cleared: number }) {
    const client = useClient();
    const [text, setText] = useState('');
    useEffect(() => { setText(''); }, [cleared]);
    return (
        <div className="discussion">
            <Comment author={pull.author} body={pull.body.trim() || 'No description.'} time={pull.createdAt} description />
            {comments.map(c => <Comment key={c.id} author={c.author} body={c.body} time={c.createdAt} description={false} />)}
            <div className="comment-form">
                <textarea aria-label="Comment" placeholder="Leave a comment" rows={3} value={text} disabled={commenting} onChange={e => setText(e.target.value)} />
                <button className="button suggested" disabled={commenting || !text.trim()} onClick={() => client.commentOnPull(text.trim())}>Comment</button>
            </div>
        </div>
    );
}

export function PullPage() {
    const client = useClient();
    const { pull: page } = useStore();
    const [view, setView] = useState<'note' | 'raw' | 'discussion'>('note');
    const [method, setMethod] = useState<MergeMethod>('merge');
    const number = page?.pull?.number;
    useEffect(() => { setView('note'); }, [number]);
    if (!page || !page.pull) return <div className="pull-page"><p className="empty">Loading…</p></div>;
    const { pull, files, selected, fileView, message, comments, busy, resolving, commenting, cleared } = page;
    const open = pull.state === 'open';
    const banner = bannerOf(pull, resolving);
    const rendered = fileView?.rendered ?? null;
    const showing = view === 'discussion' ? 'discussion' : rendered === null || view === 'raw' ? 'raw' : 'note';
    const lines = fileView ? (showing === 'note' ? rendered! : fileView.raw) : [];
    return (
        <div className="pull-page">
            <header className="pull-head">
                <button className="button flat circular" title="Close" aria-label="Close the review" onClick={() => client.closePull()}><Icon name="go-previous" /></button>
                <div className="titles">
                    <h2>#{pull.number}  {pull.title}</h2>
                    <p className="meta">{pull.author} wants to merge {pull.headRef} into {pull.baseRef} · {relativeTime(Date.parse(pull.updatedAt) / 1000, Date.now() / 1000)}</p>
                </div>
                <div className="actions">
                    {pull.url && <button className="button flat" onClick={() => client.pullInBrowser()}>Open in browser</button>}
                    {resolving !== null && <button className="button" onClick={() => client.abortPull()}>Abort merge</button>}
                    {open && (
                        <div className="merge-split">
                            <Select aria-label="Merge method" value={method} disabled={busy || resolving !== null} onChange={e => setMethod(e.target.value as MergeMethod)}>
                                {(Object.keys(METHOD_NAME) as MergeMethod[]).map(m => <option key={m} value={m}>{METHOD_NAME[m]}</option>)}
                            </Select>
                            <button className="button suggested" disabled={busy || resolving !== null || pull.mergeable === false} onClick={() => client.mergePull(method)}>{busy ? 'Merging…' : 'Merge'}</button>
                        </div>
                    )}
                </div>
            </header>
            {banner && (
                <div className="banner" role="status">
                    <span>{banner.text}</span>
                    {banner.action === 'resolve' && <button className="button" onClick={() => client.resolvePull()}>Resolve locally…</button>}
                    {banner.action === 'finish' && <button className="button suggested" onClick={() => client.finishPull()}>Finish and push</button>}
                </div>
            )}
            <div className="pull-body">
                <nav className="pull-files" aria-label="Changed files">
                    {files.map(f => (
                        <button key={f.path} className={`file${selected === f.path ? ' active' : ''}`} title={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
                            aria-current={selected === f.path} onClick={() => { setView(v => v === 'discussion' ? 'note' : v); client.selectPullFile(f.path); }}>
                            <span className={`mark ${MARK_CLASS[f.status]}`} aria-hidden="true">{MARK[f.status]}</span>
                            <span className="name">{f.path}</span>
                            <span className="counts">+{f.additions} −{f.deletions}</span>
                        </button>
                    ))}
                </nav>
                <section className="pull-main">
                    <div className="pref-tabs" role="tablist">
                        <button role="tab" aria-selected={showing === 'note'} disabled={rendered === null} className={showing === 'note' ? 'active' : ''} onClick={() => setView('note')}>Note</button>
                        <button role="tab" aria-selected={showing === 'raw'} className={showing === 'raw' ? 'active' : ''} onClick={() => setView('raw')}>Raw diff</button>
                        <button role="tab" aria-selected={showing === 'discussion'} className={showing === 'discussion' ? 'active' : ''} onClick={() => setView('discussion')}>
                            {comments.length ? `Discussion (${comments.length})` : 'Discussion'}
                        </button>
                    </div>
                    {showing === 'discussion' ? <Discussion pull={pull} comments={comments} commenting={commenting} cleared={cleared} />
                        : message ? <p className="empty">{message}</p>
                            : fileView && fileView.note && lines.length === 0 ? <p className="empty">{fileView.note}</p>
                                : <DiffLines lines={lines} className="large" />}
                </section>
            </div>
        </div>
    );
}
