// Search and replace in all the notes, in the application layer: the query the Search panel reports, the search itself
// (markdown/search.ts over the workspace's files, unsaved documents from their editor), the results sent back as plain
// data, opening a hit with its match selected, and replacing every hit as one batch. The panel of a frontend draws the
// results it is sent and reports what the user did through its on* actions (docs/design/protocol.md 6.5); a hit it
// names is one it was shown, by file and position in that file's list.

import { projectPath } from '../agent/path.js';
import type { Change } from '../agent/changes.js';
import { activeFilters, buildPattern, pathFilter, replaceMatches, searchFiles, MAX_HITS, type FileHits, type SearchOptions } from '../markdown/search.js';
import { _, fmt, ngettext } from '../i18n.js';
import type { WorkspaceRepository } from '../workspace.js';
import { applyChangeBatch, type AgentWriteHost } from './agentwrites.js';
import type { TextEditor } from './document.js';

const MAX_FILES = 5000;   // the Markdown files read for one search
const codePoints = (text: string): number => Array.from(text).length;   // the editor counts columns in code points

// What the panel's fields hold.
export interface SearchQuery extends SearchOptions {
    text: string;
    include: string;      // comma separated globs; empty = every file
    exclude: string;
}

// What the panel shows after a search. `message` is the summary line (empty = none); `invalid` marks the query as one
// that cannot run (a regular expression that does not compile), so the field can show it.
export interface SearchResults {
    message: string;
    invalid: boolean;
    files: FileHits[];
    total: number;
}

// The panel as this controller drives it.
export interface SearchView {
    onSearch: (query: SearchQuery) => void;                    // a field or an option changed, or the user asked again
    onOpenHit: (file: string, index: number) => void;          // a hit of a file's list was activated
    onReplaceAll: (replacement: string) => Promise<void>;
    showResults(results: SearchResults): void;
}

// The question before replacing; a test replaces it with an immediate answer.
export interface SearchDialogs {
    confirm(message: string, detail: string, accept: string): Promise<boolean>;
}

export interface SearchHost<E extends TextEditor = TextEditor> extends AgentWriteHost<E> {
    readonly searchView: SearchView;
    readonly workspace: WorkspaceRepository;
}

const NOTHING: SearchResults = { message: '', invalid: false, files: [], total: 0 };

export class SearchController<E extends TextEditor = TextEditor> {
    private query: SearchQuery | null = null;
    private pattern: RegExp | null = null;
    private results: SearchResults = NOTHING;

    constructor(private readonly host: SearchHost<E>, readonly dialogs: SearchDialogs) {
        const view = host.searchView;
        view.onSearch = query => this.search(query);
        view.onOpenHit = (file, index) => this.openHit(file, index);
        view.onReplaceAll = replacement => this.replaceAll(replacement);
    }

    // Search again with the last query (files changed, or the user asked); nothing when there was no query yet.
    // `texts`: the contents some files have now, by name, for a write that has not reached the workspace yet.
    refresh(texts: ReadonlyMap<string, string> = new Map()): void {
        if (this.query) this.search(this.query, texts);
    }

    search(query: SearchQuery, texts: ReadonlyMap<string, string> = new Map()): void {
        this.query = query;
        this.pattern = null;
        this.show(this.run(query, texts));
    }

    private run(query: SearchQuery, texts: ReadonlyMap<string, string>): SearchResults {
        const pattern = buildPattern(query.text, query);
        if (!pattern) return NOTHING;
        if (!(pattern instanceof RegExp)) return { ...NOTHING, message: pattern.error, invalid: true };
        const root = this.host.root();
        if (!root) return { ...NOTHING, message: _('Open a folder to search in its notes.') };
        this.pattern = pattern;
        const keep = pathFilter(query.include, query.exclude);
        const files = this.host.workspace.files(root, { freshness: 'current', limit: MAX_FILES }).map(f => ({ name: f.name, text: texts.get(f.name) ?? f.text }));
        const found = searchFiles(keep ? files.filter(f => keep(f.name)) : files, pattern);
        return { message: this.describe(query, found.total, found.files.length, found.truncated), invalid: false, files: found.files, total: found.total };
    }

    private describe(query: SearchQuery, total: number, files: number, truncated: boolean): string {
        const filters = activeFilters(query.include, query.exclude);
        const note = filters ? ` · ${fmt(ngettext('{count} filter', '{count} filters', filters), { count: filters })}` : '';
        if (total === 0) return _('No results') + note;
        const text = fmt(ngettext('{count} result in {files} file', '{count} results in {files} files', total), { count: total, files });
        return (truncated ? fmt(_('{text} (only the first {max} are shown)'), { text, max: MAX_HITS }) : text) + note;
    }

    private show(results: SearchResults): void {
        this.results = results;
        this.host.searchView.showResults(results);
    }

    // Open the file of a hit and select the match.
    openHit(file: string, index: number): void {
        const root = this.host.root();
        const hit = this.results.files.find(f => f.file === file)?.hits[index];
        if (!root || !hit || !this.host.openInTab(projectPath(root, file))) return;
        const editor = this.host.active().editor;
        const line = editor.getText().split('\n')[hit.line] ?? '';
        editor.selectRange(hit.line, codePoints(line.slice(0, hit.start)), codePoints(line.slice(hit.start, hit.end)));
    }

    // The changes that replace every hit. Files are read again, so unsaved text is what changes.
    plan(replacement: string): Change[] {
        const { pattern, query } = this;
        if (!pattern || !query) return [];
        const root = this.host.root();
        if (!root) return [];
        const wanted = new Set(this.results.files.map(f => f.file));
        const changes: Change[] = [];
        for (const file of this.host.workspace.files(root, { freshness: 'current', limit: MAX_FILES })) {
            if (!wanted.has(file.name)) continue;
            const { text, count } = replaceMatches(file.text, pattern, replacement, query.regex);
            if (count > 0 && text !== file.text) changes.push({ kind: 'edit', file: file.name, before: file.text, after: text, reason: _('Replace in all notes') });
        }
        return changes;
    }

    async replaceAll(replacement: string): Promise<void> {
        const changes = this.plan(replacement);
        if (!changes.length) return;
        const { total } = this.results;
        const detail = fmt(ngettext('{count} occurrence in {files} file will be replaced. Open files can be undone with Ctrl+Z; other files are written right away.',
            '{count} occurrences in {files} files will be replaced. Open files can be undone with Ctrl+Z; other files are written right away.', total), { count: total, files: changes.length });
        if (!await this.dialogs.confirm(_('Replace in all notes?'), detail, _('Replace All'))) return;
        const error = applyChangeBatch(this.host, changes);
        if (error) this.show({ ...this.results, message: error });
        else this.refresh(new Map(changes.map(c => [c.file, c.after])));
    }
}
