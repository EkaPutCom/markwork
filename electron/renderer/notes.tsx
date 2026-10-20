// The parts the pages of a document's notes share (board, list, table, calendar, timeline, gallery, chart): a title
// with its Markdown, the chips of the fields, a menu at the pointer, the popover that changes one field, and the dialog
// that edits a card or a note. They draw what the core sends and answer with the operation the user made
// (src/markdown/noteedit.ts); what an operation does is the core's (and applyNoteEdit's, which the client also runs to
// show a change at once).

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { DUE_FIELD, AGENT_FIELD, AGENT_NAME, DUE_INPUT, splitCard, withDueDate, type Board, type Card, type Position } from '../../src/markdown/kanban.js';
import { fieldInputText, nearestOption, OPTION_COLORS, OPTION_TEXT, parseValue, readItem, type FieldChip, type FieldDef } from '../../src/markdown/fields.js';
import { CREATED_FIELD, itemMeta } from '../../src/markdown/inbox.js';
import { inlineRuns } from '../../src/markdown/inlineruns.js';
import type { CardForm, CardRef } from '../../src/markdown/noteedit.js';
import { Icon, type IconName } from './Icons.js';
import { Modal } from './Modals.js';
import { useClient } from './useClient.js';

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

export function Chip({ text, icon, className, title, onClick }: { text: string; icon?: IconName; className?: string; title?: string; onClick?: (e: React.MouseEvent) => void }) {
    const content = <>{icon && <Icon name={icon} size={12} />}{text}</>;
    return onClick
        ? <button type="button" className={`chip ${className ?? ''}`} title={title} onClick={e => { e.stopPropagation(); onClick(e); }}>{content}</button>
        : <span className={`chip ${className ?? ''}`} title={title}>{content}</span>;
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

export function PopupMenu({ at, entries, onClose }: { at: { x: number; y: number }; entries: MenuEntry[]; onClose: () => void }) {
    const [open, setOpen] = useState<number | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    const [shift, setShift] = useState({ x: 0, y: 0 });
    useEffect(() => {
        const close = (e: Event) => { if (!(e.target as Element).closest('.popup')) onClose(); };
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
        document.addEventListener('mousedown', close, true);
        document.addEventListener('keydown', key, true);
        return () => { document.removeEventListener('mousedown', close, true); document.removeEventListener('keydown', key, true); };
    }, [onClose]);
    // Kept inside the window.
    useEffect(() => {
        const box = ref.current?.getBoundingClientRect();
        if (box) setShift({ x: Math.min(0, window.innerWidth - box.right - 8), y: Math.min(0, window.innerHeight - box.bottom - 8) });
    }, [open]);
    const run = (entry: MenuEntry) => { onClose(); entry.run?.(); };
    return (
        <div ref={ref} className="popover popup" role="menu" style={{ left: at.x + shift.x, top: at.y + shift.y }}>
            {entries.map((entry, i) => entry.separator ? <hr key={i} /> : (
                <div key={i}>
                    <button role="menuitem" disabled={entry.enabled === false} onClick={() => entry.submenu ? setOpen(open === i ? null : i) : run(entry)}>
                        <span>{entry.label}</span>{entry.submenu && <span className="more">›</span>}
                    </button>
                    {entry.submenu && open === i && (
                        <div className="submenu">
                            {entry.submenu.map((sub, j) => sub.separator ? <hr key={j} /> : <button key={j} role="menuitem" disabled={sub.enabled === false} onClick={() => run(sub)}><span>{sub.label}</span></button>)}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}

// What a page has open over it: a menu, the popover of a field, or the dialog of a card.
export function usePopup<T>() {
    const [popup, setPopup] = useState<T | null>(null);
    return [popup, setPopup, () => setPopup(null)] as const;
}

// ---------- The popover that changes one field ----------

export interface FieldEdit { def: FieldDef; current: string; at: { x: number; y: number }; apply(raw: string, option?: string): void }

export function FieldPopover({ edit, onClose }: { edit: FieldEdit; onClose: () => void }) {
    const { def, current, at, apply } = edit;
    const [text, setText] = useState(current);
    const ref = useRef<HTMLDivElement>(null);
    const done = (raw: string, option?: string) => { onClose(); apply(raw, option); };
    useEffect(() => {
        const close = (e: Event) => { if (!(e.target as Element).closest('.field-popover')) onClose(); };
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
        document.addEventListener('mousedown', close, true);
        document.addEventListener('keydown', key, true);
        ref.current?.querySelector('input')?.focus();
        return () => { document.removeEventListener('mousedown', close, true); document.removeEventListener('keydown', key, true); };
    }, [onClose]);

    const close = def.type === 'select' ? nearestOption(def, text.trim()) : null;
    const parsed = text.trim() && def.type !== 'select' ? parseValue(def, text.trim()) : null;
    const error = parsed && !parsed.ok ? parsed.error : null;
    const submit = () => {
        const value = text.trim();
        if (def.type === 'select') { if (close) done(close); else if (value && OPTION_TEXT.test(value)) done(value, value); return; }
        if (!error) done(value);
    };
    return (
        <div ref={ref} className="popover popup field-popover" role="dialog" aria-label={def.key} style={{ left: Math.min(at.x, window.innerWidth - 260), top: Math.min(at.y, window.innerHeight - 320) }}>
            {def.type === 'select' && def.options.map(option => (
                <button key={option} className="option" onClick={() => done(option)}>
                    <span className={`chip opt-chip${def.colors?.[option] ? ` opt-${def.colors[option]}` : ''}`}>{option}</span>{option === current && <span className="tick">✓</span>}
                </button>
            ))}
            {def.type === 'date' && (
                <input type="date" aria-label={`${def.key} date`} value={/^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''}
                    onChange={e => e.target.value && done(def.key === DUE_FIELD.key ? withDueDate(current, e.target.value) : withDueDate(text, e.target.value))} />
            )}
            <input value={text} placeholder={def.type === 'select' ? 'Another value…' : def.type === 'date' ? 'YYYY-MM-DD or YYYY-MM-DD HH:MM' : def.key} aria-label={def.key}
                onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
            {def.type === 'select' && text.trim() && !close && OPTION_TEXT.test(text.trim()) && <button className="option" onClick={submit}>Add “{text.trim()}” to the list</button>}
            {def.type === 'select' && close && text.trim() !== '' && <button className="option" onClick={submit}>Use “{close}”</button>}
            {error && <div className="field-error" role="alert">{error}</div>}
            <button className="option" onClick={() => done('')}>Clear</button>
        </div>
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
            <label htmlFor={id}>Due</label>
            <div className="with-button">
                <input id={id} value={value} placeholder="YYYY-MM-DD" onChange={e => onChange(e.target.value)} />
                <input ref={picker} type="date" className="picker" tabIndex={-1} aria-hidden="true" value={/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ''}
                    onChange={e => onChange(e.target.value ? withDueDate(value, e.target.value) : '')} />
                <button type="button" className="button flat" title="Pick a date" aria-label="Pick a date" onClick={() => picker.current?.showPicker()}><Icon name="x-office-calendar" /></button>
            </div>
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
                <label><span>Title</span><input autoFocus value={title} onChange={e => { setTitle(e.target.value); setProblem(null); }} /></label>
                <label><span>Tags (separated by spaces)</span><input value={tags} placeholder="tag1 tag2" onChange={e => setTags(e.target.value)} /></label>
                {kind === 'card' && <DueInput value={due} onChange={value => { setDue(value); setProblem(null); }} />}
                {kind === 'card' && agents && <label><span>Assigned to</span><input value={agent} placeholder="e.g. pi (empty = not assigned)" onChange={e => { setAgent(e.target.value); setProblem(null); }} /></label>}
                {shown.map(f => (
                    <label key={f.key}><span>{f.key}</span>
                        {f.type === 'select' && !f.multiple && f.options.length ? (
                            <select value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}>
                                <option value="" />{[...new Set([...f.options, ...(values[f.key] ? [values[f.key]] : [])])].map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                        ) : <input value={values[f.key]} onChange={e => { setValues(v => ({ ...v, [f.key]: e.target.value })); setProblem(null); }} />}
                    </label>
                ))}
                <label><span>Notes</span><textarea rows={6} value={body} onChange={e => setBody(e.target.value)} /></label>
                {problem && <div className="field-error" role="alert">{problem}</div>}
                <div className="buttons">
                    <button type="submit" className="button suggested">Save</button>
                    <button type="button" className="button" onClick={() => onDone(null)}>Cancel</button>
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
            {onNew && <button className="button" title="Add a note with a title, fields, and notes" onClick={onNew}>New Note</button>}
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
