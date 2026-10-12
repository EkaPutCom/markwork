// Shared types of the forge layer: a Git hosting service (Forgejo/Gitea first) seen through the few things Markwork needs
// for collaboration. No GTK here; the widgets and the window only know these types, never the REST details.

// Where the repository of the open folder lives, taken from its git remote.
export interface RepoRef {
    baseUrl: string;      // https://git.example.org (with a path prefix when the forge is served below a path)
    host: string;         // git.example.org[:port]; the key under which the token is stored
    owner: string;
    repo: string;
}

export type PullState = 'open' | 'closed' | 'merged';

export interface PullRequest {
    number: number;
    title: string;
    author: string;
    state: PullState;
    // null = the forge has not computed it yet (a fresh push).
    mergeable: boolean | null;
    headRef: string;
    baseRef: string;
    headSha: string;      // the two commits to compare; a pull request from a fork still has its head in the base repository
    baseSha: string;
    body: string;         // the description the author wrote
    comments: number;
    createdAt: string;    // ISO 8601
    updatedAt: string;
    url: string;          // the PR page in a browser
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface PullFile {
    path: string;
    previousPath?: string;
    status: FileStatus;
    additions: number;
    deletions: number;
}

// One message in the discussion under a pull request.
export interface PullComment {
    id: number;
    author: string;
    body: string;
    createdAt: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

// What went wrong, in terms the interface can act on.
export type ForgeFailure =
    | 'auth'          // no token, or the forge rejected it (401/403)
    | 'not-found'     // the repository or pull request does not exist, or the token cannot see it
    | 'not-mergeable' // conflicts, failing checks, or the PR is already closed (405/409)
    | 'network'       // the server did not answer
    | 'server';       // any other HTTP error, or an answer that could not be read

export class ForgeError extends Error {
    constructor(readonly failure: ForgeFailure, message: string, readonly status = 0) {
        super(message);
        this.name = 'ForgeError';
    }
}

export interface ForgeProvider {
    listPulls(state: 'open' | 'closed' | 'all'): Promise<PullRequest[]>;
    getPull(number: number): Promise<PullRequest>;
    getFiles(number: number): Promise<PullFile[]>;
    listComments(number: number): Promise<PullComment[]>;
    addComment(number: number, body: string): Promise<PullComment>;
    // The whole pull request as one unified diff.
    getDiff(number: number): Promise<string>;
    // A file at a commit; null = it does not exist there (added or deleted by the pull request).
    getContent(path: string, ref: string): Promise<string | null>;
    merge(number: number, method: MergeMethod): Promise<void>;
}

// The HTTP seam: the real one is libsoup (http.ts); tests pass a fake that answers from a table.
export interface HttpRequest {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
}
export interface HttpResponse { status: number; body: string }
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
