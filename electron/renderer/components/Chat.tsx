// The Assistant panel: the conversation, the context it sends, saved conversations, the API key, and the review of a change the
// agent proposes. It draws what the core told (chatmodel.ts) and reports what the user did; it writes no file.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { chatHtml } from '../../../src/markdown/chathtml';
import { formatMs } from '../../../src/agent/tracetree';
import type { ContextOptions, WorkState } from '../../../src/app/protocol/chat';
import { fmtTokens, statusLine, usageLine, type AnswerView, type PastAction, type ProposalView } from '../lib/chatmodel';
import { DiffLines } from './Diff';
import { Icon, type IconName } from './Icons';
import { Modal } from './Modals';
import { useChat, useClient } from '../lib/useClient';
import { Select } from '../ui/select';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Separator } from '../ui/separator';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';

const SUGGESTIONS = [
    'Summarize this document in a few points',
    'What is unfinished or out of sync in this folder?',
    'Draft a plan for the next steps from my notes',
];

// The seconds a running turn has taken, drawn again every second while it runs.
function useElapsed(from: number, to: number | null): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (to !== null) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [to]);
    return Math.max(0, Math.round(((to ?? now) - from) / 1000)) * 1000;
}

// A Popover of the panel beside the button that opens it; a click outside or Escape closes it.
function PanelPopover({ open, onOpenChange, trigger, label, side = 'bottom', children }: {
    open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactNode; label: string; side?: 'top' | 'bottom'; children: ReactNode;
}) {
    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            <PopoverContent side={side} align={side === 'top' ? 'start' : 'end'} className="chat-popover" aria-label={label}>{children}</PopoverContent>
        </Popover>
    );
}

// ---------- The answer ----------

function TurnStatus({ answer }: { answer: AnswerView }) {
    const client = useClient();
    const [open, setOpen] = useState(false);
    const running = answer.phase === 'thinking' || answer.phase === 'step' || answer.phase === 'writing';
    const elapsed = useElapsed(answer.startedAt, answer.endedAt);
    const retry = answer.phase === 'failed' || answer.phase === 'stopped';
    const icon: IconName | null = answer.phase === 'done' ? 'emblem-ok' : answer.phase === 'stopped' ? 'media-playback-stop' : answer.phase === 'failed' ? 'dialog-warning' : null;
    return (
        <div className={`chat-status ${answer.phase}`}>
            <div className="top">
                <Button variant="ghost" className="head font-normal" aria-expanded={open} onClick={() => setOpen(v => !v)}>
                    {running ? <Spinner aria-hidden="true" className="size-3.5" /> : icon && <Icon name={icon} size={14} className={answer.phase === 'done' ? 'done-icon' : undefined} />}
                    <span className="label">{statusLine(answer)}</span>
                    <span className="time">{formatMs(elapsed)}</span>
                    <Icon name={open ? 'pan-down' : 'pan-end'} size={12} />
                </Button>
                {retry && answer.question && <Button variant="ghost" size="sm" onClick={() => void client.chat.send(answer.question!)}>Retry</Button>}
            </div>
            {open && (
                <div className="details">
                    {answer.context && <div className="side-meta">{answer.context}</div>}
                    {answer.steps.map(s => (
                        <div key={s.id} className="chat-step">{s.summary ? <Icon name="emblem-ok" size={12} /> : <Spinner aria-hidden="true" className="size-3" />}
                            <span>{s.summary ? `${s.label} → ${s.summary}` : `${s.label}…`}</span></div>
                    ))}
                    {answer.reasoning.trim() && <details className="chat-thinking"><summary>Thinking process</summary><div>{answer.reasoning.trim()}</div></details>}
                </div>
            )}
        </div>
    );
}

const WORK_STATUS: Record<WorkState['status'], string> = { running: 'running', paused: 'paused', failed: 'failed', complete: 'finished and verified' };

function duration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// The agent's plan as a checklist; it comes only from the WorkState, so it is the same for a running turn and a saved one.
function WorkList({ work, running, elapsed }: { work: WorkState; running: boolean; elapsed?: number }) {
    const done = work.steps.filter(s => s.status === 'done').length;
    const meta = [`${done}/${work.steps.length} steps`, running ? 'working' : WORK_STATUS[work.status], ...elapsed !== undefined ? [duration(elapsed)] : [],
        ...work.verification && !work.verification.passed ? ['verification failed'] : []].join(' · ');
    const current = running && work.status === 'running' ? work.steps.findIndex(s => s.status === 'pending') : -1;
    return (
        <details className="chat-work" open>
            <summary><span className="goal">{work.goal}</span><span className="side-meta">{meta}</span></summary>
            <ul role="list">
                {work.steps.map((step, i) => {
                    const state = step.status === 'pending' ? (i === current ? 'in progress' : 'not yet') : step.status;
                    return (
                        <li key={i} aria-label={`${step.text} — ${state}`} className={step.status}>
                            <span className="mark">{i === current ? <Spinner aria-hidden="true" className="size-3" /> : step.status === 'done' ? <Icon name="emblem-ok" size={11} /> : step.status === 'blocked' ? <Icon name="dialog-warning" size={13} /> : <span className="pending" />}</span>
                            <span className="text">{step.text}</span>
                        </li>
                    );
                })}
            </ul>
            {work.note.trim() && <div className="side-meta">{work.note.trim()}</div>}
        </details>
    );
}

function ActionBar({ answer }: { answer: AnswerView }) {
    const client = useClient();
    const [copied, setCopied] = useState(false);
    const [inserted, setInserted] = useState<string | null>(null);
    return (
        <div className="chat-actions">
            <Button variant="ghost" size="xs" onClick={() => { void navigator.clipboard.writeText(answer.text); setCopied(true); }}><Icon name="edit-copy" size={14} /><span>{copied ? 'Copied' : 'Copy'}</span></Button>
            <Button variant="ghost" size="xs" onClick={async () => setInserted(await client.chat.insert(answer.text) ? 'Inserted' : 'Open a note first')}><Icon name="insert-text" size={14} /><span>{inserted ?? 'Insert into note'}</span></Button>
            {answer.question && <Button variant="ghost" size="xs" onClick={() => void client.chat.send(answer.question!)}><Icon name="view-refresh" size={14} /><span>Retry</span></Button>}
            <Button variant="ghost" size="xs" onClick={() => client.chat.openLog(true)}><Icon name="utilities-terminal" size={14} /><span>Log</span></Button>
        </div>
    );
}

function Answer({ answer }: { answer: AnswerView }) {
    const live = answer.question !== null;
    const finished = answer.outcome !== null || !live;
    const outcome = answer.outcome;
    const footer = outcome && !('error' in outcome) && !outcome.cancelled ? usageLine(outcome) : '';
    return (
        <div className="chat-answer">
            {live && <TurnStatus answer={answer} />}
            {answer.work && <WorkList {...answer.work} elapsed={answer.work.elapsed} />}
            {answer.cards.map(ask => <ProposalCard key={ask} ask={ask} />)}
            {answer.text && <div className="chat-assistant md" dangerouslySetInnerHTML={{ __html: chatHtml(answer.text) }} />}
            {finished && answer.text.trim() && <ActionBar answer={answer} />}
            {outcome && 'error' in outcome && <div className="chat-error footer">{outcome.error}</div>}
            {footer && <div className="side-meta footer">{footer}</div>}
        </div>
    );
}

// ---------- Change proposals ----------

const totals = (changes: ProposalView['changes']) => changes.reduce((a, c) => ({ added: a.added + c.added, removed: a.removed + c.removed }), { added: 0, removed: 0 });

function ProposalCard({ ask }: { ask: number }) {
    const client = useClient();
    const chat = useChat();
    const view = chat.proposals[ask];
    const [diff, setDiff] = useState(false);
    if (!view) return null;
    const { added, removed } = totals(view.changes);
    const description = view.batch ? `Change batch · ${view.changes.length} files` : view.changes[0].description;
    const reasons = view.changes.map(c => `${c.file}: ${c.reason}`).join('\n').trim();
    const status = view.state === 'open' ? `+${added} −${removed} · waiting for your decision` : view.undone ? 'Undone.' : view.message;
    return (
        <div className="chat-proposal" data-state={view.state}>
            <b>{description}</b>
            {reasons && <div className="side-meta">{reasons}</div>}
            <div className={view.state === 'failed' ? 'chat-error' : 'side-meta'}>{status}</div>
            <div className="row">
                {view.state === 'open' && <Button size="xs" onClick={() => client.chat.openReview(ask)}>Review changes</Button>}
                {view.state === 'applied' && !view.undone && (
                    <Button variant="outline" size="xs" aria-description="Restore the files to their contents before this change" onClick={() => void client.chat.undo({ ask })}>Undo</Button>
                )}
                {view.state !== 'open' && view.state !== 'cancelled' && <Button variant="ghost" size="xs" aria-expanded={diff} onClick={() => setDiff(v => !v)}>{diff ? 'Hide diff' : 'View diff'}</Button>}
            </div>
            {diff && <DiffLines lines={view.changes.flatMap(c => c.diff)} />}
        </div>
    );
}

// The review: the diff of every file, a checkbox per file of a batch, a note for the agent, and Apply or Reject. Closing without
// applying is rejecting. A refusal to apply stays open to be read.
export function ChatReview() {
    const client = useClient();
    const chat = useChat();
    const view = chat.review !== null ? chat.proposals[chat.review] : undefined;
    const [picked, setPicked] = useState<boolean[]>([]);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const ask = view?.ask;
    useEffect(() => { if (view) { setPicked(view.changes.map(() => true)); setNote(view.note); setBusy(false); } }, [ask]);   // eslint-disable-line react-hooks/exhaustive-deps
    if (!view) return null;
    const open = view.state === 'open';
    const title = view.batch ? `Batch: ${view.changes.length} files` : view.changes[0].description;
    const chosen = view.changes.map((_c, i) => i).filter(i => picked[i] !== false);
    const apply = async () => {
        setBusy(true);
        await client.chat.apply(view.ask, view.batch ? chosen : null, note);
        setBusy(false);
    };
    return (
        <Modal title={`Agent proposal: ${title}`} onClose={() => client.chat.reject(view.ask, note)} wide className="diff-viewer">
            <div className="review">
                <div className="info"><b>{title}</b>
                    <span className="side-meta">{view.changes.map(c => `${view.batch ? `${c.file}: ` : ''}${c.reason.trim()}`).join('\n').trim() || 'The agent gave no reason.'}</span></div>
                {view.batch && open && (
                    <fieldset className="picks">
                        <legend className="side-meta">Files to apply (uncheck to reject some):</legend>
                        {view.changes.map((c, i) => (
                            <Label key={i} className="font-normal"><Checkbox checked={picked[i] !== false} onCheckedChange={on => setPicked(p => p.map((v, j) => j === i ? on === true : v))} />
                                {c.description}{c.kind === 'move' ? '' : ` · +${c.added} −${c.removed}`}</Label>
                        ))}
                    </fieldset>
                )}
                <DiffLines lines={view.changes.flatMap(c => c.diff)} />
                {view.error && <div className="chat-error status" role="alert">Failed to apply: {view.error}</div>}
                <div className="bar">
                    {open && <Input className="note" placeholder="Note for the agent (optional), e.g. the reason for rejecting" aria-label="Note for the agent" value={note} onChange={e => setNote(e.target.value)} />}
                    <Button variant="outline" onClick={() => client.chat.reject(view.ask, note)}>{open ? 'Reject' : 'Close'}</Button>
                    {open && <Button disabled={busy || chosen.length === 0} onClick={() => void apply()}>
                        {view.batch && chosen.length < view.changes.length ? `Apply ${chosen.length} of ${view.changes.length}` : 'Apply'}</Button>}
                </div>
            </div>
        </Modal>
    );
}

// A past action of a conversation that was opened again.
function PastRow({ action }: { action: PastAction }) {
    const client = useClient();
    const [diff, setDiff] = useState(false);
    return (
        <div className="chat-past">
            <div className="row">
                <Button variant="outline" size="xs" aria-description={action.changes.map(c => c.file).join(', ')} aria-expanded={diff} onClick={() => setDiff(v => !v)}>View diff · {action.changes.length} {action.changes.length === 1 ? 'file' : 'files'}</Button>
                {action.status === 'applied' && <Button variant="outline" size="xs" aria-description="Restore the files to their contents before this change" onClick={() => void client.chat.undo({ event: action.id })}>Undo</Button>}
            </div>
            {diff && <DiffLines lines={action.changes.flatMap(c => c.diff)} />}
        </div>
    );
}

// ---------- The popovers ----------

const CONTEXT_PARTS: [keyof ContextOptions, string][] = [['activeDocument', 'Open document'], ['selection', 'Selection'], ['project', 'Other files in the folder']];
const KIND_LABEL: Record<string, string> = { map: 'Map', active: 'Document', selection: 'Selection', mention: 'Attachment', excerpt: 'Excerpt' };

function ContextButton() {
    const client = useClient();
    const chat = useChat();
    const [open, setOpen] = useState(false);
    const { settings, built } = chat;
    useEffect(() => { if (open) void client.chat.updateContext(); }, [open, client]);
    return (
        <div className="chat-context">
            <PanelPopover open={open && !!settings} onOpenChange={setOpen} label="Context" side="top" trigger={
                <Button variant="ghost" size="xs" className="font-normal text-muted-foreground">
                    Context{built ? ` · ≈${fmtTokens(built.tokens)} tokens` : ''}<Icon name="pan-down" size={12} />
                </Button>
            }>
                {settings && <>
                    {CONTEXT_PARTS.map(([key, text]) => (
                        <Label key={key} className="chat-check"><Checkbox aria-label={text} checked={settings.options[key]} onCheckedChange={on => client.chat.setOptions({ ...settings.options, [key]: on === true })} />{text}</Label>
                    ))}
                    <Separator />
                    {built && !built.items.length && <div className="side-meta">No document context is being sent.</div>}
                    {built?.items.map((item, i) => <div key={i} className="part">{KIND_LABEL[item.kind]}: {item.label} · {fmtTokens(item.tokens)}</div>)}
                    {built && <div className="side-meta">Total ≈{fmtTokens(built.tokens)} tokens of the {fmtTokens(settings.budget)} budget</div>}
                    {built?.unknownMentions.map(m => <div key={m} className="side-meta">File @{m} was not found in the project folder.</div>)}
                </>}
            </PanelPopover>
        </div>
    );
}

function HistoryButton() {
    const client = useClient();
    const { chats } = useChat();
    const [open, setOpen] = useState(false);
    useEffect(() => { if (open) void client.chat.loadChats(); }, [open, client]);
    return (
        <PanelPopover open={open} onOpenChange={setOpen} label="Conversations" trigger={<IconButton size="icon-xs" label="Conversations"><Icon name="document-open-recent" /></IconButton>}>
            {chats === null && <div className="side-meta">Open a work folder to keep conversations.</div>}
            {chats?.length === 0 && <div className="side-meta">No saved conversations yet.</div>}
            {chats?.map(c => (
                <div key={c.path} className="chat-item">
                    <Button variant="ghost" className="open h-auto items-stretch font-normal text-left" onClick={async () => { if (await client.chat.openChat(c.path)) setOpen(false); }}>
                        <span className="title">{c.title}</span><span className="side-meta">{c.created.replace('T', ' ').slice(0, 16)} · {c.turns} {c.turns === 1 ? 'turn' : 'turns'}</span>
                    </Button>
                    <IconButton size="icon-xs" label={`Delete ${c.title}`} onClick={() => void client.chat.deleteChat(c.path)}><Icon name="window-close" size={12} /></IconButton>
                </div>
            ))}
        </PanelPopover>
    );
}

const SOURCES = { env: 'from the DEEPSEEK_API_KEY environment variable', keyring: 'in the system keyring', file: 'in a file in ~/.config/markwork' };

function SettingsButton({ forceOpen }: { forceOpen: number }) {
    const client = useClient();
    const { settings, key, models } = useChat();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [error, setError] = useState('');
    useEffect(() => { if (forceOpen > 0) setOpen(true); }, [forceOpen]);
    useEffect(() => { if (open) void client.chat.keyStatus(); }, [open, client]);
    return (
        <PanelPopover open={open && !!settings} onOpenChange={setOpen} label="Assistant settings" trigger={<IconButton size="icon-xs" label="Assistant settings"><Icon name="emblem-system" /></IconButton>}>
            {settings && <>
                <div className="field-title">DeepSeek API key</div>
                <div className="side-meta" role="status">{key === undefined ? '' : key ? `A key is set ${SOURCES[key]}.` : 'No key yet.'}</div>
                <Input type="password" autoComplete="off" aria-label="API key" placeholder="Paste the key" value={text} onChange={e => setText(e.target.value)} />
                {error && <div className="chat-error">{error}</div>}
                <div className="row">
                    <Button size="sm" disabled={!text.trim()} onClick={async () => { const e = await client.chat.saveKey(text.trim()); setError(e ?? ''); if (!e) setText(''); }}>Save</Button>
                    {key && key !== 'env' && <Button variant="outline" size="sm" onClick={() => void client.chat.forgetKey()}>Forget</Button>}
                </div>
                <Separator />
                <div className="chat-check justify-between"><span>Model</span>
                    <Select value={settings.model} aria-label="Model" onChange={e => client.chat.setModel(e.target.value)}>
                        {(models.length ? models : [settings.model]).map(m => <option key={m} value={m}>{m}</option>)}
                    </Select>
                </div>
                <Label className="chat-check"><Checkbox aria-label="Thinking mode" checked={settings.thinking} onCheckedChange={on => client.chat.setThinking(on === true)} />Thinking mode</Label>
                <Label className="chat-check"><Checkbox aria-label="Save conversation history" checked={settings.saveChats} onCheckedChange={on => client.chat.setSaveChats(on === true)} />Save conversation history</Label>
            </>}
        </PanelPopover>
    );
}

// ---------- The panel ----------

export function Chat() {
    const client = useClient();
    const chat = useChat();
    const { entries, busy, draft, keyPrompt } = chat;
    const input = useRef<HTMLTextAreaElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const model = client.chat;

    useEffect(() => { input.current?.focus(); }, [chat.focus]);
    // Stay at the bottom as long as the user has not scrolled up.
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    });
    // The context of what is being typed is looked up when typing pauses.
    useEffect(() => {
        if (busy) return;
        const timer = setTimeout(() => void model.updateContext(), 400);
        return () => clearTimeout(timer);
    }, [draft, busy, model]);

    const send = () => { if (draft.trim() && !busy) { stick.current = true; void model.send(draft); } };
    return (
        <aside className="chat" aria-label="Assistant">
            <div className="chat-head">
                <span className="side-title">Assistant</span>
                <IconButton size="icon-xs" label="New conversation" onClick={() => model.reset()}><Icon name="edit-clear" /></IconButton>
                <IconButton size="icon-xs" label="Agent log" onClick={() => model.openLog(true)}><Icon name="utilities-terminal" /></IconButton>
                <HistoryButton />
                <SettingsButton forceOpen={keyPrompt} />
            </div>
            <div className="chat-messages" ref={scroller} role="log" aria-live="polite"
                onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24; }}>
                {entries.length === 0 && (
                    <div className="chat-empty">
                        <p className="side-meta">Ask or request help with anything about your work. The assistant reads the open document and relevant excerpts from other files in the folder.</p>
                        {SUGGESTIONS.map(s => <Button key={s} variant="outline" className="h-auto justify-start whitespace-normal px-3 py-2 text-left font-normal" onClick={() => { model.setDraft(s); model.focusInput(); }}>{s}</Button>)}
                    </div>
                )}
                {entries.map((e, i) => {
                    switch (e.kind) {
                        case 'user': return <div key={i} className="chat-user">{e.text}</div>;
                        case 'answer': return <Answer key={i} answer={e.answer} />;
                        case 'note': return <div key={i} className={e.error ? 'chat-error' : 'side-meta'}>{e.text}</div>;
                        case 'work': return (
                            <div key={i}><WorkList work={e.work} running={false} />
                                {e.work.status !== 'complete' && <Button variant="outline" size="sm" onClick={() => model.resume()}>Resume work</Button>}</div>
                        );
                        case 'past': return <PastRow key={i} action={e.action} />;
                    }
                })}
            </div>
            <ContextButton />
            <div className="chat-input">
                <Textarea ref={input} rows={2} aria-label="Ask the Assistant" className="min-h-0 border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent" placeholder="Ask a question" value={draft}
                    onChange={e => model.setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
                <IconButton variant={busy ? 'destructive' : 'default'} size="icon-sm" label={busy ? 'Stop' : 'Send'} shortcut={busy ? undefined : 'Enter'}
                    disabled={!busy && !draft.trim()} onClick={() => busy ? model.stop() : send()}><Icon name={busy ? 'media-playback-stop' : 'go-up'} /></IconButton>
            </div>
        </aside>
    );
}
