// The class-name helper of shadcn/ui: joins conditional classes and lets a later Tailwind class win over an earlier one.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
