// A DBML schema drawn as SVG in the look of the shadcn/ui tables: a card per table with a muted header, the column name,
// its type in mono, and PK/FK badges; relations are thin orthogonal lines with a crow's foot on the "many" end. The colors
// are the tokens, through the .er-* classes of styles/theme.css, so the drawing follows the theme without being redrawn.

import { resolveDbml, type Column, type Relation, type Table } from '../../../src/markdown/dbml.js';

const PAD = 12, HEAD = 34, ROW = 30, GAP_X = 96, GAP_Y = 48, MARGIN = 16, STUB = 18;
const CHAR = 7, MONO = 7.2;

interface Box { table: Table; x: number; y: number; w: number; h: number; nameW: number }

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const keys = (c: Column): string[] => [c.pk ? 'PK' : '', c.fk ? 'FK' : '', c.unique && !c.pk ? 'UK' : ''].filter(Boolean);
const badgeW = (k: string): number => k.length * 7 + 16;

function measure(table: Table): { w: number; h: number; nameW: number } {
    const nameW = Math.max(0, ...table.columns.map(c => c.name.length * CHAR));
    const typeW = Math.max(0, ...table.columns.map(c => c.type.length * MONO));
    const keyW = Math.max(0, ...table.columns.map(c => keys(c).reduce((n, k) => n + badgeW(k) + 4, 0)));
    const w = Math.max(168, table.name.length * CHAR + PAD * 2 + 20, PAD + nameW + 20 + typeW + (keyW ? 16 + keyW : 0) + PAD);
    return { w: Math.ceil(w), h: HEAD + Math.max(1, table.columns.length) * ROW, nameW };
}

function layout(tables: Table[]): Box[] {
    const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));
    const sizes = tables.map(measure);
    const widths: number[] = [], heights: number[] = [];
    sizes.forEach((s, i) => {
        widths[i % cols] = Math.max(widths[i % cols] ?? 0, s.w);
        heights[Math.floor(i / cols)] = Math.max(heights[Math.floor(i / cols)] ?? 0, s.h);
    });
    return tables.map((table, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const x = MARGIN + widths.slice(0, c).reduce((n, w) => n + w + GAP_X, 0);
        const y = MARGIN + heights.slice(0, r).reduce((n, h) => n + h + GAP_Y, 0);
        return { table, x: x + (widths[c] - sizes[i].w) / 2, y, ...sizes[i] };
    });
}

// The end of a relation on a table's edge: a crow's foot for "many", a single tick for "one". dir points away from the table.
function mark(x: number, y: number, dir: number, many: boolean): string {
    return many
        ? `<path class="er-line" d="M${x + dir * 11} ${y}L${x} ${y - 5}M${x + dir * 11} ${y}L${x} ${y + 5}M${x + dir * 11} ${y - 5}V${y + 5}"/>`
        : `<path class="er-line" d="M${x + dir * 8} ${y - 5}V${y + 5}M${x + dir * 12} ${y - 5}V${y + 5}"/>`;
}

function relation(r: Relation, boxes: Map<string, Box>): string {
    const a = boxes.get(r.from), b = boxes.get(r.to);
    if (!a || !b || a === b) return '';
    const rowY = (box: Box, col: string): number => {
        const i = Math.max(0, box.table.columns.findIndex(c => c.name === col));
        return box.y + HEAD + i * ROW + ROW / 2;
    };
    const ay = rowY(a, r.fromCol), by = rowY(b, r.toCol);
    const manyA = r.op === '>' || r.op === '<>', manyB = r.op === '<' || r.op === '<>';
    let ax: number, bx: number, da: number, db: number;
    if (a.x + a.w + 8 <= b.x) { ax = a.x + a.w; bx = b.x; da = 1; db = -1; }
    else if (b.x + b.w + 8 <= a.x) { ax = a.x; bx = b.x + b.w; da = -1; db = 1; }
    else { ax = a.x + a.w; bx = b.x + b.w; da = 1; db = 1; }
    const out = da === db ? Math.max(ax, bx) + STUB * 2 : 0;
    const mid = da === db ? out : (ax + bx) / 2;
    const d = `M${ax + da * 12} ${ay}H${da === db ? out : mid}V${by}H${bx + db * 12}`;
    return `<path class="er-line" d="${d}"/>${mark(ax, ay, da, manyA)}${mark(bx, by, db, manyB)}`;
}

export function dbmlToSvg(source: string): string {
    const schema = resolveDbml(source);
    const boxes = layout(schema.tables);
    const byName = new Map(boxes.map(b => [b.table.name, b]));
    const width = Math.max(...boxes.map(b => b.x + b.w), 0) + MARGIN + STUB * 2 + 12;
    const height = Math.max(...boxes.map(b => b.y + b.h), 0) + MARGIN;
    const tableSvg = (b: Box): string => {
        const { table, x, y, w, h } = b;
        const rows = table.columns.map((c, i) => {
            const cy = y + HEAD + i * ROW + ROW / 2;
            let kx = x + w - PAD;
            const badges = keys(c).reverse().map(k => {
                kx -= badgeW(k);
                const out = `<rect class="er-badge ${k === 'PK' ? 'pk' : ''}" x="${kx}" y="${cy - 10}" width="${badgeW(k)}" height="20" rx="10"/><text class="er-badge-text ${k === 'PK' ? 'pk' : ''}" x="${kx + badgeW(k) / 2}" y="${cy}">${k}</text>`;
                kx -= 4;
                return out;
            }).join('');
            return `${i > 0 ? `<path class="er-divider" d="M${x} ${y + HEAD + i * ROW}H${x + w}"/>` : ''}<text class="er-name" x="${x + PAD}" y="${cy}">${esc(c.name)}</text><text class="er-type" x="${x + PAD + b.nameW + 20}" y="${cy}">${esc(c.type)}</text>${badges}`;
        }).join('');
        return `<g><rect class="er-card" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/><path class="er-head" d="M${x} ${y + HEAD}V${y + 8}a8 8 0 0 1 8-8H${x + w - 8}a8 8 0 0 1 8 8V${y + HEAD}Z"/><path class="er-divider" d="M${x} ${y + HEAD}H${x + w}"/><text class="er-title" x="${x + PAD}" y="${y + HEAD / 2}">${esc(table.name)}</text>${rows}<rect class="er-outline" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/></g>`;
    };
    return `<svg class="er-diagram" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${schema.relations.map(r => relation(r, byName)).join('')}${boxes.map(tableSvg).join('')}</svg>`;
}
