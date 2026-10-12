// Tools the model may call to read documents in its own workspace (function calling). All are read-only and pure:
// they work on the file list supplied by the caller (not the disk), so they are easy to test and cannot escape the project.
// Pure TypeScript without GTK.

import { estimateTokens, matchMention, projectMap, rankChunks, splitChunks, tokenize, type SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';
import { describeSchema, queryNotes, SCHEMA_TOOLS } from './schematools.js';

// "1 line" / "2 lines": the short result summary shown in the interface.
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// Per-call limits; the total budget per question is kept by the caller (session.ts).
export const MAX_RESULT_TOKENS = 6000;
const MAX_SEARCH_HITS = 15;
const MAX_TEXT_MATCHES = 40;
const MAX_SNIPPET_CHARS = 900;

export const TOOLS: ToolSpec[] = [
    {
        name: 'list_files',
        description: 'List all document files in the work folder with their word counts and headings (an outline of the contents). Use it to find out which files and sections exist.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'search_documents',
        description: 'Search for the document sections most relevant to a topic or question (ranked keyword search). Returns snippets per section with the file name, heading, and line numbers. Good for topics, decisions, plans, events, or ideas.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Keywords or a short sentence about what is being looked for' },
                max: { type: 'integer', description: `Maximum number of snippets (1–${MAX_SEARCH_HITS}, default 8)` },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'search_text',
        description: 'Search for occurrences of exact text (case-insensitive) across all documents or a single file, and return the lines where it appears. Good for names, places, numbers, dates, or specific terms, e.g. checking consistency.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'The text to look for, exactly as written' },
                file: { type: 'string', description: 'Limit to one file (optional)' },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
    {
        name: 'read_file',
        description: 'Read the contents of a document file (can be partial: from_line to to_line, line numbers start at 1). The result includes line numbers. Long files are truncated; continue with the next from_line.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'File name as in list_files' },
                from_line: { type: 'integer', description: 'First line (default 1)' },
                to_line: { type: 'integer', description: 'Last line (default: to the end or the length limit)' },
            },
            required: ['name'],
            additionalProperties: false,
        },
    },
    ...SCHEMA_TOOLS,
];

export interface ToolOutcome {
    content: string;   // sent back to the model
    summary: string;   // a short phrase for the interface, e.g. "5 snippets"
}

const clip = (text: string, maxTokens: number): { text: string; clipped: boolean } => {
    if (estimateTokens(text) <= maxTokens) return { text, clipped: false };
    return { text: text.slice(0, maxTokens * 3), clipped: true };
};

const asString = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const asInt = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;

function suggest(name: string, files: SourceFile[]): string {
    const wanted = tokenize(name);
    const close = files.map(f => f.name).filter(n => wanted.some(t => tokenize(n).includes(t))).slice(0, 5);
    return close.length ? ` Maybe you meant: ${close.join(', ')}.` : ' Call list_files to see the existing names.';
}

const listFiles = (files: SourceFile[]): ToolOutcome => ({
    content: files.length ? projectMap(files.map(f => ({ ...f, opened: false })), MAX_RESULT_TOKENS) : 'There are no document files in the project yet.',
    summary: plural(files.length, 'file', 'files'),
});

function searchDocuments(files: SourceFile[], args: Record<string, unknown>): ToolOutcome {
    const query = asString(args.query);
    if (!query) return { content: 'The "query" argument is required.', summary: 'empty query' };
    const limit = Math.min(Math.max(asInt(args.max) ?? 8, 1), MAX_SEARCH_HITS);
    const terms = new Map(tokenize(query).map(t => [t, 1] as const));
    const ranked = rankChunks(files.flatMap(f => splitChunks(f.name, f.text)), terms).slice(0, limit);
    if (!ranked.length) return { content: `No document section matches "${query}". Try other keywords or search_text.`, summary: 'no results' };
    const body = ranked.map(({ chunk: c }) => {
        const text = c.text.length > MAX_SNIPPET_CHARS ? `${c.text.slice(0, MAX_SNIPPET_CHARS)} […]` : c.text;
        return `[${c.file} › ${c.heading || 'start of file'} · lines ${c.start + 1}–${c.end + 1}]\n${text}`;
    }).join('\n\n');
    const { text, clipped } = clip(body, MAX_RESULT_TOKENS);
    return { content: clipped ? `${text}\n[… results truncated; narrow the query …]` : text, summary: plural(ranked.length, 'snippet', 'snippets') };
}

function searchText(files: SourceFile[], args: Record<string, unknown>): ToolOutcome {
    const needle = asString(args.text);
    if (!needle) return { content: 'The "text" argument is required.', summary: 'empty text' };
    let scope = files;
    const only = asString(args.file);
    if (only) {
        const file = matchMention(only, files);
        if (!file) return { content: `File "${only}" was not found.${suggest(only, files)}`, summary: 'file not found' };
        scope = [file];
    }
    const lower = needle.toLowerCase();
    const lines: string[] = [];
    let total = 0;
    for (const f of scope) {
        f.text.split('\n').forEach((line, i) => {
            if (!line.toLowerCase().includes(lower)) return;
            total++;
            if (lines.length < MAX_TEXT_MATCHES) lines.push(`${f.name}:${i + 1}: ${line.trim().slice(0, 240)}`);
        });
    }
    if (!total) return { content: `The text "${needle}" was not found${only ? ` in ${only}` : ''}.`, summary: 'not found' };
    const more = total > lines.length ? `\n[… ${total - lines.length} more occurrences not shown; narrow with the file parameter …]` : '';
    return { content: `${total} lines contain "${needle}":\n${lines.join('\n')}${more}`, summary: plural(total, 'line', 'lines') };
}

function readFile(files: SourceFile[], args: Record<string, unknown>): ToolOutcome {
    const name = asString(args.name);
    if (!name) return { content: 'The "name" argument is required.', summary: 'empty name' };
    const file = matchMention(name, files);
    if (!file) return { content: `File "${name}" was not found.${suggest(name, files)}`, summary: 'file not found' };
    const lines = file.text.split('\n');
    const from = Math.min(Math.max(asInt(args.from_line) ?? 1, 1), lines.length);
    const to = Math.min(Math.max(asInt(args.to_line) ?? lines.length, from), lines.length);
    const out: string[] = [];
    let size = 0, last = from - 1;
    for (let i = from - 1; i < to; i++) {
        const line = `${i + 1}│ ${lines[i]}`;
        size += estimateTokens(line) + 1;
        if (size > MAX_RESULT_TOKENS && out.length) break;
        out.push(line);
        last = i + 1;
    }
    const head = `[${file.name}, lines ${from}–${last} of ${lines.length}]`;
    const tail = last < to ? `\n[… truncated; continue with from_line=${last + 1} …]` : '';
    return { content: `${head}\n${out.join('\n')}${tail}`, summary: `lines ${from}–${last}` };
}

// Run one call. Never throws: argument errors are returned as text so the model can fix them.
export function runTool(name: string, rawArguments: string, files: SourceFile[]): ToolOutcome {
    let args: Record<string, unknown> = {};
    if (rawArguments.trim()) {
        try {
            const parsed = JSON.parse(rawArguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
            else throw new Error('not an object');
        } catch (e) {
            return { content: 'The arguments are not a valid JSON object.', summary: 'invalid arguments' };
        }
    }
    switch (name) {
        case 'list_files': return listFiles(files);
        case 'search_documents': return searchDocuments(files, args);
        case 'search_text': return searchText(files, args);
        case 'read_file': return readFile(files, args);
        case 'describe_schema': return describeSchema(files, args);
        case 'query_notes': return queryNotes(files, args);
        default: return { content: `Tool "${name}" is not recognized. Available tools: ${TOOLS.map(t => t.name).join(', ')}.`, summary: 'unknown tool' };
    }
}

// Phrases for the interface: what the assistant is working on.
export function describeCall(name: string, rawArguments: string): string {
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(rawArguments || '{}') ?? {}; } catch (e) { /* show only the tool name */ }
    return Object.hasOwn(DESCRIBE, name) ? DESCRIBE[name](a) : name;
}

const DESCRIBE: Record<string, (a: Record<string, unknown>) => string> = {
    list_files: () => 'Viewing the file list',
    search_documents: a => `Searching “${asString(a.query)}”`,
    search_text: a => `Searching text “${asString(a.text)}”${asString(a.file) ? ` in ${asString(a.file)}` : ''}`,
    read_file: a => `Reading ${asString(a.name) || 'file'}${asInt(a.from_line) ? ` (from line ${asInt(a.from_line)})` : ''}`,
    create_file: a => `Proposing new file ${asString(a.name)}`,
    edit_file: a => `Proposing changes to ${asString(a.name)}`,
    describe_schema: a => asString(a.name) ? `Reading the setup of ${asString(a.name)}` : 'Reading the setup of the structured documents',
    query_notes: a => `Querying notes${asString(a.file) ? ` in ${asString(a.file)}` : ''}`,
    edit_note: a => `Proposing a note change in ${asString(a.name)}`,
    edit_schema: a => `Proposing a schema change in ${asString(a.name)}`,
    insert_text: a => `Proposing an insertion in ${asString(a.name)}`,
    delete_file: a => `Proposing to delete ${asString(a.name)}`,
    move_file: a => `Proposing to move ${asString(a.name)} to ${asString(a.destination)}`,
};
