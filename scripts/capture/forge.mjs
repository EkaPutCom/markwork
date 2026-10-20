// The fake forge of the screenshots (scripts/capture.mjs): the core loads it when MARKWORK_TEST_FORGE names this file. It
// answers from a table: three open pull requests of the launch project, their files, contents, discussion, and diff. Git
// is real: MARKWORK_CAPTURE_BARE is a local bare repository standing for the server's.

const API = 'https://git.example.org/api/v1/repos/markwork/launch';
const BASE = 'b'.repeat(40), HEAD = 'a'.repeat(40);
const ago = hours => new Date(Date.now() - hours * 3600_000).toISOString();
const HEADS = { 14: 'postpone-release', 13: 'calendar-schedule', 12: 'research-wording' };

export const LAUNCH = '# Markwork 1.0 Launch Plan\n\n## Goal\n\nRelease Markwork 1.0 for Linux users, complete with folder syncing.\n\n## Schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n- Evaluation: 30 November\n\n## Budget\n\nTotal $3,000, including the redesign and a test server.\n';
export const SCHEDULE = '---\ntitle: Release schedule\nlayout: list\n---\n# Release schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n';
export const RESEARCH = '# Competitor research\n\nThree similar note apps; all of them are paid and closed.\n';

const pull = (n, title, user, hours, extra = {}) => ({
    number: n, title, state: 'open', merged: false, mergeable: true, user: { login: user }, head: { ref: HEADS[n], sha: HEAD }, base: { ref: 'main', sha: BASE },
    comments: 0, body: '', created_at: ago(hours + 1), updated_at: ago(hours), html_url: `https://git.example.org/markwork/launch/pulls/${n}`, ...extra,
});
const pulls = [
    pull(14, 'Postpone the public release to 22 November', 'sari', 2, { comments: 2, body: 'The 1 October meeting moved the release because the sync testing is not finished. This updates the plan and the schedule.' }),
    pull(13, 'Show the release schedule as a calendar', 'budi', 26, { comments: 1, body: 'The schedule note becomes a calendar, so the beta and the release show up next to each other.' }),
    pull(12, 'Fix the wording in the research notes', 'dewi', 70, { mergeable: false, body: 'A small wording fix.' }),
];
const files = {
    14: [{ filename: 'plans/launch.md', status: 'modified', additions: 1, deletions: 1 }, { filename: 'plans/schedule.md', status: 'modified', additions: 1, deletions: 1 }],
    13: [{ filename: 'plans/schedule.md', status: 'modified', additions: 3, deletions: 1 }],
    12: [{ filename: 'research/competitors.md', status: 'modified', additions: 1, deletions: 1 }],
};
const content = {
    [`plans/launch.md@${BASE}`]: LAUNCH, [`plans/launch.md@${HEAD}`]: LAUNCH.replace('Public release: 15 November', 'Public release: 22 November'),
    [`plans/schedule.md@${BASE}`]: SCHEDULE,
    [`plans/schedule.md@${HEAD}`]: SCHEDULE.replace('layout: list', 'layout: calendar\ndate: due').replace('15 November', '22 November'),
    [`research/competitors.md@${BASE}`]: RESEARCH, [`research/competitors.md@${HEAD}`]: RESEARCH.replace('Three similar', 'Three similar, comparable'),
};
const comments = {
    14: [{ id: 1, body: 'Agreed. The sync fix needs two more weeks.', user: { login: 'budi' }, created_at: ago(1.5) }, { id: 2, body: 'I moved the beta note too, so the schedule stays in one piece.', user: { login: 'sari' }, created_at: ago(1) }],
    13: [{ id: 3, body: 'The calendar reads better than the list. Merging after the release date is settled.', user: { login: 'dewi' }, created_at: ago(20) }],
};
const DIFF_14 = [
    'diff --git a/plans/launch.md b/plans/launch.md', '--- a/plans/launch.md', '+++ b/plans/launch.md', '@@ -5,7 +5,7 @@ Release Markwork 1.0 for Linux users, complete with folder syncing.',
    ' ## Schedule', ' ', ' - Closed beta: 20 October', '-- Public release: 15 November', '+- Public release: 22 November', ' - Evaluation: 30 November', '',
    'diff --git a/plans/schedule.md b/plans/schedule.md', '--- a/plans/schedule.md', '+++ b/plans/schedule.md', '@@ -5,4 +5,4 @@ layout: list',
    ' # Release schedule', ' ', ' - Closed beta: 20 October', '-- Public release: 15 November', '+- Public release: 22 November', '',
].join('\n');

const json = value => ({ status: 200, body: JSON.stringify(value) });
function answer(request) {
    if (request.url === 'https://git.example.org/api/v1/user') return json({ login: 'eka' });
    if (request.url === 'https://git.example.org/api/v1/version') return json({ version: '11.0.0+gitea-1.22.0' });
    const path = request.url.slice(API.length);
    if (path === '') return json({ name: 'launch', owner: { login: 'markwork' }, clone_url: process.env.MARKWORK_CAPTURE_BARE, default_branch: 'main', fork: false, permissions: { push: false } });
    if (path.startsWith('/pulls?')) return json(pulls);
    const n = Number(/\/(?:pulls|issues)\/(\d+)/.exec(path)?.[1]);
    if (/^\/pulls\/\d+$/.test(path)) return json(pulls.find(p => p.number === n) ?? {});
    if (path.endsWith('/files') || path.includes('/files?')) return json(files[n] ?? []);
    if (path === '/pulls/14.diff') return { status: 200, body: DIFF_14 };
    if (path.endsWith('.diff')) return { status: 200, body: '' };
    if (path.endsWith('/comments')) return json(comments[n] ?? []);
    const raw = /^\/raw\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
    if (raw) { const hit = content[`${decodeURIComponent(raw[1])}@${raw[2]}`]; return hit === undefined ? { status: 404, body: '{}' } : { status: 200, body: hit }; }
    return { status: 404, body: '{"message":"not found"}' };
}

export const services = {
    tokens: { get: async () => ({ token: 'example', source: 'env' }), set: async () => 'env', clear: async () => {} },
    transport: async request => answer(request),
    remoteUrl: async () => 'https://git.example.org/markwork/launch.git',
};
