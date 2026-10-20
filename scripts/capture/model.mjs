// The scripted model of the screenshots (scripts/capture.mjs): the core loads it when MARKWORK_TEST_MODEL names this file,
// so no capture reaches the network or needs a key. Each question it knows has a script of rounds: a round is tool calls
// (the core runs them on the real sample folder and asks again) or the final answer, streamed a few words at a time so
// the animations catch it being written.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tool = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });

export const ANSWER = `There is **one decision that is not in the plan yet**:

- In *notes/meeting-1-oct.md* › Decisions: "The public release is postponed to 22 November because the sync testing is not finished."
- In *plans/launch.md* › Schedule: "Public release: 15 November."

The budget is already consistent ($3,000) and the closed beta stays on 20 October. Shall I propose a change to the date?`;

const steps = (...status) => ['Find meeting decisions that are not in the plan yet', 'Update the plan, the board, and the meeting notes', 'Check the result']
    .map((text, i) => ({ text, status: status[i] }));
const GOAL = 'Sync the release schedule with the 1 October meeting decisions';

// The scripts, by a phrase of the question.
const SCRIPTS = [
    ['meeting decision that has not made it', [
        [tool('a', 'search_text', { text: 'Public release' }), tool('b', 'read_file', { name: 'meeting-1-oct' })],
        ANSWER,
    ]],
    ['update the release date', [
        [tool('u1', 'edit_file', { name: 'plans/launch.md', old_text: '- Public release: 15 November', new_text: '- Public release: 22 November', reason: 'The 1 October meeting postponed the public release to 22 November.' })],
        [tool('u2', 'edit_note', { name: 'tasks.md', action: 'move', note: 'Prepare the release material', group: 'In Progress', reason: 'Sari started preparing the release material.' })],
        'Done. The release date in the plan is now **22 November**, and the card *Prepare the release material* is in the *In Progress* list.',
    ]],
    ['Sync the release schedule', [
        [tool('p1', 'set_work', { goal: GOAL, steps: steps('done', 'pending', 'pending'), note: 'The public release is postponed to 22 November.' })],
        [tool('p2', 'propose_batch', { actions: [
            { tool: 'edit_file', arguments: JSON.stringify({ name: 'plans/launch.md', old_text: '- Public release: 15 November', new_text: '- Public release: 22 November', reason: 'The 1 October meeting postponed the public release.' }) },
            { tool: 'edit_note', arguments: JSON.stringify({ name: 'tasks.md', action: 'move', note: 'Prepare the release material', group: 'In Progress', reason: 'Sari started preparing the release material.' }) },
            { tool: 'insert_text', arguments: JSON.stringify({ name: 'notes/meeting-8-oct.md', position: 'end', text: '\nThe launch plan has been updated to 22 November.\n', reason: 'Record that the plan has been synced.' }) },
        ] })],
        [tool('p3', 'set_work', { goal: GOAL, steps: steps('done', 'done', 'pending'), note: 'The batch was applied.' })],
        [tool('p4', 'verify_work', { checks: [
            { file: 'plans/launch.md', kind: 'present', text: 'Public release: 22 November' },
            { file: '*', kind: 'absent', text: '15 November' },
            { file: 'tasks.md', kind: 'kanban', text: 'Prepare the release material #marketing [due:: 2026-11-10]', list: 'In Progress', done: false },
            { file: 'notes/meeting-8-oct.md', kind: 'present', text: 'has been updated to 22 November' },
        ] })],
        [tool('p5', 'set_work', { goal: GOAL, steps: steps('done', 'done', 'done'), note: 'All the checks passed.' })],
        'Done and verified. The plan uses **22 November**, the old date is left in no file, the card *Prepare the release material* is in *In Progress*, and the 8 October meeting notes record the update.',
    ]],
    ['When was the public release date written', [
        [tool('g1', 'git_log', { file: 'plan.md' })],
        [tool('g2', 'show_commit', { commit: 'HEAD', file: 'plan.md' })],
        'The date **15 November** first entered in the commit *Clarify the goal and the dates* by Eka Putra; the earlier commit only wrote "Closed beta: October". The line *Evaluation: 30 November* is not committed yet.',
    ]],
    ['Summarize this week', ['The public release is postponed to 22 November, Sari prepares the release material, and Budi fixes the sync bug.']],
    ['List the launch risks', ['Main risks: the sync bug, a closed beta that slips, and a limited test server budget.']],
];

export const provider = {
    async chat(req) {
        const users = req.messages.map((m, i) => [m, i]).filter(([m]) => m.role === 'user');
        const [last, at] = users.at(-1) ?? [{ content: '' }, -1];
        // With context the user message is the notes, then "The user's question:" and the question itself.
        const marker = "The user's question:\n";
        const asked = last.content.includes(marker) ? last.content.slice(last.content.indexOf(marker) + marker.length) : last.content;
        // The round of this turn: how many answers with tool calls came after the question.
        const round = req.messages.slice(at + 1).filter(m => m.role === 'assistant').length;
        const script = SCRIPTS.find(([phrase]) => asked.includes(phrase))?.[1] ?? [`I read the notes. ${asked.split('\n').at(-1).slice(0, 80)}`];
        const step = script[Math.min(round, script.length - 1)];
        await sleep(400);
        if (typeof step !== 'string') return { usage: { prompt: 1840, cached: 1536, completion: 40 }, cancelled: false, reasoning: '', toolCalls: step };
        for (const part of step.match(/\S+\s*/g) ?? []) {
            req.onText(part);
            await sleep(90);
        }
        return { usage: { prompt: 3920, cached: 1536, completion: 148 }, cancelled: false, toolCalls: [], reasoning: '' };
    },
};
