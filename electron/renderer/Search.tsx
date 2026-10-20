// The Search panel: a query with its options, the results grouped by file, and Replace All. The core
// searches (app/search.ts); this draws what it sends and reports what the user did.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.js';
import { useClient, useStore } from './useClient.js';

const OPTIONS = [
    { key: 'caseSensitive', label: 'Aa', title: 'Match Case' },
    { key: 'wholeWord', label: 'ab', title: 'Match Whole Word' },
    { key: 'regex', label: '.*', title: 'Use Regular Expression' },
] as const;

const GLOBS = 'Separate patterns with commas. * matches within a folder, ** matches across folders, a name matches that folder or file anywhere.';

export function Search() {
    const client = useClient();
    const { search } = useStore();
    const { form, results, replace, replacement } = search;
    const field = useRef<HTMLInputElement>(null);
    // The ··· button folds the two filter fields away; it stays lit while a filter is set, so a hidden filter is not forgotten.
    const [filters, setFilters] = useState(false);
    const [folded, setFolded] = useState<Set<string>>(new Set());
    const [text, setText] = useState(form.text);   // typed text is sent after a short pause
    useEffect(() => { setText(form.text); }, [form.text]);
    useEffect(() => { field.current?.focus(); field.current?.select(); }, [search.focus]);
    useEffect(() => {
        if (text === form.text) return;
        const timer = setTimeout(() => client.setSearchForm({ form: { ...form, text } }), 200);
        return () => clearTimeout(timer);
    }, [text, form, client]);
    const filtered = form.include.trim() !== '' || form.exclude.trim() !== '';
    const fold = (file: string) => setFolded(f => { const next = new Set(f); if (next.has(file)) next.delete(file); else next.add(file); return next; });

    return (
        <aside className="sidebar search" aria-label="Search">
            <div className="side-head">
                <div className="side-title">SEARCH</div>
                <button className="button flat" title="Search again" aria-label="Search again" onClick={() => client.setSearchForm({ form: { ...form, text } })}><Icon name="view-refresh" /></button>
            </div>
            <div className="search-form">
                <button className={`button expand${replace ? ' checked' : ''}`} title="Replace" aria-label="Show Replace" aria-pressed={replace} onClick={() => client.setSearchForm({ replace: !replace })}>
                    <Icon name={replace ? 'pan-down' : 'pan-end'} />
                </button>
                <div className="fields">
                    <div className="entry">
                        <Icon name="edit-find" />
                        <input ref={field} type="search" aria-label="Search" placeholder="Search" value={text} aria-invalid={results?.invalid || undefined}
                            onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') client.setSearchForm({ form: { ...form, text } }); }} />
                        {OPTIONS.map(o => (
                            <button key={o.key} className={`chip-button${form[o.key] ? ' checked' : ''}`} title={o.title} aria-label={o.title} aria-pressed={form[o.key]}
                                onClick={() => client.setSearchForm({ form: { ...form, [o.key]: !form[o.key] } })}>{o.label}</button>
                        ))}
                    </div>
                    {replace && (
                        <div className="entry">
                            <input aria-label="Replace" placeholder="Replace" value={replacement} onChange={e => client.setSearchForm({ replacement: e.target.value })} />
                            <button className="chip-button" title="Replace All" aria-label="Replace All" disabled={!results || results.total === 0} onClick={() => client.replaceAll()}>All</button>
                        </div>
                    )}
                    <button className={`chip-button more${filters || filtered ? ' checked' : ''}`} title="Files to include and exclude" aria-label="Files to include and exclude" aria-expanded={filters}
                        onClick={() => setFilters(v => !v)}><Icon name="view-more-horizontal" /></button>
                    {filters && (
                        <>
                            <div className="entry"><input aria-label="Files to include" title={GLOBS} placeholder="Files to include: agenda/**, *.md" value={form.include} onChange={e => client.setSearchForm({ form: { ...form, include: e.target.value } })} /></div>
                            <div className="entry"><input aria-label="Files to exclude" title={GLOBS} placeholder="Files to exclude: drafts/**" value={form.exclude} onChange={e => client.setSearchForm({ form: { ...form, exclude: e.target.value } })} /></div>
                        </>
                    )}
                </div>
            </div>
            {results?.message && <div className={`search-message${results.invalid ? ' error' : ''}`} role="status">{results.message}</div>}
            <div className="results" role="tree" aria-label="Results">
                {results?.files.map(f => {
                    const slash = f.file.lastIndexOf('/');
                    const name = f.file.slice(slash + 1), folder = slash > 0 ? f.file.slice(0, slash) : '';
                    const open = !folded.has(f.file);
                    return (
                        <div key={f.file} className="result-file" role="group" aria-label={f.file}>
                            <button className="file-name" aria-expanded={open} onClick={() => fold(f.file)}>
                                <Icon name={open ? 'pan-down' : 'pan-end'} size={12} />
                                <span className="label"><b>{name}</b>{folder && <span className="folder"> {folder}</span>}</span><span className="count">{f.hits.length}</span>
                            </button>
                            {open && f.hits.map((h, i) => (
                                <button key={i} className="hit" role="treeitem" onClick={() => client.openHit(f.file, i)}>
                                    <span className="line">{h.line + 1}</span>
                                    <span className="snippet">{h.before}<mark>{h.match}</mark>{h.after}</span>
                                </button>
                            ))}
                        </div>
                    );
                })}
            </div>
        </aside>
    );
}
