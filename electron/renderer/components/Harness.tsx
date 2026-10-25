// The questions of the agents (app/harness.ts HarnessDialogs): what a harness waits for, a line of steering
// or a reply, a machine to add, and the form that sends a worktree's branch as a pull request. The core asks and reads the
// answer again against what it offered; this draws the question and reports what the user chose.

import { useEffect, useState } from 'react';
import type { HarnessAsk, HarnessReply } from '../../../src/app/protocol/harness.js';
import { isValidMachineName, isValidSshTarget } from '../../../src/agent/daemon/machines.js';
import { Modal } from './Modals.js';
import { useClient, useStore } from '../lib/useClient.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.js';
import { Textarea } from '../ui/textarea.js';

// What the harness asked, in the words of a dialog: a choice among options, a yes or no, a line, or free text.
function AnswerForm({ id, ask, agent }: { id: number; ask: HarnessAsk; agent: string }) {
    const client = useClient();
    const [text, setText] = useState(ask.prefill);
    useEffect(() => { setText(ask.prefill); }, [id, ask.prefill]);
    const answer = (reply: HarnessReply | null) => client.answerAsk(id, reply ? { reply } : {});
    const free = ask.kind === 'input' || ask.kind === 'editor' || ask.kind === 'question';
    return (
        <Modal title={ask.title || `${agent} asks`} onClose={() => answer(null)}>
            <form className="form" onSubmit={e => { e.preventDefault(); if (free) answer({ value: text }); }}>
                {ask.message && <p className="ask-message">{ask.message}</p>}
                {ask.kind === 'select' && (
                    <div className="choices" role="group" aria-label="Options">
                        {ask.options.map(option => <Button type="button" key={option} variant="outline" size="sm" onClick={() => answer({ value: option })}>{option}</Button>)}
                    </div>
                )}
                {free && (
                    ask.kind === 'input'
                        ? <Label>Your answer<Input autoFocus value={text} onChange={e => setText(e.target.value)} /></Label>
                        : <Label>{ask.kind === 'question' ? `Reply to ${agent}` : 'Your answer'}<Textarea autoFocus rows={5} value={text} onChange={e => setText(e.target.value)} /></Label>
                )}
                <div className="buttons">
                    {ask.kind === 'confirm' && <Button type="button" onClick={() => answer({ confirmed: true })}>Allow</Button>}
                    {free && <Button type="submit" disabled={ask.kind !== 'editor' && !text.trim()}>{ask.kind === 'question' ? 'Send Reply' : 'Answer'}</Button>}
                    {ask.kind === 'confirm' && <Button type="button" variant="outline" onClick={() => answer({ confirmed: false })}>Deny</Button>}
                    <Button type="button" variant="outline" title={ask.kind === 'question' ? `Leave ${agent}'s question for later` : `${agent} keeps waiting`} onClick={() => answer(null)}>Later</Button>
                    <Button type="button" variant="outline" title={ask.kind === 'question' ? 'End without a reply' : 'Skip the question'} onClick={() => answer({ cancelled: true })}>Skip</Button>
                </div>
            </form>
        </Modal>
    );
}

// A message for the agent (steering, a reply, the comments of a review): several lines, the context above them.
function TextForm({ id, title, label, context, text: initial }: { id: number; title: string; label: string; context: string; text: string }) {
    const client = useClient();
    const [text, setText] = useState(initial);
    useEffect(() => { setText(initial); }, [id, initial]);
    const done = (send: boolean) => client.answerAsk(id, send && text.trim() ? { text: text.trim() } : {});
    return (
        <Modal title={title} onClose={() => done(false)}>
            <form className="form" onSubmit={e => { e.preventDefault(); done(true); }}>
                <p>{label}</p>
                {context && <pre className="context">{context}</pre>}
                <Textarea autoFocus rows={6} aria-label={title} value={text} onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(true); } }} />
                <div className="buttons">
                    <Button type="submit" disabled={!text.trim()}>Send</Button>
                    <Button type="button" variant="outline" onClick={() => done(false)}>Cancel</Button>
                </div>
            </form>
        </Modal>
    );
}

// The name an SSH machine is called here, and where to reach it: the rules are the core's (it checks the answer again).

function MachineForm({ id, taken }: { id: number; taken: string[] }) {
    const client = useClient();
    const [name, setName] = useState('');
    const [target, setTarget] = useState('');
    const problem = !name.trim() ? 'Give the machine a name.' : !isValidMachineName(name.trim()) ? 'The name is letters, digits, dots, dashes, and underscores.'
        : taken.includes(name.trim()) ? 'There is a machine with that name already.' : !target.trim() ? 'Say how to reach it, like user@host.' : !isValidSshTarget(target.trim()) ? 'That is not a host ssh can reach.' : null;
    const done = (send: boolean) => client.answerAsk(id, send && !problem ? { machine: { name: name.trim(), target: target.trim() } } : {});
    return (
        <Modal title="Add a Machine" onClose={() => done(false)}>
            <form className="form" onSubmit={e => { e.preventDefault(); done(true); }}>
                <p>Agents can run on another computer you reach with ssh. Markwork opens the connection with your ssh settings and keys.</p>
                <Label>Name<Input autoFocus value={name} placeholder="build-box" onChange={e => setName(e.target.value)} /></Label>
                <Label>SSH target<Input value={target} placeholder="user@host" onChange={e => setTarget(e.target.value)} /></Label>
                {problem && name && <div className="form-error" role="alert">{problem}</div>}
                <div className="buttons">
                    <Button type="submit" disabled={!!problem}>Add</Button>
                    <Button type="button" variant="outline" onClick={() => done(false)}>Cancel</Button>
                </div>
            </form>
        </Modal>
    );
}

// The first question of the agents that waits; the others come after it.
export function AgentAsks() {
    const { agentAsks } = useStore();
    const ask = agentAsks[0];
    if (!ask) return null;
    switch (ask.kind) {
        case 'answer': return <AnswerForm key={ask.id} id={ask.id} ask={ask.ask} agent={ask.agent} />;
        case 'text': return <TextForm key={ask.id} id={ask.id} title={ask.title} label={ask.label} context={ask.context} text={ask.text} />;
        case 'machine': return <MachineForm key={ask.id} id={ask.id} taken={ask.taken} />;
    }
}

const VIA: ['fork' | 'direct' | 'agit', string, string][] = [
    ['fork', 'Through my fork', 'Your own copy of the repository is created if you do not have one'],
    ['direct', 'A branch in the repository', 'You are allowed to push here; no fork needed'],
    ['agit', 'AGit (no fork, no branch)', 'The server opens the pull request from the push. It has to be enabled on the server'],
];

// "Create Pull Request…" of the review: the branch of the card goes to the server and a pull request is opened for it.
export function PullRequestDialog() {
    const client = useClient();
    const { pullAsk } = useStore();
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [via, setVia] = useState<'fork' | 'direct' | 'agit'>('fork');
    const id = pullAsk?.id;
    useEffect(() => {
        if (!pullAsk) return;
        setTitle(pullAsk.options.title);
        setBody(pullAsk.options.body);
        setVia(pullAsk.options.canPush ? 'direct' : 'fork');
    }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
    if (!pullAsk) return null;
    const { options } = pullAsk;
    const problem = !title.trim() ? 'The pull request needs a title.' : null;
    const send = () => { if (!problem) client.answerPullRequest(pullAsk.id, { title: title.trim(), body, via }); };
    return (
        <Modal title="Create Pull Request" onClose={() => client.answerPullRequest(pullAsk.id, null)}>
            <form className="form" onSubmit={e => { e.preventDefault(); send(); }}>
                <p>{options.branch} goes to {options.host} and is offered for {options.repository}, to be merged into {options.base}.</p>
                {options.uncommitted && <p className="dim">The agent left changes it did not commit. They are committed on the branch first.</p>}
                <Label>Title<Input autoFocus value={title} onChange={e => setTitle(e.target.value)} /></Label>
                <Label>Description<Textarea rows={6} value={body} onChange={e => setBody(e.target.value)} /></Label>
                <fieldset>
                    <legend>How it is sent</legend>
                    <RadioGroup value={via} onValueChange={value => setVia(value as typeof via)} className="gap-1">
                        {VIA.filter(([kind]) => kind !== 'direct' || options.canPush).map(([kind, name, detail]) => (
                            <Label key={kind} className="choice" title={detail}><RadioGroupItem value={kind} />{name}</Label>
                        ))}
                    </RadioGroup>
                </fieldset>
                {problem && <div className="form-error" role="alert">{problem}</div>}
                <div className="buttons">
                    <Button type="submit" disabled={!!problem}>Send</Button>
                    <Button type="button" variant="outline" onClick={() => client.answerPullRequest(pullAsk.id, null)}>Cancel</Button>
                </div>
            </form>
        </Modal>
    );
}
