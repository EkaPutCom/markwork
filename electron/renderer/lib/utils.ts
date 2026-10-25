// The class-name helper of shadcn/ui: joins conditional classes and lets a later Tailwind class win over an earlier one.
// tailwind-merge is told about the window's own text sizes (globals.css: text-2xs, text-ui), so it does not take them for
// text colors and drop a `text-muted-foreground` beside them.

import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({ extend: { classGroups: { 'font-size': [{ text: ['2xs', 'ui'] }] } } });

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
