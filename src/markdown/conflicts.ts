// Git conflict markers in a text: where each conflict is, and what a choice turns it into. Pure functions over lines,
// so they run in unit tests; electron/renderer/lib/conflicts.ts draws the result and applies the choice.
//
//   <<<<<<< HEAD            start   (current: what is in the folder)
//   our lines
//   ||||||| base            base    (only with merge.conflictStyle = diff3 or zdiff3)
//   the common ancestor
//   =======                 mid
//   their lines
//   >>>>>>> refs/pull/7     end     (incoming: what is being merged)

export interface Conflict {
    start: number;           // line numbers, 0-based, all inside the document
    base: number | null;
    mid: number;
    end: number;
    current: string;         // what follows the marker on the first and last line (a branch name, a commit)
    incoming: string;
}

export type Choice = 'current' | 'incoming' | 'both';

const START = /^<{7}(?: (.*))?\r?$/;
const BASE = /^\|{7}(?: .*)?\r?$/;
const MID = /^={7}\r?$/;
const END = /^>{7}(?: (.*))?\r?$/;

// The marker lines are short and start with a fixed character, so most lines are rejected by one character check.
const mayBeMarker = (line: string): boolean => {
    const c = line.charCodeAt(0);
    return c === 60 || c === 124 || c === 61 || c === 62;   // < | = >
};

interface Open { start: number; base: number | null; mid: number; current: string }

// Every complete conflict, in order. A marker that does not fit (a `=======` underline in Markdown, an unclosed `<<<<<<<`) is
// left alone, so ordinary text is never taken for a conflict.
export function findConflicts(lines: readonly string[]): Conflict[] {
    const found: Conflict[] = [];
    let open: Open | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!mayBeMarker(line)) continue;
        const start = START.exec(line);
        if (start) { open = { start: i, base: null, mid: -1, current: start[1] ?? '' }; continue; }
        if (!open) continue;
        if (BASE.test(line) && open.mid < 0 && open.base === null) open.base = i;
        else if (MID.test(line) && open.mid < 0) open.mid = i;
        else if (END.test(line) && open.mid >= 0) {
            found.push({ start: open.start, base: open.base, mid: open.mid, end: i, current: open.current, incoming: END.exec(line)![1] ?? '' });
            open = null;
        }
    }
    return found;
}

// The lines that replace the whole conflict (markers included) for a choice.
export function resolution(lines: readonly string[], conflict: Conflict, choice: Choice): string[] {
    const current = lines.slice(conflict.start + 1, conflict.base ?? conflict.mid);
    const incoming = lines.slice(conflict.mid + 1, conflict.end);
    return choice === 'current' ? current : choice === 'incoming' ? incoming : [...current, ...incoming];
}

// What a line is inside a conflict, for the color of its background. The head lines are the markers that open each side;
// the divider and the base section are neutral.
export type Role = 'current' | 'currentHead' | 'incoming' | 'incomingHead' | 'neutral';

const roleOf = (c: Conflict, l: number): Role => {
    if (l === c.start) return 'currentHead';
    if (l === c.end) return 'incomingHead';
    if (l === c.mid || l === c.base) return 'neutral';
    if (l < (c.base ?? c.mid)) return 'current';
    return c.base !== null && l < c.mid ? 'neutral' : 'incoming';
};

// [line, role] for every line of every conflict, in order.
export function roles(conflicts: readonly Conflict[]): [number, Role][] {
    const out: [number, Role][] = [];
    for (const c of conflicts) for (let l = c.start; l <= c.end; l++) out.push([l, roleOf(c, l)]);
    return out;
}
