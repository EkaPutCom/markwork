// The Search panel: a query with its options, the results grouped by file, and Replace All. The core
// searches (app/search.ts); this draws what it sends and reports what the user did.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { useClient, useStore } from '../lib/useClient';
import { Button } from '../ui/button';
import { IconButton } from '../ui/icon-button';
import { Input } from '../ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group';
import { Toggle } from '../ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

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
                <div className="side-title">Search</div>
                <IconButton label="Search again" onClick={() => client.setSearchForm({ form: { ...form, text } })}><Icon name="view-refresh" /></IconButton>
            </div>
            <div className="search-form">
                <IconButton size="icon-sm" label="Show Replace" aria-pressed={replace} onClick={() => client.setSearchForm({ replace: !replace })}>
                    <Icon name={replace ? 'pan-down' : 'pan-end'} />
                </IconButton>
                <div className="fields">
                    <InputGroup className="h-8">
                        <InputGroupAddon><Icon name="edit-find" /></InputGroupAddon>
                        <InputGroupInput ref={field} type="search" aria-label="Search" placeholder="Search" value={text} aria-invalid={results?.invalid || undefined}
                            onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') client.setSearchForm({ form: { ...form, text } }); }} />
                        <InputGroupAddon align="inline-end" className="gap-0.5">
                            {OPTIONS.map(o => (
                                <Tooltip key={o.key}>
                                    <TooltipTrigger asChild>
                                        <Toggle size="xs" className="h-5 min-w-5 font-mono text-2xs" aria-label={o.title} pressed={form[o.key]}
                                            onPressedChange={on => client.setSearchForm({ form: { ...form, [o.key]: on } })}>{o.label}</Toggle>
                                    </TooltipTrigger>
                                    <TooltipContent>{o.title}</TooltipContent>
                                </Tooltip>
                            ))}
                        </InputGroupAddon>
                    </InputGroup>
                    {replace && (
                        <InputGroup className="h-8">
                            <InputGroupInput aria-label="Replace" placeholder="Replace" value={replacement} onChange={e => client.setSearchForm({ replacement: e.target.value })} />
                            <InputGroupAddon align="inline-end">
                                <InputGroupButton aria-label="Replace All" disabled={!results || results.total === 0} onClick={() => client.replaceAll()}>All</InputGroupButton>
                            </InputGroupAddon>
                        </InputGroup>
                    )}
                    <IconButton variant="secondary" size="icon-xs" className="more h-5 self-end" label="Files to include and exclude" aria-expanded={filters} aria-pressed={filters || filtered}
                        onClick={() => setFilters(v => !v)}><Icon name="view-more-horizontal" /></IconButton>
                    {filters && (
                        <>
                            <Input className="h-8" aria-label="Files to include" title={GLOBS} placeholder="Files to include: agenda/**, *.md" value={form.include} onChange={e => client.setSearchForm({ form: { ...form, include: e.target.value } })} />
                            <Input className="h-8" aria-label="Files to exclude" title={GLOBS} placeholder="Files to exclude: drafts/**" value={form.exclude} onChange={e => client.setSearchForm({ form: { ...form, exclude: e.target.value } })} />
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
                            <Button variant="ghost" className="file-name h-auto justify-start font-normal text-left" aria-expanded={open} onClick={() => fold(f.file)}>
                                <Icon name={open ? 'pan-down' : 'pan-end'} size={12} />
                                <span className="label"><b>{name}</b>{folder && <span className="folder"> {folder}</span>}</span><span className="count">{f.hits.length}</span>
                            </Button>
                            {open && f.hits.map((h, i) => (
                                <Button key={i} variant="ghost" className="hit h-auto justify-start font-normal text-left" role="treeitem" onClick={() => client.openHit(f.file, i)}>
                                    <span className="line">{h.line + 1}</span>
                                    <span className="snippet">{h.before}<mark>{h.match}</mark>{h.after}</span>
                                </Button>
                            ))}
                        </div>
                    );
                })}
            </div>
        </aside>
    );
}
