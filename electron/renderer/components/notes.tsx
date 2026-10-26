// The parts the pages of a document's notes share (board, list, table, calendar, timeline, gallery, chart): a title
// with its Markdown, the chips of the fields, a menu at the pointer, the popover that changes one field, and the dialog
// that edits a card or a note. They draw what the core sends and answer with the operation the user made
// (src/markdown/noteedit.ts); what an operation does is the core's (and applyNoteEdit's, which the client also runs to
// show a change at once).

import { useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { DUE_FIELD, AGENT_FIELD, AGENT_NAME, DUE_INPUT, splitCard, withDueDate, type Board, type Card, type Position } from '../../../src/markdown/kanban.js';
import { fieldInputText, nearestOption, OPTION_COLORS, OPTION_TEXT, parseValue, readItem, type FieldChip, type FieldDef } from '../../../src/markdown/fields.js';
import { CREATED_FIELD, itemMeta } from '../../../src/markdown/inbox.js';
import { inlineRuns } from '../../../src/markdown/inlineruns.js';
import type { CardForm, CardRef } from '../../../src/markdown/noteedit.js';
import { Icon, type IconName } from './Icons.js';
import { Modal } from './Modals.js';
import { useClient } from '../lib/useClient.js';
import { Select } from '../ui/select.js';
import { cn } from '../lib/utils.js';
import { Badge, badgeVariants } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '../ui/dropdown-menu.js';
import { IconButton } from '../ui/icon-button.js';
import { Input } from '../ui/input.js';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group.js';
import { Label } from '../ui/label.js';
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover.js';
import { Textarea } from '../ui/textarea.js';

export const refOf = (at: Position, card: Card): CardRef => ({ at, card: card.text });

// Today, as the notes write a day: "YYYY-MM-DD" in local time.
export function todayString(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-10-20" → "20 Oct" (with the year if it is not this year).
export function formatDay(date: string, today = todayString()): string {
    const [y, m, d] = date.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}${today.startsWith(`${y}-`) ? '' : ` ${y}`}`;
}

// "2026-10-05" → "5 Oct": a day as the axes of the timeline and the chart write it.
export function dayMonth(date: string): string {
    const [, m, d] = date.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
}

// A stable color for a tag, one of eight.
export function tagColor(tag: string): number {
    let hash = 0;
    for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    return hash % 8;
}

// ---------- Text and chips ----------

// A line of inline Markdown as its runs; a [[note]] is a link that opens the note.
export function Inline({ text }: { text: string }) {
    const client = useClient();
    return (
        <>
            {inlineRuns(text, true).map((run, i) => {
                const className = run.styles.length ? run.styles.map(s => `md-${s}`).join(' ') : undefined;
                if (run.note === undefined) return <span key={i} className={className}>{run.text}</span>;
                return <a key={i} href="#" className={`note-link ${className ?? ''}`} onClick={e => { e.preventDefault(); e.stopPropagation(); client.openNote(run.note!); }}>{run.text}</a>;
            })}
        </>
    );
}

// A field, a tag, a date: a Badge, with the dot of its category color (`opt-*`, `tag-*`) from theme.css. One that can be
// changed is a button drawn as the same Badge.
export function Chip({ text, icon, className, title, onClick }: { text: string; icon?: IconName; className?: string; title?: string; onClick?: (e: React.MouseEvent) => void }) {
    const content = <>{icon && <Icon name={icon} size={12} />}{text}</>;
    return onClick
        // ui-allow: a chip is cut off with an ellipsis; its title is the one its Badge form has (the field it shows)
        ? <Button type="button" variant={null} size={null} className={cn(badgeVariants({ variant: 'secondary' }), 'note-chip', className)} title={title} onClick={e => { e.stopPropagation(); onClick(e); }}>{content}</Button>
        : <Badge variant="secondary" className={cn('note-chip', className)} title={title}>{content}</Badge>;
}

// The chip of a field: a select in the color of its option, a value that does not fit marked invalid. A click changes it.
export function FieldChips({ chips, onEdit }: { chips: FieldChip[]; onEdit?: (key: string, e: React.MouseEvent) => void }) {
    return (
        <>
            {chips.map(chip => {
                const color = chip.color ?? (chip.option !== null ? OPTION_COLORS[chip.option % OPTION_COLORS.length] : null);
                return <Chip key={chip.key} text={chip.text} title={chip.invalid ?? chip.key} className={`field${color ? ` opt-${color}` : ''}${chip.invalid ? ' invalid' : ''}`}
                    onClick={onEdit && chip.type ? e => onEdit(chip.key, e) : undefined} />;
            })}
        </>
    );
}

export function Tags({ tags }: { tags: string[] }) {
    return <>{tags.map(tag => <Chip key={tag} text={`#${tag}`} className={`tag tag-${tagColor(tag)}`} />)}</>;
}

// ---------- A menu at the pointer ----------

export interface MenuEntry { label?: string; run?: () => void; enabled?: boolean; submenu?: MenuEntry[]; separator?: boolean }

// A point on the screen that a menu or a popover opens from: a right click, or the button that asked for it.
export function Anchor({ at, ...props }: { at: { x: number; y: number } } & ComponentProps<'span'>) {
    return <span {...props} aria-hidden="true" className="pointer-anchor" style={{ left: at.x, top: at.y }} />;
}

// A DropdownMenu at the pointer; a submenu opens beside its entry. Escape and a click away close it, as any menu.
export function PopupMenu({ at, entries, onClose }: { at: { x: number; y: number }; entries: MenuEntry[]; onClose: () => void }) {
    const item = (entry: MenuEntry, key: number) => entry.separator ? <DropdownMenuSeparator key={key} /> : entry.submenu ? (
        <DropdownMenuSub key={key}>
            <DropdownMenuSubTrigger disabled={entry.enabled === false}>{entry.label}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>{entry.submenu.map(item)}</DropdownMenuSubContent>
        </DropdownMenuSub>
    ) : <DropdownMenuItem key={key} disabled={entry.enabled === false} onSelect={() => entry.run?.()}>{entry.label}</DropdownMenuItem>;
    return (
        <DropdownMenu open onOpenChange={open => { if (!open) onClose(); }}>
            <DropdownMenuTrigger asChild><Anchor at={at} /></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">{entries.map(item)}</DropdownMenuContent>
        </DropdownMenu>
    );
}

// What a page has open over it: a menu, the popover of a field, or the dialog of a card.
export function usePopup<T>() {
    const [popup, setPopup] = useState<T | null>(null);
    return [popup, setPopup, () => setPopup(null)] as const;
}

// ---------- The popover that changes one field ----------

export interface FieldEdit { def: FieldDef; current: string; at: { x: number; y: number }; apply(raw: string, option?: string): void }

// A Popover at the chip or the cell clicked; its first field has the focus.
export function FieldPopover({ edit, onClose }: { edit: FieldEdit; onClose: () => void }) {
    const { def, current, at, apply } = edit;
    const [text, setText] = useState(current);
    const ref = useRef<HTMLDivElement>(null);
    const done = (raw: string, option?: string) => { onClose(); apply(raw, option); };

    const close = def.type === 'select' ? nearestOption(def, text.trim()) : null;
    const parsed = text.trim() && def.type !== 'select' ? parseValue(def, text.trim()) : null;
    const error = parsed && !parsed.ok ? parsed.error : null;
    const submit = () => {
        const value = text.trim();
        if (def.type === 'select') { if (close) done(close); else if (value && OPTION_TEXT.test(value)) done(value, value); return; }
        if (!error) done(value);
    };
    const option = (label: ReactNode, run: () => void, key?: string) => <Button key={key} variant="ghost" size="sm" className="option justify-between font-normal" onClick={run}>{label}</Button>;
    return (
        <Popover open onOpenChange={open => { if (!open) onClose(); }}>
            <PopoverAnchor asChild><Anchor at={at} /></PopoverAnchor>
            <PopoverContent ref={ref} align="start" className="field-popover" aria-label={def.key}
                onOpenAutoFocus={e => { e.preventDefault(); ref.current?.querySelector('input')?.focus(); }}>
            {def.type === 'select' && def.options.map(o => option(
                <><Badge variant="secondary" className={cn('note-chip opt-chip', def.colors?.[o] && `opt-${def.colors[o]}`)}>{o}</Badge>{o === current && <Icon name="emblem-ok" size={14} />}</>,
                () => done(o), o))}
            {def.type === 'date' && (
                <Input type="date" aria-label={`${def.key} date`} value={/^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''}
                    onChange={e => e.target.value && done(def.key === DUE_FIELD.key ? withDueDate(current, e.target.value) : withDueDate(text, e.target.value))} />
            )}
            <Input value={text} placeholder={def.type === 'select' ? 'Another value…' : def.type === 'date' ? 'YYYY-MM-DD or YYYY-MM-DD HH:MM' : def.key} aria-label={def.key}
                onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
            {def.type === 'select' && text.trim() && !close && OPTION_TEXT.test(text.trim()) && option(`Add “${text.trim()}” to the list`, submit)}
            {def.type === 'select' && close && text.trim() !== '' && option(`Use “${close}”`, submit)}
            {error && <div className="field-error" role="alert">{error}</div>}
            {option('Clear', () => done(''))}
            </PopoverContent>
        </Popover>
    );
}

// The popover of the field `key` of a note, as the page opens it from a chip or a cell: it writes the field with a `field` edit.
type FieldWriter = (card: CardRef, key: string, raw: string, def: FieldDef, option: string | null) => void;
export function useFieldEditor(schema: FieldDef[], edit: FieldWriter) {
    const [popover, setPopover, closePopover] = usePopup<FieldEdit>();
    const open = (card: CardRef, text: string, key: string, at: { x: number; y: number }) => {
        const def = key === DUE_FIELD.key && !schema.some(f => f.key === key) ? DUE_FIELD : schema.find(f => f.key === key);
        if (!def) return;
        setPopover({ def, current: fieldInputText(text, def), at, apply: (raw: string, option?: string) => edit(card, key, raw, def, option ?? null) });
    };
    const node = popover ? <FieldPopover edit={popover} onClose={closePopover} /> : null;
    return [open, node] as const;
}

// ---------- The dialog of a card or a note ----------

export interface CardAnswer { text: CardForm; notes: string[] }

interface CardDialogProps {
    heading: string;
    kind: 'card' | 'note';
    text: string;          // the first line as it is now ('' for a new note)
    notes: string[];
    schema: FieldDef[];
    agents?: boolean;      // a board offers to assign an agent (not while it is grouped by a field)
    onDone(answer: CardAnswer | null): void;
}

// The due date: text (a time can still be typed after the day) and a button beside it that opens a calendar. The calendar
// starts on the day in the field (or today); picking a day writes it and keeps the time.
function DueInput({ value, onChange }: { value: string; onChange(value: string): void }) {
    const id = useId();
    const picker = useRef<HTMLInputElement>(null);
    return (
        <div className="due-field">
            <Label htmlFor={id}>Due</Label>
            <InputGroup className="with-button">
                <InputGroupInput id={id} value={value} placeholder="YYYY-MM-DD" onChange={e => onChange(e.target.value)} />
                <Input ref={picker} type="date" className="picker" tabIndex={-1} aria-hidden="true" value={/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ''}
                    onChange={e => onChange(e.target.value ? withDueDate(value, e.target.value) : '')} />
                <InputGroupAddon align="inline-end">
                    <IconButton size="icon-xs" label="Pick a date" onClick={() => picker.current?.showPicker()}><Icon name="x-office-calendar" /></IconButton>
                </InputGroupAddon>
            </InputGroup>
        </div>
    );
}

export function CardDialog({ heading, kind, text, notes, schema, agents = false, onDone }: CardDialogProps) {
    const parts = useMemo(() => kind === 'card' ? splitCard(text) : { ...itemMeta(text), due: '', agent: '' }, [kind, text]);
    const shown = useMemo(() => schema.filter(f => kind === 'card' ? f.key !== DUE_FIELD.key && f.key !== AGENT_FIELD.key : f.key !== CREATED_FIELD.key), [schema, kind]);
    const [title, setTitle] = useState(parts.title);
    const [tags, setTags] = useState(parts.tags.join(' '));
    const [due, setDue] = useState(parts.due);
    const [agent, setAgent] = useState(parts.agent ?? '');
    const [body, setBody] = useState(notes.join('\n'));
    const [values, setValues] = useState(() => Object.fromEntries(shown.map(f => [f.key, fieldInputText(text, f)])));
    const [problem, setProblem] = useState<string | null>(null);

    const submit = () => {
        if (!title.trim()) { setProblem('A title is needed'); return; }
        if (kind === 'card' && due.trim() && !DUE_INPUT.test(due.trim())) { setProblem('The due date is YYYY-MM-DD, with a time if you like'); return; }
        const name = agent.trim().replace(/^@+/, '').toLowerCase();
        if (kind === 'card' && name && !AGENT_NAME.test(name)) { setProblem('An agent name is letters, digits, - and _'); return; }
        for (const f of shown) {
            const raw = values[f.key].trim();
            const parsed = raw ? parseValue(f, raw) : null;
            if (parsed && !parsed.ok) { setProblem(`${f.key}: ${parsed.error}`); return; }
        }
        onDone({
            text: { kind, title: title.trim(), tags: tags.split(/\s+/).filter(Boolean), due: due.trim(), agent: agents ? agent : '', fields: shown.map(field => ({ field, text: values[field.key].trim() })) },
            notes: body.split('\n'),
        });
    };
    return (
        <Modal title={heading} onClose={() => onDone(null)}>
            <form className="card-form" onSubmit={e => { e.preventDefault(); submit(); }}>
                <Label><span>Title</span><Input autoFocus value={title} onChange={e => { setTitle(e.target.value); setProblem(null); }} /></Label>
                <Label><span>Tags (separated by spaces)</span><Input value={tags} placeholder="tag1 tag2" onChange={e => setTags(e.target.value)} /></Label>
                {kind === 'card' && <DueInput value={due} onChange={value => { setDue(value); setProblem(null); }} />}
                {kind === 'card' && agents && <Label><span>Assigned to</span><Input value={agent} placeholder="e.g. pi (empty = not assigned)" onChange={e => { setAgent(e.target.value); setProblem(null); }} /></Label>}
                {shown.map(f => (
                    <Label key={f.key}><span>{f.key}</span>
                        {f.type === 'select' && !f.multiple && f.options.length ? (
                            <Select value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}>
                                <option value="" />{[...new Set([...f.options, ...(values[f.key] ? [values[f.key]] : [])])].map(o => <option key={o} value={o}>{o}</option>)}
                            </Select>
                        ) : <Input value={values[f.key]} onChange={e => { setValues(v => ({ ...v, [f.key]: e.target.value })); setProblem(null); }} />}
                    </Label>
                ))}
                <Label><span>Notes</span><Textarea rows={6} value={body} onChange={e => setBody(e.target.value)} /></Label>
                {problem && <div className="field-error" role="alert">{problem}</div>}
                <div className="buttons">
                    <Button type="submit">Save</Button>
                    <Button type="button" variant="outline" onClick={() => onDone(null)}>Cancel</Button>
                </div>
            </form>
        </Modal>
    );
}

// The title of a note, and where it was captured: what a row or a card says first.
export const titleOf = (text: string, schema: FieldDef[]): string => readItem(text, schema).title;

export function Empty({ children }: { children: ReactNode }) {
    return <div className="empty-page">{children}</div>;
}

// The title and description: what follows the frontmatter in the head, the first `# heading` and the lines after it.
export function headingOf(board: Board, fallback: string): { title: string; description: string } {
    const lines = [...board.head];
    if (lines[0]?.trim() === '---') {
        const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
        lines.splice(0, close < 0 ? lines.length : close + 1);
    }
    const at = lines.findIndex(l => /^#\s+\S/.test(l));
    const title = at >= 0 ? lines[at].replace(/^#\s+/, '').trim() : fallback;
    const rest = at >= 0 ? lines.slice(at + 1) : lines;
    return { title, description: rest.map(l => l.trim()).filter(Boolean).join(' ') };
}


export function PageHeader({ board, fallback, onNew, children }: { board: Board; fallback: string; onNew?: () => void; children?: ReactNode }) {
    const { title, description } = headingOf(board, fallback);
    return (
        <header className="page-header">
            <div className="titles"><h1>{title}</h1>{description && <p className="dim">{description}</p>}</div>
            {children}
            {onNew && <Button variant="outline" size="sm" onClick={onNew}><Icon name="list-add" />New Note</Button>}
        </header>
    );
}

// The dialog of a note on a layout page: to edit a note, or to add one (on a day, for the calendar).
export function useNoteDialog(board: Board, schema: FieldDef[]) {
    const client = useClient();
    const [dialog, setDialog, close] = usePopup<{ at: Position | null; text: string; notes: string[]; date?: string }>();
    const node = dialog && (
        <CardDialog heading={dialog.at ? 'Edit Note' : 'New Note'} kind="note" text={dialog.text} notes={dialog.notes} schema={schema}
            onDone={result => {
                close();
                if (!result) return;
                if (dialog.at === null) client.editNotes({ kind: 'capture', text: result.text, notes: result.notes, now: Date.now(), ...(dialog.date && { date: dialog.date }) });
                else client.editNotes({ kind: 'update', at: dialog.at, card: dialog.text, text: result.text, notes: result.notes });
            }} />
    );
    return {
        node,
        edit: (at: Position) => { const card = board.columns[at.column]?.cards[at.index]; if (card) setDialog({ at, text: card.text, notes: card.notes }); },
        add: (date?: string) => setDialog({ at: null, text: '', notes: [], date }),
    };
}

// A day as the pages write it: "2026-10-20" with an Intl pattern.
export function formatDate(date: string, options: Intl.DateTimeFormatOptions): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, options);
}

// When a commit was made, in full and on a 24-hour clock: "23 Oct 2026, 06:55" in the system's own order.
export const commitTime = (seconds: number): string =>
    new Date(seconds * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
