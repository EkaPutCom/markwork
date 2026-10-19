// The review of a card's worktree (ui/harnessreview.ts), a page of the content area: the files the agent changed with a box each,
// the diff with comments on its lines, the summary of the run, and what to do with the work: reply, merge, keep the branch,
// discard, or send it as a pull request. The core reads git and decides; this draws what it sends and reports what the user did.

import { useEffect, useState } from 'react';
import type { FileStatus } from '../../src/app/protocol/collab.js';
import type { ReviewSnapshot, ReviewTab } from '../../src/app/protocol/harness.js';
import { Icon } from './Icons.js';
import { useClient, useStore } from './useClient.js';

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
                            <button className="comment-button" aria-label={`Comment on line ${i + 1}`} title="Comment on this line" onClick={() => { setAt(i); setText(''); }}>＋</button>
                        )}
                    </div>
                    {at === i && (
                        <div className="line-comment">
                            <textarea autoFocus rows={2} aria-label="Comment" placeholder="Say what should change on this line" value={text} onChange={e => setText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setAt(null); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); } }} />
                            <div className="buttons"><button className="button suggested" disabled={!text.trim()} onClick={done}>Add Comment</button><button className="button" onClick={() => setAt(null)}>Cancel</button></div>
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
            {s?.hasLog && <button className="button" onClick={() => client.reviewAction('log')}>View the log</button>}
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
    const [menu, setMenu] = useState(false);
    if (!review || !review.header) return <div className="pull-page"><p className="empty">Loading…</p></div>;
    const { header, files, included, comments, selected, blocked, busy, tab, banner, pull } = review;
    const partial = included.some(v => !v);
    const none = files.length > 0 && !included.some(Boolean);
    const merging = busy !== null;
    const showTab = (t: ReviewTab) => client.reviewTab(t);
    return (
        <div className="pull-page review-page">
            <header className="pull-head">
                <button className="button flat circular" title="Close" aria-label="Close the review" onClick={() => client.closeReview()}><Icon name="go-previous" /></button>
                <div className="titles">
                    <h2>{header.title}</h2>
                    <p className="meta">{header.meta}</p>
                </div>
                <div className="actions">
                    {header.local && <button className="button flat" title="Open the worktree in a terminal" onClick={() => client.reviewAction('terminal')}>Terminal</button>}
                    <button className="button flat" title="Show the worktree in the file manager" onClick={() => client.reviewAction('folder')}>Folder</button>
                    <button className="button" disabled={merging} onClick={() => client.reviewAction('reply')}>{review.replies ? `Reply (${review.replies})…` : 'Reply…'}</button>
                    <div className="merge-split">
                        <button className="button suggested" disabled={merging || blocked || none} onClick={() => client.finishReview(partial ? 'squash' : 'merge')}>
                            {busy ? busy || 'Working…' : partial ? 'Merge Selected' : 'Merge'}
                        </button>
                        <button className="button narrow" aria-label="More ways to finish" aria-haspopup="menu" aria-expanded={menu} disabled={merging} onClick={() => setMenu(v => !v)}><Icon name="pan-down" /></button>
                        {menu && (
                            <div className="popover right" role="menu" onMouseLeave={() => setMenu(false)}>
                                <button role="menuitem" disabled={blocked || none} onClick={() => { setMenu(false); client.finishReview('merge'); }}><span>Merge Commit</span></button>
                                <button role="menuitem" disabled={blocked || none} onClick={() => { setMenu(false); client.finishReview('squash'); }}><span>Squash and Merge</span></button>
                                <hr />
                                <button role="menuitem" disabled={!pull?.enabled} title={pull?.detail} onClick={() => { setMenu(false); client.reviewAction('pullRequest'); }}><span>{pull?.label ?? 'Create Pull Request…'}</span></button>
                                <button role="menuitem" onClick={() => { setMenu(false); client.finishReview('keep'); }}><span>Keep Branch Only</span></button>
                                <button role="menuitem" onClick={() => { setMenu(false); client.finishReview('discard'); }}><span>Discard…</span></button>
                            </div>
                        )}
                    </div>
                </div>
            </header>
            {banner && (
                <div className="banner" role="status">
                    <span>{banner.title}</span>
                    {banner.button && <button className="button" onClick={() => client.reviewAction('banner')}>{banner.button}</button>}
                </div>
            )}
            <div className="pull-body">
                <nav className="pull-files" aria-label="Changed files">
                    {files.map((f, i) => (
                        <div key={f.path} className={`file${selected === i ? ' active' : ''}`} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                            <input type="checkbox" aria-label={`Take ${f.path}`} checked={included[i] ?? true} disabled={merging}
                                onChange={e => client.includeReviewFile(i, e.target.checked)} />
                            <button className="pick" aria-current={selected === i} onClick={() => { showTab('changes'); client.selectReviewFile(i); }}>
                                <span className={`mark ${MARK_CLASS[f.status]}`} aria-hidden="true">{MARK[f.status]}</span>
                                <span className="name">{f.path}</span>
                                <span className="counts">{comments[i] ? `💬${comments[i]} ` : ''}+{f.additions} −{f.deletions}</span>
                            </button>
                        </div>
                    ))}
                    {!files.length && <p className="empty">{review.message ?? 'The agent changed nothing.'}</p>}
                    <Commits review={review} />
                </nav>
                <section className="pull-main">
                    <div className="pref-tabs" role="tablist">
                        {(['changes', 'summary', 'log'] as const).filter(t => t !== 'log').map(t => (
                            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => showTab(t)}>{t === 'changes' ? 'Changes' : 'Summary'}</button>
                        ))}
                        <span className="side-meta status">{review.status}</span>
                    </div>
                    {tab === 'summary' ? <Summary review={review} /> : <CommentableDiff review={review} />}
                </section>
            </div>
        </div>
    );
}
