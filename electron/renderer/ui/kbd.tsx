// shadcn/ui Kbd: a key or a shortcut. Inside a Tooltip it takes the tooltip's inverted colors.

import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
    return (
        <kbd data-slot="kbd" className={cn('pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground [[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background', className)}
            {...props} />
    );
}
