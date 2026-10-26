// shadcn/ui Checkbox: an item in a list or a form that is submitted (a setting that applies at once is a Switch).

import type { ComponentProps } from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// Its classes, shared with domCheckbox (ui/dom.ts) so a widget without React draws the same box.
export const checkboxClasses = cn('peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs outline-none transition-shadow disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:data-[state=checked]:bg-primary',
                'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40');
export const checkboxIndicatorClasses = 'flex items-center justify-center text-current transition-none';

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
    return (
        <CheckboxPrimitive.Root data-slot="checkbox" className={cn(checkboxClasses, className)} {...props}>
            <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className={checkboxIndicatorClasses}>
                <CheckIcon className="size-3.5" />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}
