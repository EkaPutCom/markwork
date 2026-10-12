// Reads a git remote URL into the forge host and the repository path. Pure: the caller runs `git remote get-url`.

import type { RepoRef } from './types.js';

const strip = (path: string) => path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');

function build(scheme: 'http' | 'https', host: string, path: string): RepoRef | null {
    const parts = strip(path).split('/').filter(Boolean);
    if (parts.length < 2 || !host) return null;
    const repo = parts[parts.length - 1], owner = parts[parts.length - 2];
    const prefix = parts.slice(0, -2).join('/');
    return { baseUrl: `${scheme}://${host}${prefix ? `/${prefix}` : ''}`, host, owner, repo };
}

// https://host[:port]/owner/repo(.git), ssh://git@host[:port]/owner/repo.git, git@host:owner/repo.git.
// SSH remotes say nothing about the web port or scheme of the forge, so they map to https on the default port.
export function parseRemote(url: string): RepoRef | null {
    const text = url.trim();
    const web = /^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(text);
    if (web) return build(web[1] === 'http' ? 'http' : 'https', web[2], web[3]);
    const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(text);
    if (ssh) return build('https', ssh[1], ssh[2]);
    const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(text);
    if (scp) return build('https', scp[1], scp[2]);
    return null;
}
