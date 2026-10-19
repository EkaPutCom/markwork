// The lines of a diff, drawn once for every place that shows one: a proposal of the Assistant, a commit in the history viewer,
// a file of a pull request.

import type { DiffLine } from '../../src/gitlog.js';

export function DiffLines({ lines, className }: { lines: DiffLine[]; className?: string }) {
    return <pre className={`diff${className ? ` ${className}` : ''}`}>{lines.map((l, i) => <div key={i} className={`line ${l.kind}`}>{l.text || ' '}</div>)}</pre>;
}
