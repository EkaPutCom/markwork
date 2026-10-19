// A scripted model for the Electron tests (tests/electron-assistant.mjs): the core loads it when MARKWORK_TEST_MODEL names
// this file, so no test reaches the network. It echoes the question, except that "bump" proposes an edit of plan.md (and
// answers once the proposal was decided), and "slow" waits until the turn is stopped.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const done = { usage: null, cancelled: false, toolCalls: [], reasoning: '' };

export const provider = {
    async chat(req) {
        // With context the user message is the notes, then "The user's question:" and the question itself.
        const last = [...req.messages].reverse().find(m => m.role === 'user')?.content ?? '';
        const marker = "The user's question:\n";
        const asked = (last.includes(marker) ? last.slice(last.indexOf(marker) + marker.length) : last).trim();
        const told = req.messages.filter(m => m.role === 'tool').map(m => m.content);
        await sleep(40);
        if (/\bslow\b/.test(asked)) {
            req.onReasoning?.('Taking my time.');
            while (!req.cancellable?.cancelled) await sleep(25);
            return { ...done, cancelled: true };
        }
        if (/\bbump\b/.test(asked) && !told.length) {
            const args = { name: 'plan', old_text: '15 November', new_text: '22 November', reason: 'the meeting moved it' };
            return { ...done, toolCalls: [{ id: 't1', name: 'edit_file', arguments: JSON.stringify(args) }] };
        }
        req.onReasoning?.('Looking at the question.');
        const answer = told.length ? `Proposal answered: ${told.at(-1).slice(0, 60)}` : `Echo: ${asked.slice(0, 60)}`;
        for (const part of [answer.slice(0, 8), answer.slice(8)]) { req.onText(part); await sleep(20); }
        return { ...done, usage: { prompt: 1200, cached: 200, completion: 30 } };
    },
};
