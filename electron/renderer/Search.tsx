// The Search panel (ui/searchpanel.ts): a query with its options, the results grouped by file, and Replace All. The core
// searches (app/search.ts); this draws what it sends and reports what the user did.

import { useEffect, useRef, useState } from 'react';
import { useClient, useStore } from './useClient.js';

const OPTIONS = [
    { key: 'caseSensitive', label: 'Aa', title: 'Match Case' },
    { key: 'wholeWord', label: 'ab', title: 'Match Whole Word' },
    { key: 'regex', label: '.*', title: 'Use Regular Expression' },
] as const;

export function Search() {
    const client = useClient();
    const { search } = useStore();
    const { form, results, replace, replacement } = search;
    const field = useRef<HTMLInputElement>(null);
    const [filters, setFilters] = useState(false);
    const [text, setText] = useState(form.text);   // typed text is sent after a short pause
    useEffect(() => { setText(form.text); }, [form.text]);
    useEffect(() => { field.current?.focus(); field.current?.select(); }, [search.focus]);
    useEffect(() => {
        if (text === form.text) return;
        const timer = setTimeout(() => client.setSearchForm({ form: { ...form, text } }), 200);
        return () => clearTimeout(timer);
    }, [text, form, client]);

    return (
        <aside className="sidebar search" aria-label="Search">
            <div className="side-title">SEARCH</div>
            <div className="search-form">
                <div className="field">
                    <button className="button flat narrow" aria-label="Show Replace" aria-pressed={replace} onClick={() => client.setSearchForm({ replace: !replace })}>{replace ? '▾' : '▸'}</button>
                    <input ref={field} type="search" aria-label="Search" placeholder="Search" value={text} aria-invalid={results?.invalid || undefined}
                        onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') client.setSearchForm({ form: { ...form, text } }); }} />
                    {OPTIONS.map(o => (
                        <button key={o.key} className={`button flat narrow option${form[o.key] ? ' checked' : ''}`} title={o.title} aria-label={o.title} aria-pressed={form[o.key]}
                            onClick={() => client.setSearchForm({ form: { ...form, [o.key]: !form[o.key] } })}>{o.label}</button>
                    ))}
                </div>
                {replace && (
                    <div className="field">
                        <input aria-label="Replace" placeholder="Replace" value={replacement} onChange={e => client.setSearchForm({ replacement: e.target.value })} />
                        <button className="button" disabled={!results || results.total === 0} onClick={() => client.replaceAll()}>Replace All</button>
                    </div>
                )}
                <button className="link" aria-expanded={filters} onClick={() => setFilters(v => !v)}>{filters ? '▾' : '▸'} Files to include / exclude</button>
                {filters && (
                    <div className="filters">
                        <input aria-label="Files to include" placeholder="Include, e.g. journal/*" value={form.include} onChange={e => client.setSearchForm({ form: { ...form, include: e.target.value } })} />
                        <input aria-label="Files to exclude" placeholder="Exclude, e.g. archive/*" value={form.exclude} onChange={e => client.setSearchForm({ form: { ...form, exclude: e.target.value } })} />
                    </div>
                )}
            </div>
            {results?.message && <div className={`search-message${results.invalid ? ' error' : ''}`} role="status">{results.message}</div>}
            <div className="results" role="tree" aria-label="Results">
                {results?.files.map(f => (
                    <div key={f.file} className="result-file" role="group" aria-label={f.file}>
                        <div className="file-name"><span className="label">{f.file}</span><span className="count">{f.hits.length}</span></div>
                        {f.hits.map((h, i) => (
                            <button key={i} className="hit" role="treeitem" onClick={() => client.openHit(f.file, i)}>
                                <span className="line">{h.line + 1}</span>
                                <span className="snippet">{h.before}<mark>{h.match}</mark>{h.after}</span>
                            </button>
                        ))}
                    </div>
                ))}
            </div>
        </aside>
    );
}
