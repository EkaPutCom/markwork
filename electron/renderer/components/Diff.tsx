// The lines of a diff, drawn once for every place that shows one: a proposal of the Assistant, a commit in the history viewer,
// a file of a pull request. Drawn like VS Code: side by side when there is room, one column with both line numbers when not.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DiffLine } from '../../../src/base/gitlog.js';
import { inline, sideBySide, type DiffCell, type DiffSpan } from '../../../src/markdown/diffview.js';

const SIDE_BY_SIDE_WIDTH = 720;   // VS Code's breakpoint is wider, but its gutters are too

const MARK = { add: '+', del: '−', context: '' } as const;

function Spans({ spans }: { spans: DiffSpan[] }) {
    const text = spans.map((s, i) => s.changed ? <span key={i} className="word">{s.text}</span> : s.text);
    return <span className="text">{spans.every(s => !s.text) ? ' ' : text}</span>;
}

function Cell({ cell }: { cell: DiffCell | null }) {
    if (!cell) return <div className="cell filler" aria-hidden="true"><span className="number" /><span className="mark" /><span className="text" /></div>;
    return <div className={`cell ${cell.kind}`}><span className="number">{cell.number ?? ''}</span><span className="mark">{MARK[cell.kind]}</span><Spans spans={cell.spans} /></div>;
}

export function DiffLines({ lines, className }: { lines: DiffLine[]; className?: string }) {
    const ref = useRef<HTMLPreElement>(null);
    const [wide, setWide] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => setWide(el.clientWidth >= SIDE_BY_SIDE_WIDTH);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const rows = useMemo(() => wide ? sideBySide(lines) : null, [lines, wide]);
    const flat = useMemo(() => wide ? null : inline(lines), [lines, wide]);
    const digits = useMemo(() => String(lines.reduce((n, l) => {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(l.kind === 'hunk' ? l.text : '');
        return m ? Math.max(n, Number(m[1]) + Number(m[2] ?? 1), Number(m[3]) + Number(m[4] ?? 1)) : n;
    }, 0)).length, [lines]);
    const style = { '--diff-digits': `${Math.max(digits, 2)}ch` } as CSSProperties;
    return (
        <pre ref={ref} className={`diff ${wide ? 'side' : 'inline'}${className ? ` ${className}` : ''}`} style={style}>
            {rows?.map((r, i) => r.kind === 'hunk'
                ? <div key={i} className="row hunk">{r.text}</div>
                : <div key={i} className="row"><Cell cell={r.left} /><Cell cell={r.right} /></div>)}
            {flat?.map((r, i) => r.kind === 'hunk'
                ? <div key={i} className="row hunk">{r.text}</div>
                : <div key={i} className={`row cell ${r.kind}`}>
                    <span className="number">{r.old ?? ''}</span><span className="number">{r.new ?? ''}</span>
                    <span className="mark">{MARK[r.kind]}</span><Spans spans={r.spans} />
                </div>)}
        </pre>
    );
}

// One aligned source of the merge editor, with the same gutters and word highlighting as every other diff.
export function DiffColumn({ cells }: { cells: (DiffCell | null)[] }) {
    const digits = String(cells.reduce((n, c) => Math.max(n, c?.number ?? 0), 1)).length;
    return <pre className="diff conflict-source" style={{ '--diff-digits': `${Math.max(digits, 2)}ch` } as CSSProperties}>
        {cells.map((cell, i) => <div className="row" key={i}><Cell cell={cell} /></div>)}
    </pre>;
}
