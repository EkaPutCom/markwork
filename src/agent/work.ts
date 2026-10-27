// The work state is saved together with the conversation; it does not include the model's thinking process.
import type { Verification } from './verification';
import type { ToolSpec } from './provider';

export interface WorkStep { text: string; status: 'pending' | 'done' | 'blocked' }
export interface WorkState {
    goal: string;
    status: 'running' | 'paused' | 'failed' | 'complete';
    steps: WorkStep[];
    note: string;
    actionStart?: number;
    verification?: Verification;
}

export const WORK_TOOL: ToolSpec = {
    name: 'set_work',
    description: 'Record the goal and plan of a multi-step piece of work. Update the step status as progress is made. This state is saved with the conversation so it can be resumed after stopping. Do not declare it finished before the result has been checked.',
    parameters: { type: 'object', properties: {
        goal: { type: 'string' },
        steps: { type: 'array', maxItems: 20, items: { type: 'object', properties: {
            text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'done', 'blocked'] },
        }, required: ['text', 'status'], additionalProperties: false } },
        note: { type: 'string' },
    }, required: ['goal', 'steps', 'note'], additionalProperties: false },
};

export function parseWork(raw: string): WorkState | null {
    try {
        const a = JSON.parse(raw);
        if (typeof a.goal !== 'string' || !a.goal.trim() || a.goal.length > 2000 ||
            typeof a.note !== 'string' || a.note.length > 4000 || !Array.isArray(a.steps) ||
            !a.steps.length || a.steps.length > 20) return null;
        if (!a.steps.every((s: any) => typeof s.text === 'string' && s.text.trim() && s.text.length <= 1000 &&
            ['pending', 'done', 'blocked'].includes(s.status))) return null;
        return { goal: a.goal.trim(), status: 'running', steps: a.steps.map((s: any) => ({ text: s.text.trim(), status: s.status })), note: a.note };
    } catch { return null; }
}

export function workText(work: WorkState): string {
    const status = { running: 'running', paused: 'paused', failed: 'failed', complete: 'finished and verified' }[work.status];
    return `Work: ${work.goal} (${status})\n${work.steps.map(s => `- [${s.status === 'done' ? 'x' : ' '}] ${s.text}${s.status === 'blocked' ? ' — blocked' : ''}`).join('\n')}\n${work.note}`;
}
