// REST client of Forgejo and Gitea (same API, /api/v1). It only builds requests and reads answers through a Transport,
// so it runs the same against libsoup and against the fake of the tests.

import {
    ForgeError, type ForgeProvider, type MergeMethod, type PullFile, type PullRequest, type PullState, type RepoRef, type Transport,
} from './types.js';

const PAGE = 50;
const MAX_PAGES = 5;      // 250 pull requests; more than that are not a list anybody reads in a sidebar

interface ApiPull {
    number: number; title: string; state: string; merged?: boolean; mergeable?: boolean | null;
    user?: { login?: string }; head?: { ref?: string; sha?: string }; base?: { ref?: string; sha?: string };
    comments?: number; created_at?: string; updated_at?: string; html_url?: string;
}
interface ApiFile { filename: string; previous_filename?: string; status: string; additions?: number; deletions?: number }

function pullState(p: ApiPull): PullState {
    if (p.merged) return 'merged';
    return p.state === 'open' ? 'open' : 'closed';
}

function toPull(p: ApiPull): PullRequest {
    return {
        number: p.number, title: p.title, author: p.user?.login ?? '', state: pullState(p),
        mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
        headRef: p.head?.ref ?? '', baseRef: p.base?.ref ?? '', headSha: p.head?.sha ?? '', baseSha: p.base?.sha ?? '', comments: p.comments ?? 0,
        createdAt: p.created_at ?? '', updatedAt: p.updated_at ?? '', url: p.html_url ?? '',
    };
}

const FILE_STATUS: Record<string, PullFile['status']> = { added: 'added', deleted: 'deleted', removed: 'deleted', renamed: 'renamed' };

function toFile(f: ApiFile): PullFile {
    return {
        path: f.filename, ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
        status: FILE_STATUS[f.status] ?? 'modified', additions: f.additions ?? 0, deletions: f.deletions ?? 0,
    };
}

export class GiteaProvider implements ForgeProvider {
    constructor(private readonly repo: RepoRef, private readonly token: string, private readonly transport: Transport) {}

    private get api(): string {
        return `${this.repo.baseUrl}/api/v1/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.repo)}`;
    }

    private async request(method: 'GET' | 'POST', path: string, body?: object, accept = 'application/json'): Promise<string> {
        if (!this.token) throw new ForgeError('auth', `No access token for ${this.repo.host}`);
        let response;
        try {
            response = await this.transport({
                method, url: `${this.api}${path}`,
                headers: { Authorization: `token ${this.token}`, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
        } catch (e) {
            throw new ForgeError('network', `Cannot reach ${this.repo.host}: ${e instanceof Error ? e.message : e}`);
        }
        if (response.status >= 200 && response.status < 300) return response.body;
        throw httpError(response.status, response.body, this.repo.host);
    }

    private async json<T>(path: string): Promise<T> {
        const text = await this.request('GET', path);
        try {
            return JSON.parse(text) as T;
        } catch (e) {
            throw new ForgeError('server', `${this.repo.host} sent an answer that is not JSON`);
        }
    }

    async listPulls(state: 'open' | 'closed' | 'all'): Promise<PullRequest[]> {
        const all: PullRequest[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const items = await this.json<ApiPull[]>(`/pulls?state=${state}&limit=${PAGE}&page=${page}`);
            all.push(...items.map(toPull));
            if (items.length < PAGE) break;
        }
        return all;
    }

    async getPull(number: number): Promise<PullRequest> {
        return toPull(await this.json<ApiPull>(`/pulls/${number}`));
    }

    async getFiles(number: number): Promise<PullFile[]> {
        const files: PullFile[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const items = await this.json<ApiFile[]>(`/pulls/${number}/files?limit=${PAGE}&page=${page}`);
            files.push(...items.map(toFile));
            if (items.length < PAGE) break;
        }
        return files;
    }

    async getDiff(number: number): Promise<string> {
        return this.request('GET', `/pulls/${number}.diff`, undefined, 'text/plain');
    }

    async getContent(path: string, ref: string): Promise<string | null> {
        const escaped = path.split('/').map(encodeURIComponent).join('/');
        try {
            return await this.request('GET', `/raw/${escaped}?ref=${encodeURIComponent(ref)}`, undefined, 'text/plain');
        } catch (e) {
            if (e instanceof ForgeError && e.failure === 'not-found') return null;
            throw e;
        }
    }

    async merge(number: number, method: MergeMethod): Promise<void> {
        await this.request('POST', `/pulls/${number}/merge`, { Do: method });
    }
}

// The forge explains itself in {"message": "..."}; fall back to the status when it does not.
function httpError(status: number, body: string, host: string): ForgeError {
    let detail = '';
    try { detail = String(JSON.parse(body).message ?? ''); } catch (e) { /* not JSON */ }
    const suffix = detail ? `: ${detail}` : '';
    if (status === 401 || status === 403) return new ForgeError('auth', `${host} refused the access token (HTTP ${status})${suffix}`, status);
    if (status === 404) return new ForgeError('not-found', `Not found on ${host}${suffix}`, status);
    if (status === 405 || status === 409) return new ForgeError('not-mergeable', `Cannot merge${suffix || ` (HTTP ${status})`}`, status);
    return new ForgeError('server', `${host} answered HTTP ${status}${suffix}`, status);
}
