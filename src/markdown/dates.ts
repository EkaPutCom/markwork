// Calendar-day arithmetic on "YYYY-MM-DD" strings, shared by the calendar and timeline layouts. A day is a whole
// number counted from 1970-01-01, so there are no time zones and no daylight saving to worry about. Pure TypeScript
// 

const DAY = 86400000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// The day number of a "YYYY-MM-DD" string, or null if it is not a real date (2026-02-30 is not).
export function dayNumber(date: string): number | null {
    const m = DATE.exec(date.trim());
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return dayString(Math.round(ms / DAY)) === date.trim() ? Math.round(ms / DAY) : null;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function dayString(day: number): string {
    const d = new Date(day * DAY);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const addDays = (date: string, n: number): string => dayString((dayNumber(date) ?? 0) + n);

// Days from `a` to `b` (negative if b is earlier).
export const daysBetween = (a: string, b: string): number => (dayNumber(b) ?? 0) - (dayNumber(a) ?? 0);

// 0 for Monday … 6 for Sunday; the week starts on Monday.
export const weekday = (date: string): number => (((dayNumber(date) ?? 0) + 3) % 7 + 7) % 7;

export const startOfWeek = (date: string): string => addDays(date, -weekday(date));

// "YYYY-MM" of a date.
export const monthOf = (date: string): string => date.slice(0, 7);

export function addMonths(month: string, n: number): string {
    const [y, m] = month.split('-').map(Number);
    const index = y * 12 + (m - 1) + n;
    return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

// The weeks shown for a month ("YYYY-MM"): whole weeks from the Monday on or before the 1st to the Sunday on or after
// the last day, so 4 to 6 rows of 7 days.
export function monthWeeks(month: string): string[][] {
    const first = `${month}-01`;
    const next = `${addMonths(month, 1)}-01`;
    const last = addDays(next, -1);
    const weeks: string[][] = [];
    for (let day = startOfWeek(first); daysBetween(day, last) >= 0; day = addDays(day, 7))
        weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
    return weeks;
}

export const weekDays = (date: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(date), i));
