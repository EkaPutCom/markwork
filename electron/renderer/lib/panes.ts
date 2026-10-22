// The panes of the editor area: columns of panes, each with its own tabs, like the editor groups of VS Code. Pure data in,
// new data out (the window draws it; the core knows nothing of it, only of the document it is told is active). A document
// is a tab of the pane that shows it; the same document can be a tab of two panes, and it is still one document.

export interface Pane {
    id: number;
    tabs: number[];        // document ids, in the order of the tab bar
    active: number;        // the one shown (0 = none)
    source: boolean;       // shows the file as it is written (Markdown), not as it looks
    size: number;          // the share of its column's height
}

export interface Column {
    size: number;          // the share of the area's width
    panes: Pane[];
}

export interface Layout {
    columns: Column[];
    current: number;       // the pane that has the focus
    next: number;          // the id the next pane gets
}

// Where a dragged tab lands on a pane: its middle joins the tabs, an edge makes a new pane beside it.
export type Zone = 'center' | 'left' | 'right' | 'top' | 'bottom';

export const initialLayout = (): Layout => ({ columns: [{ size: 1, panes: [{ id: 1, tabs: [], active: 0, source: false, size: 1 }] }], current: 1, next: 2 });

export const panesOf = (layout: Layout): Pane[] => layout.columns.flatMap(c => c.panes);
export const paneById = (layout: Layout, id: number): Pane | undefined => panesOf(layout).find(p => p.id === id);
export const currentPane = (layout: Layout): Pane => paneById(layout, layout.current) ?? panesOf(layout)[0];
export const isSolo = (layout: Layout): boolean => panesOf(layout).length === 1;
// The document the focused pane shows: the active document of the window.
export const activeDoc = (layout: Layout): number => currentPane(layout).active;
// The panes that show a document (it is the active tab of each).
export const showing = (layout: Layout, doc: number): Pane[] => panesOf(layout).filter(p => p.active === doc);

function mapPanes(layout: Layout, change: (pane: Pane) => Pane): Layout {
    return { ...layout, columns: layout.columns.map(c => ({ ...c, panes: c.panes.map(change) })) };
}
const withPane = (layout: Layout, id: number, change: (pane: Pane) => Pane): Layout => mapPanes(layout, p => p.id === id ? change(p) : p);

// A pane that lost a tab shows the one that took its place; the first pane's choice when none is left.
function afterRemoval(pane: Pane, doc: number): Pane {
    const at = pane.tabs.indexOf(doc);
    if (at < 0) return pane;
    const tabs = pane.tabs.filter(t => t !== doc);
    return { ...pane, tabs, active: pane.active === doc ? tabs[Math.min(at, tabs.length - 1)] ?? 0 : pane.active };
}

// Empty panes and columns go, unless it would leave none; the focus stays on a pane that exists.
function prune(layout: Layout): Layout {
    let columns = layout.columns.map(c => ({ ...c, panes: c.panes.filter(p => p.tabs.length > 0) })).filter(c => c.panes.length > 0);
    if (columns.length === 0) {
        const keep = panesOf(layout)[0];
        columns = [{ size: 1, panes: [{ ...keep, tabs: [], active: 0 }] }];
    }
    const result = { ...layout, columns };
    return panesOf(result).some(p => p.id === layout.current) ? result : { ...result, current: panesOf(result)[0].id };
}

// ---------- Tabs ----------

// A document was opened: a tab of the focused pane, and the one it shows.
export function open(layout: Layout, doc: number): Layout {
    return withPane(layout, layout.current, p => ({ ...p, tabs: p.tabs.includes(doc) ? p.tabs : [...p.tabs, doc], active: doc }));
}

// The core made a document the active one: the focused pane shows it if it has it, else the pane that has it gets the
// focus, else it is a new tab of the focused pane.
export function show(layout: Layout, doc: number): Layout {
    const here = currentPane(layout);
    if (here.tabs.includes(doc)) return withPane(layout, here.id, p => ({ ...p, active: doc }));
    const other = panesOf(layout).find(p => p.tabs.includes(doc));
    if (other) return { ...withPane(layout, other.id, p => ({ ...p, active: doc })), current: other.id };
    return open(layout, doc);
}

// A tab was chosen in a pane: it shows it, and has the focus.
export function select(layout: Layout, pane: number, doc: number): Layout {
    const target = paneById(layout, pane);
    if (!target?.tabs.includes(doc)) return layout;
    return { ...withPane(layout, pane, p => ({ ...p, active: doc })), current: pane };
}

export const focus = (layout: Layout, pane: number): Layout => paneById(layout, pane) ? { ...layout, current: pane } : layout;

// The document is closed (everywhere).
export function close(layout: Layout, doc: number): Layout {
    return prune(mapPanes(layout, p => afterRemoval(p, doc)));
}

// A tab was closed in one pane: true when it was the last pane showing that document, so the document itself is closed.
export function closeTab(layout: Layout, pane: number, doc: number): { layout: Layout; closesDocument: boolean } {
    const others = panesOf(layout).some(p => p.id !== pane && p.tabs.includes(doc));
    if (!others) return { layout, closesDocument: true };
    return { layout: prune(withPane(layout, pane, p => afterRemoval(p, doc))), closesDocument: false };
}

// The next (or the previous) tab of a pane.
export function neighbor(pane: Pane, step: number): number {
    if (pane.tabs.length === 0) return 0;
    const at = pane.tabs.indexOf(pane.active);
    return pane.tabs[(at + step + pane.tabs.length) % pane.tabs.length];
}

// A tab was dragged to a new place in its pane's bar: before `before` (null: at the end).
export function reorder(layout: Layout, pane: number, doc: number, before: number | null): Layout {
    return withPane(layout, pane, p => {
        if (!p.tabs.includes(doc) || doc === before) return p;
        const rest = p.tabs.filter(t => t !== doc), at = before === null ? rest.length : rest.indexOf(before);
        return { ...p, tabs: [...rest.slice(0, at < 0 ? rest.length : at), doc, ...rest.slice(at < 0 ? rest.length : at)] };
    });
}

// ---------- Splitting and moving ----------

// A new pane beside (or above, below) `pane`, holding `doc`; the pane that was there keeps its tabs. It has the focus.
function addPane(layout: Layout, beside: number, side: Exclude<Zone, 'center'>, doc: number, source: boolean): Layout {
    const id = layout.next;
    const fresh: Pane = { id, tabs: [doc], active: doc, source, size: 1 };
    const ci = layout.columns.findIndex(c => c.panes.some(p => p.id === beside));
    if (ci < 0) return layout;
    if (side === 'left' || side === 'right') {
        const columns = [...layout.columns];
        columns.splice(side === 'left' ? ci : ci + 1, 0, { size: layout.columns[ci].size, panes: [fresh] });
        return { ...layout, columns, current: id, next: id + 1 };
    }
    const column = layout.columns[ci], pi = column.panes.findIndex(p => p.id === beside);
    const panes = [...column.panes];
    panes.splice(side === 'top' ? pi : pi + 1, 0, { ...fresh, size: column.panes[pi].size });
    return { ...layout, columns: layout.columns.map((c, i) => i === ci ? { ...c, panes } : c), current: id, next: id + 1 };
}

// Split a pane: the document it shows opens in a new pane next to it (it is the same document, shown twice).
export function split(layout: Layout, pane: number, side: Exclude<Zone, 'center'>): Layout {
    const from = paneById(layout, pane);
    return from && from.active ? addPane(layout, pane, side, from.active, from.source) : layout;
}

// A tab was dropped on a pane (`from` is its pane, or null for a document that was not open in any: a file of the sidebar).
export function drop(layout: Layout, from: number | null, doc: number, to: number, zone: Zone): Layout {
    const target = paneById(layout, to);
    if (!target) return layout;
    const source = from === null ? undefined : paneById(layout, from);
    if (zone === 'center') {
        if (from === to) return select(layout, to, doc);
        const moved = source ? withPane(layout, source.id, p => afterRemoval(p, doc)) : layout;
        return prune({ ...withPane(moved, to, p => ({ ...p, tabs: p.tabs.includes(doc) ? p.tabs : [...p.tabs, doc], active: doc })), current: to });
    }
    // An edge of the pane that holds only this tab would leave it empty, and gain nothing.
    if (source && source.id === to && source.tabs.length === 1) return layout;
    const added = addPane(source ? withPane(layout, source.id, p => afterRemoval(p, doc)) : layout, to, zone, doc, target.source);
    return prune(added);
}

// The pane's tabs join the pane next to it (the one before, or the one after if it is the first), and the pane is gone.
export function closePane(layout: Layout, pane: number): Layout {
    const list = panesOf(layout), at = list.findIndex(p => p.id === pane);
    if (at < 0 || list.length === 1) return layout;
    const gone = list[at], into = list[at > 0 ? at - 1 : 1];
    const joined = withPane(layout, into.id, p => ({ ...p, tabs: [...p.tabs, ...gone.tabs.filter(t => !p.tabs.includes(t))] }));
    return prune({ ...mapPanes(joined, p => p.id === pane ? { ...p, tabs: [], active: 0 } : p), current: into.id });
}

// Every tab in one pane.
export function joinAll(layout: Layout): Layout {
    const list = panesOf(layout), first = currentPane(layout);
    const tabs = [...first.tabs, ...list.filter(p => p.id !== first.id).flatMap(p => p.tabs).filter((t, i, all) => !first.tabs.includes(t) && all.indexOf(t) === i)];
    return { ...layout, columns: [{ size: 1, panes: [{ ...first, tabs, size: 1 }] }], current: first.id };
}

// The document of the focused pane moves to the next pane (the one after it in reading order, round).
export function moveToNextPane(layout: Layout, step = 1): Layout {
    const list = panesOf(layout), here = currentPane(layout);
    if (list.length < 2 || !here.active) return layout;
    const next = list[(list.indexOf(here) + step + list.length) % list.length];
    return drop(layout, here.id, here.active, next.id, 'center');
}

export const setSource = (layout: Layout, pane: number, source: boolean): Layout => withPane(layout, pane, p => ({ ...p, source }));

// ---------- Sizes ----------

export const MIN_SHARE = 0.25;

// The line between item `index` and the one after it moved by `delta` of the whole (the sizes are shares of a total).
export function shift(sizes: readonly number[], index: number, delta: number): number[] {
    const total = sizes.reduce((n, s) => n + s, 0), pair = sizes[index] + sizes[index + 1];
    const first = Math.min(pair - MIN_SHARE * total / sizes.length, Math.max(MIN_SHARE * total / sizes.length, sizes[index] + delta));
    return sizes.map((s, i) => i === index ? first : i === index + 1 ? pair - first : s);
}

export function resizeColumns(layout: Layout, index: number, delta: number): Layout {
    const sizes = shift(layout.columns.map(c => c.size), index, delta);
    return { ...layout, columns: layout.columns.map((c, i) => ({ ...c, size: sizes[i] })) };
}

export function resizePanes(layout: Layout, column: number, index: number, delta: number): Layout {
    const sizes = shift(layout.columns[column].panes.map(p => p.size), index, delta);
    return { ...layout, columns: layout.columns.map((c, ci) => ci === column ? { ...c, panes: c.panes.map((p, i) => ({ ...p, size: sizes[i] })) } : c) };
}
