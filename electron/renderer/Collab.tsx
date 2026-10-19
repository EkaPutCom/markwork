// The pull requests tab (ui/collab.ts), the token dialog (ui/serverdialog.ts), and the form that sends changes as a pull request
// (ui/sendchanges.ts). The core talks to the forge; this draws what it sends and reports what the user did.

import { useEffect, useRef, useState } from 'react';
import { relativeTime } from '../../src/gitlog.js';
import type { SendVia } from '../../src/app/protocol/collab.js';
import { Icon } from './Icons.js';
import { Modal } from './Modals.js';
import { useClient, useStore } from './useClient.js';

export function Collab() {
    const client = useClient();
    const { collab } = useStore();
    const now = Date.now() / 1000;
    const pulls = [...collab.pulls].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return (
        <aside className="sidebar collab" aria-label="Pull requests">
            <div className="side-title">
                <span>{pulls.length ? `PULL REQUESTS (${pulls.length})` : 'PULL REQUESTS'}</span>
                <span className="actions">
                    <button className="button flat circular" title="Send changes as a pull request" aria-label="Send changes as a pull request" onClick={() => client.sendChanges()}><Icon name="go-up" /></button>
                    <button className="button flat circular" title="Reload pull requests" aria-label="Reload pull requests" onClick={() => client.refreshPulls()}><Icon name="view-refresh" /></button>
                </span>
            </div>
            {collab.server && (
                <button className="server" title="Server access" onClick={() => client.editServer()}>
                    <span className="label">{collab.server}</span><Icon name="emblem-system" />
                </button>
            )}
            {collab.note && (
                <div className="placeholder">
                    <p>{collab.note}</p>
                    {collab.server && <button className="button" onClick={() => client.editServer()}>Server access…</button>}
                </div>
            )}
            <div className="pulls" aria-label="Open pull requests">
                {pulls.map(p => (
                    <button key={p.number} className="pull-row" onClick={() => client.openPull(p.number)}>
                        <span className="subject">
                            <span className={`dot ${p.mergeable === false ? 'warning' : p.mergeable === null ? 'dim' : 'success'}`} role="img"
                                aria-label={p.mergeable === false ? 'Conflicts with the base branch' : p.mergeable === null ? 'Checking whether it can be merged' : 'Can be merged'}>●</span>
                            <span className="number">#{p.number}</span> {p.title}
                        </span>
                        <span className="meta">
                            {p.author} · {relativeTime(Date.parse(p.updatedAt) / 1000, now)}
                            {p.comments > 0 && ` · ${p.comments} ${p.comments === 1 ? 'comment' : 'comments'}`}
                            {p.mergeable === false && ' · conflicts'}
                        </span>
                    </button>
                ))}
            </div>
        </aside>
    );
}

// The token the forge needs, with a button to try it before it is saved.
export function TokenDialog() {
    const client = useClient();
    const { tokenAsk } = useStore();
    const [token, setToken] = useState('');
    const [status, setStatus] = useState<{ kind: 'busy' | 'ok' | 'error'; text: string } | null>(null);
    const run = useRef(0);
    const id = tokenAsk?.id;
    useEffect(() => { setToken(''); setStatus(null); run.current++; }, [id]);
    if (!tokenAsk) return null;
    const { repo, hasToken, source } = tokenAsk;
    const canForget = hasToken && source !== 'env';
    const test = async () => {
        const mine = ++run.current;
        setStatus({ kind: 'busy', text: 'Connecting…' });
        try {
            const text = await client.testToken(tokenAsk.id, token);
            if (mine === run.current) setStatus({ kind: 'ok', text });
        } catch (e) {
            if (mine === run.current) setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
        }
    };
    const save = () => client.answerToken(tokenAsk.id, token.trim());
    return (
        <Modal title="Server access" onClose={() => client.answerToken(tokenAsk.id, null)}>
            <form className="form" onSubmit={e => { e.preventDefault(); if (canForget || token.trim()) save(); }}>
                <p>Markwork reads the pull requests of {repo.owner}/{repo.repo} on {repo.host}. Create an access token in your account settings there (Applications), allowed to read and write repositories, and paste it here.</p>
                <input type="password" autoFocus aria-label="Access token" autoComplete="off" value={token} onChange={e => setToken(e.target.value)}
                    placeholder={canForget ? 'Saved — type to replace' : 'Access token'} />
                <div className="test-row">
                    <button type="button" className="button" onClick={() => void test()}>Test connection</button>
                    {status && <span className={`status ${status.kind}`} role="status">{status.text}</span>}
                </div>
                {source === 'env' && <p className="dim">The token in use comes from the MARKWORK_FORGE_TOKEN environment variable, which takes precedence over one saved here.</p>}
                {source !== 'env' && hasToken && <p className="dim">Save with the field empty to remove the saved token.</p>}
                <div className="buttons">
                    <button type="submit" className="button suggested" disabled={!canForget && !token.trim()}>Save</button>
                    <button type="button" className="button" onClick={() => client.answerToken(tokenAsk.id, null)}>Cancel</button>
                </div>
            </form>
        </Modal>
    );
}

const VIA: [SendVia, string, string][] = [
    ['fork', 'Through my fork', 'Your own copy of the repository is created if you do not have one'],
    ['direct', 'A branch in the repository', 'You are allowed to push here; no fork needed'],
    ['agit', 'AGit (no fork, no branch)', 'The server opens the pull request from the push. It has to be enabled on the server'],
];

// The name git would use for a branch called after the title (forge/contribute.ts slug, without the runtime).
const slug = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
const today = (): string => `update-${new Date().toISOString().slice(0, 10)}`;
const branchProblem = (name: string): boolean => !name || /^[-/]|[/.]$|\.lock$|[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|^@$/.test(name);

export function SendChangesDialog() {
    const client = useClient();
    const { sendAsk } = useStore();
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [branch, setBranch] = useState(today());
    const [branchEdited, setBranchEdited] = useState(false);
    const [via, setVia] = useState<SendVia>('fork');
    const [skipped, setSkipped] = useState<Set<string>>(new Set());
    const id = sendAsk?.id;
    useEffect(() => {
        setTitle(''); setBody(''); setBranch(today()); setBranchEdited(false); setSkipped(new Set());
        setVia(sendAsk?.options.canPush ? 'direct' : 'fork');
    }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
    if (!sendAsk) return null;
    const { options } = sendAsk;
    const prefix = options.folder.endsWith('/') ? options.folder : `${options.folder}/`;
    const files = options.changes.filter(c => !skipped.has(c.path)).map(c => c.path);
    const problem = !title.trim() ? 'The pull request needs a title.' : !files.length ? 'Choose at least one change to send.' : branchProblem(branch.trim()) ? 'That is not a usable branch name.' : null;
    const send = () => { if (!problem) client.answerSend(sendAsk.id, { title: title.trim(), body: body.trim(), branch: branch.trim(), via, files }); };
    return (
        <Modal title="Send Changes as Pull Request" onClose={() => client.answerSend(sendAsk.id, null)}>
            <form className="form" onSubmit={e => { e.preventDefault(); send(); }}>
                <p>Sent to {options.repository}, to be merged into {options.base}.</p>
                <label>Title<input autoFocus value={title} onChange={e => { setTitle(e.target.value); if (!branchEdited) setBranch(slug(e.target.value) || today()); }} /></label>
                <label>Description<textarea rows={3} value={body} onChange={e => setBody(e.target.value)} /></label>
                <label>Branch<input value={branch} onChange={e => { setBranch(e.target.value); setBranchEdited(true); }} /></label>
                <fieldset>
                    <legend>How it is sent</legend>
                    {VIA.filter(([kind]) => kind !== 'direct' || options.canPush).map(([kind, name, detail]) => (
                        <label key={kind} className="radio" title={detail}><input type="radio" name="via" checked={via === kind} onChange={() => setVia(kind)} />{name}</label>
                    ))}
                </fieldset>
                <fieldset className="send-files">
                    <legend>Changes to send</legend>
                    {options.changes.map(c => (
                        <label key={c.path} className="radio">
                            <input type="checkbox" checked={!skipped.has(c.path)} onChange={e => setSkipped(old => { const next = new Set(old); if (e.target.checked) next.delete(c.path); else next.add(c.path); return next; })} />
                            {c.path.startsWith(prefix) ? c.path.slice(prefix.length) : c.path}
                        </label>
                    ))}
                </fieldset>
                {problem && <div className="form-error" role="alert">{problem}</div>}
                <div className="buttons">
                    <button type="submit" className="button suggested" disabled={!!problem}>Send</button>
                    <button type="button" className="button" onClick={() => client.answerSend(sendAsk.id, null)}>Cancel</button>
                </div>
            </form>
        </Modal>
    );
}
