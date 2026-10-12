// The one unified diff of a whole pull request, cut into the part of each file. Pure.

const HEADER = /^diff --git a\/(.+) b\/(.+)$/;

// The diff of `path`, header lines included; '' when the diff does not mention it.
// A renamed file is matched by its new name, so the pull request's file list (new names) finds its part.
export function fileDiff(diff: string, path: string): string {
    const parts = diff.split(/^(?=diff --git )/m);
    for (const part of parts) {
        const match = HEADER.exec(part.split('\n', 1)[0]);
        if (match && match[2] === path) return part;
    }
    return '';
}

// A diff that git could not show line by line.
export const isBinaryDiff = (part: string): boolean => /^Binary files .* differ$|^GIT binary patch$/m.test(part);
