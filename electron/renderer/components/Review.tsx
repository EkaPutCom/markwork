// The review of a card's worktree, a page of the content area: the files the agent changed with a box each,
// the diff with comments on its lines, the summary of the run, and what to do with the work: reply, merge, keep the branch,
// discard, or send it as a pull request. The core reads git and decides; this draws what it sends and reports what the user did.

import { useEffect, useState } from 'react';
import type { FileStatus } from '../../../src/app/protocol/collab';
import type { ReviewSnapshot, ReviewTab } from '../../../src/app/protocol/harness';
import { Icon } from './Icons';
import { useClient, useStore } from '../lib/useClient';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { IconButton } from '../ui/icon-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';

const MARK: Record<FileStatus, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const MARK_CLASS: Record<FileStatus, string> = { added: 'success', modified: 'warning', deleted: 'error', renamed: 'warning' };

// The diff with a button to comment on a line. A line that has a comment is marked; the box opens under the line chosen.
function CommentableDiff({ review }: { review: ReviewSnapshot }) {
    const client = useClient();
    const [at, setAt] = useState<number | null>(null);
    const [text, setText] = useState('');
    const file = review.selected;
    useEffect(() => { setAt(null); setText(''); }, [file]);
    const diff = review.diff;
    if (!diff) return <p className="empty">{review.message ?? 'Choose a file.'}</p>;
    const commented = new Set(diff.commented);
    const done = () => {
        const line = at, comment = text.trim();
        setAt(null); setText('');
        if (line !== null && comment) client.commentOnReview(line, comment);
    };
    return (
        <pre className="diff large commentable">
            {diff.lines.map((l, i) => (
                <div key={i}>
                    <div className={`line ${l.kind}${commented.has(i) ? ' commented' : ''}`}>
                        <span className="text">{l.text || ' '}</span>
                        {(l.kind === 'add' || l.kind === 'del' || l.kind === 'context') && (
                            <IconButton size="icon-xs" className="comment-button size-5" label={`Comment on line ${i + 1}`} onClick={() => { setAt(i); setText(''); }}><Icon name="list-add" size={14} /></IconButton>
                        )}
                    </div>
                    {at === i && (
                        <div className="line-comment">
                            <Textarea autoFocus rows={2} aria-label="Comment" placeholder="Say what should change on this line" value={text} onChange={e => setText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setAt(null); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); } }} />
                            <div className="buttons"><Button size="sm" disabled={!text.trim()} onClick={done}>Add Comment</Button><Button variant="outline" size="sm" onClick={() => setAt(null)}>Cancel</Button></div>
                        </div>
                    )}
                </div>
            ))}
        </pre>
    );
}

function Summary({ review }: { review: ReviewSnapshot }) {
    const client = useClient();
    const s = review.summary;
    return (
        <div className="review-summary">
            <h3>What the agent said</h3>
            <p className="answer">{s?.answer || 'The agent did not leave an answer.'}</p>
            <h3>Commands it ran</h3>
            {s?.commands.length
                ? <ul className="commands">{s.commands.map((c, i) => <li key={i} className={c.ok === false ? 'failed' : ''}><code>{c.command}</code><span className="side-meta">{c.ok === true ? 'ok' : c.ok === false ? 'failed' : ''}</span></li>)}</ul>
                : <p className="dim">No commands are known for this run.</p>}
            {s?.hasLog && <Button variant="outline" size="sm" className="self-start" onClick={() => client.reviewAction('log')}>View the log</Button>}
        </div>
    );
}

function Commits({ review }: { review: ReviewSnapshot }) {
    if (!review.commits.length && !review.uncommitted) return null;
    return (
        <ul className="review-commits" aria-label="Commits on the branch">
            {review.uncommitted && <li className="dim">Changes the agent did not commit</li>}
            {review.commits.map(c => <li key={c.hash} title={c.hash}><code>{c.hash.slice(0, 7)}</code> {c.subject}</li>)}
        </ul>
    );
}

export function ReviewPage() {
    const client = useClient();
    const { review } = useStore();
    if (!review || !review.header) return <div className="pull-page"><p className="empty">Loading…</p></div>;
    const { header, files, included, comments, selected, blocked, busy, tab, banner, pull } = review;
    const partial = included.some(v => !v);
    const none = files.length > 0 && !included.some(Boolean);
    const merging = busy !== null;
    const showTab = (t: ReviewTab) => client.reviewTab(t);
    return (
        <div className="pull-page review-page">
            <header className="pull-head">
                <IconButton label="Close the review" onClick={() => client.closeReview()}><Icon name="go-previous" /></IconButton>
                <div className="titles">
                    <h2>{header.title}</h2>
                    <p className="meta">{header.meta}</p>
                </div>
                <div className="actions">
                    {header.local && <Button variant="ghost" size="sm" onClick={() => client.reviewAction('terminal')}>Terminal</Button>}
                    <Button variant="ghost" size="sm" onClick={() => client.reviewAction('folder')}>Folder</Button>
                    <Button variant="outline" size="sm" disabled={merging} onClick={() => client.reviewAction('reply')}>{review.replies ? `Reply (${review.replies})…` : 'Reply…'}</Button>
                    <div className="merge-split">
                        <Button size="sm" className="rounded-r-none" disabled={merging || blocked || none} onClick={() => client.finishReview(partial ? 'squash' : 'merge')}>
                            {busy ? busy || 'Working…' : partial ? 'Merge Selected' : 'Merge'}
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <IconButton variant="default" size="icon-sm" className="rounded-l-none" label="More ways to finish" disabled={merging}><Icon name="pan-down" /></IconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-56">
                                <DropdownMenuItem disabled={blocked || none} onSelect={() => client.finishReview('merge')}>Merge Commit</DropdownMenuItem>
                                <DropdownMenuItem disabled={blocked || none} onSelect={() => client.finishReview('squash')}>Squash and Merge</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem disabled={!pull?.enabled} title={pull?.detail} onSelect={() => client.reviewAction('pullRequest')}>{pull?.label ?? 'Create Pull Request…'}</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => client.finishReview('keep')}>Keep Branch Only</DropdownMenuItem>
                                <DropdownMenuItem variant="destructive" onSelect={() => client.finishReview('discard')}>Discard…</DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </div>
            </header>
            {banner && (
                <div className="banner" role="status">
                    <span>{banner.title}</span>
                    {banner.button && <Button variant="outline" size="sm" onClick={() => client.reviewAction('banner')}>{banner.button}</Button>}
                </div>
            )}
            <div className="pull-body">
                <nav className="pull-files" aria-label="Changed files">
                    {files.map((f, i) => (
                        <div key={f.path} className={`file${selected === i ? ' active' : ''}`} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                            <Checkbox aria-label={`Take ${f.path}`} checked={included[i] ?? true} disabled={merging}
                                onCheckedChange={on => client.includeReviewFile(i, on === true)} />
                            <Button variant="ghost" size="xs" className="pick h-auto justify-start font-normal text-left" aria-current={selected === i} onClick={() => { showTab('changes'); client.selectReviewFile(i); }}>
                                <span className={`mark ${MARK_CLASS[f.status]}`} aria-hidden="true">{MARK[f.status]}</span>
                                <span className="name">{f.path}</span>
                                <span className="counts">{comments[i] ? `💬${comments[i]} ` : ''}+{f.additions} −{f.deletions}</span>
                            </Button>
                        </div>
                    ))}
                    {!files.length && <p className="empty">{review.message ?? 'The agent changed nothing.'}</p>}
                    <Commits review={review} />
                </nav>
                <Tabs value={tab} onValueChange={value => showTab(value as ReviewTab)} className="pull-main">
                    <div className="flex items-center">
                        <TabsList className="pref-tabs">
                            <TabsTrigger value="changes">Changes</TabsTrigger>
                            <TabsTrigger value="summary">Summary</TabsTrigger>
                        </TabsList>
                        <span className="side-meta status">{review.status}</span>
                    </div>
                    <TabsContent value={tab}>{tab === 'summary' ? <Summary review={review} /> : <CommentableDiff review={review} />}</TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
