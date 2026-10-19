// The Fields… dialog: the fields a board, list, or table declares in its frontmatter, as a form. Fields can be added and
// reordered, and the options of a select can be added, edited, removed, reordered, and given a color. A field that already
// exists keeps its name and type, so no value on a card is ever cut off from its field here. The core writes the answer into the
// frontmatter (`ask.schema`); nothing here touches the text.

import { useState } from 'react';
import { fieldNameProblem, OPTION_COLORS, optionProblem, type FieldDef, type FieldType, type NameProblem, type OptionColor } from '../../src/markdown/fields.js';
import { Modal } from './Modals.js';
import { useClient, useStore } from './useClient.js';

const TYPES: readonly FieldType[] = ['text', 'number', 'select', 'date', 'progress', 'person', 'agent', 'link'];
const TYPE_LABEL: Record<FieldType, string> = { text: 'Text', number: 'Number', select: 'Choice', date: 'Date', progress: 'Progress', person: 'Person', agent: 'Agent', link: 'Link' };
const PROBLEM: Record<NameProblem, string> = { empty: 'A name is needed', invalid: 'Start with a letter; letters, digits, - and _ only', taken: 'That name is already used' };
const OPTION_PROBLEM: Record<NameProblem, string> = { ...PROBLEM, invalid: 'No comma, colon, or parentheses' };

interface DraftOption { text: string; color: OptionColor | null }
interface DraftField { def: FieldDef; fresh: boolean; options: DraftOption[] }

const swap = <T,>(items: T[], i: number, to: number): T[] => { const next = [...items]; [next[i], next[to]] = [next[to], next[i]]; return next; };

export function FieldsDialog() {
    const { schema } = useStore();
    if (!schema) return null;
    return <Form key={schema.id} id={schema.id} options={schema.options} />;
}

function Form({ id, options }: { id: number; options: NonNullable<ReturnType<typeof useStore>['schema']>['options'] }) {
    const client = useClient();
    const usage = new Map(options.uses.filter(u => u.option !== null).map(u => [`${u.key}\u0000${u.option}`, u.count]));
    const [draft, setDraft] = useState<DraftField[]>(() => options.fields.map(def => ({ def: { ...def }, fresh: false, options: def.options.map(text => ({ text, color: def.colors?.[text] ?? null })) })));
    const [colorOpen, setColorOpen] = useState<string | null>(null);
    const [checked, setChecked] = useState(false);
    const [added, setAdded] = useState<Record<number, string>>({});

    const set = (i: number, patch: (d: DraftField) => DraftField) => setDraft(list => list.map((d, j) => j === i ? patch(d) : d));
    const keys = draft.map(d => d.def.key.trim());
    const nameProblem = (i: number) => draft[i].fresh ? fieldNameProblem(draft[i].def.key, [...options.reserved, ...keys.filter((_k, j) => j !== i)]) : null;
    const optionIssue = (i: number, j: number) => optionProblem(draft[i].options[j].text, draft[i].options.filter((_o, k) => k !== j).map(o => o.text));
    const valid = () => draft.every((d, i) => !nameProblem(i) && d.options.every((_o, j) => !optionIssue(i, j)));

    const result = (): FieldDef[] => draft.map(({ def, options: opts }) => {
        const texts = opts.map(o => o.text.trim());
        const colors: Record<string, OptionColor> = {};
        opts.forEach((o, i) => { if (o.color) colors[texts[i]] = o.color; });
        const { colors: _old, ...rest } = def;
        return { ...rest, key: def.key.trim(), options: texts, ...(Object.keys(colors).length ? { colors } : {}) };
    });
    const save = () => { setChecked(true); if (valid()) client.answerSchema(id, result()); };

    return (
        <Modal title="Fields" onClose={() => client.answerSchema(id, null)} wide>
            <form className="fields-form" onSubmit={e => { e.preventDefault(); save(); }}>
                <div className="fields-list">
                    {draft.length === 0 && <p className="dim">No fields yet. Add one below.</p>}
                    {draft.map((d, i) => {
                        const problem = checked ? nameProblem(i) : null;
                        return (
                            <div key={i} className="field-row">
                                <div className="head">
                                    <span className="mover">
                                        <button type="button" className="icon-button" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => setDraft(l => swap(l, i, i - 1))}>↑</button>
                                        <button type="button" className="icon-button" aria-label="Move down" title="Move down" disabled={i === draft.length - 1} onClick={() => setDraft(l => swap(l, i, i + 1))}>↓</button>
                                    </span>
                                    {d.fresh ? <input autoFocus className={problem ? 'error' : ''} value={d.def.key} placeholder="Field name" aria-label="Field name" title={problem ? PROBLEM[problem] : undefined}
                                        onChange={e => set(i, f => ({ ...f, def: { ...f.def, key: e.target.value } }))} />
                                        : <strong className="name">{d.def.key}</strong>}
                                    {d.fresh ? (
                                        <select aria-label="Field type" value={d.def.type} onChange={e => set(i, f => ({ ...f, def: { ...f.def, type: e.target.value as FieldType }, options: e.target.value === 'select' ? f.options : [] }))}>
                                            {TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                                        </select>
                                    ) : <span className="dim">{TYPE_LABEL[d.def.type]}{d.def.multiple ? ' ×' : ''}</span>}
                                    {d.fresh && <button type="button" className="icon-button" aria-label="Remove this field" title="Remove this field" onClick={() => setDraft(l => l.filter((_x, j) => j !== i))}>×</button>}
                                </div>
                                {problem && <div className="field-error" role="alert">{PROBLEM[problem]}</div>}
                                {d.def.type === 'select' && (
                                    <div className="options">
                                        {d.options.map((o, j) => {
                                            const key = `${i}.${j}`;
                                            const issue = checked ? optionIssue(i, j) : null;
                                            const uses = d.fresh ? 0 : usage.get(`${d.def.key}\u0000${o.text}`) ?? 0;
                                            return (
                                                <div key={j}>
                                                    <div className="option-row">
                                                        <span className="mover">
                                                            <button type="button" className="icon-button" aria-label="Move option up" disabled={j === 0} onClick={() => set(i, f => ({ ...f, options: swap(f.options, j, j - 1) }))}>↑</button>
                                                            <button type="button" className="icon-button" aria-label="Move option down" disabled={j === d.options.length - 1} onClick={() => set(i, f => ({ ...f, options: swap(f.options, j, j + 1) }))}>↓</button>
                                                        </span>
                                                        <button type="button" className={`opt-dot ${o.color ? `opt-dot-${o.color}` : 'opt-dot-auto'}${colorOpen === key ? ' chosen' : ''}`} aria-label="Color of this option" title="Color of this option"
                                                            onClick={() => setColorOpen(colorOpen === key ? null : key)} />
                                                        <input className={issue ? 'error' : ''} value={o.text} aria-label="Option" title={issue ? OPTION_PROBLEM[issue] : undefined}
                                                            onChange={e => set(i, f => ({ ...f, options: f.options.map((x, k) => k === j ? { ...x, text: e.target.value } : x) }))} />
                                                        {uses > 0 && <span className="dim caption">{uses} {uses === 1 ? 'note' : 'notes'}</span>}
                                                        <button type="button" className="icon-button" aria-label="Remove option" title="Remove option" onClick={() => set(i, f => ({ ...f, options: f.options.filter((_x, k) => k !== j) }))}>×</button>
                                                    </div>
                                                    {colorOpen === key && (
                                                        <div className="color-row">
                                                            {OPTION_COLORS.map(color => (
                                                                <button type="button" key={color} className={`opt-dot opt-dot-${color}${o.color === color ? ' chosen' : ''}`} aria-label={color} title={color}
                                                                    onClick={() => { set(i, f => ({ ...f, options: f.options.map((x, k) => k === j ? { ...x, color } : x) })); setColorOpen(null); }} />
                                                            ))}
                                                            <button type="button" className="button flat" onClick={() => { set(i, f => ({ ...f, options: f.options.map((x, k) => k === j ? { ...x, color: null } : x) })); setColorOpen(null); }}>Automatic</button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        <div className="option-row">
                                            <input value={added[i] ?? ''} placeholder="Add an option…" aria-label="Add an option"
                                                onChange={e => setAdded(a => ({ ...a, [i]: e.target.value }))}
                                                onKeyDown={e => {
                                                    if (e.key !== 'Enter') return;
                                                    e.preventDefault();
                                                    const text = (added[i] ?? '').trim();
                                                    if (!text || optionProblem(text, d.options.map(o => o.text))) return;
                                                    set(i, f => ({ ...f, options: [...f.options, { text, color: null }] }));
                                                    setAdded(a => ({ ...a, [i]: '' }));
                                                }} />
                                            <button type="button" className="icon-button" aria-label="Add option" title="Add option" onClick={() => {
                                                const text = (added[i] ?? '').trim();
                                                if (!text || optionProblem(text, d.options.map(o => o.text))) return;
                                                set(i, f => ({ ...f, options: [...f.options, { text, color: null }] }));
                                                setAdded(a => ({ ...a, [i]: '' }));
                                            }}>+</button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <button type="button" className="button flat" onClick={() => setDraft(l => [...l, { def: { key: '', type: 'text', multiple: false, options: [] }, fresh: true, options: [] }])}>+ Add field</button>
                <div className="buttons">
                    <button type="button" className="button" onClick={() => client.answerSchema(id, null)}>Cancel</button>
                    <button type="submit" className="button suggested">Save</button>
                </div>
            </form>
        </Modal>
    );
}
