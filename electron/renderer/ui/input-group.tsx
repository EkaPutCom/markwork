// shadcn/ui InputGroup: an entry with an icon, a text, or buttons inside it (the search entry with its magnifier and
// Aa / ab / .*). A click on an addon puts the cursor in the entry.

import type { ComponentProps, MouseEvent } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

export function InputGroup({ className, ...props }: ComponentProps<'div'>) {
    return (
        <div data-slot="input-group" role="group"
            className={cn('group/input-group relative flex h-9 w-full min-w-0 items-center rounded-md border border-input shadow-xs outline-none transition-[color,box-shadow] dark:bg-input/30',
                'has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-[3px] has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50',
                'has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-destructive/20 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40', className)}
            {...props} />
    );
}

const addonVariants = cva(
    "flex h-auto cursor-text select-none items-center justify-center gap-2 py-1.5 text-sm font-medium text-muted-foreground group-data-[disabled=true]/input-group:opacity-50 [&>svg:not([class*='size-'])]:size-4",
    {
        variants: {
            align: {
                'inline-start': 'order-first pl-3 has-[>button]:ml-[-0.45rem]',
                'inline-end': 'order-last pr-3 has-[>button]:mr-[-0.45rem]',
            },
        },
        defaultVariants: { align: 'inline-start' },
    },
);

// A click on the addon itself (not on a button in it) focuses the entry.
function focusEntry(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.parentElement?.querySelector<HTMLInputElement>('[data-slot=input-group-control]')?.focus();
}

export function InputGroupAddon({ className, align = 'inline-start', ...props }: ComponentProps<'div'> & VariantProps<typeof addonVariants>) {
    return <div data-slot="input-group-addon" data-align={align} className={cn(addonVariants({ align }), className)} onClick={focusEntry} {...props} />;
}

export function InputGroupButton({ className, variant = 'ghost', size = 'xs', ...props }: ComponentProps<typeof Button>) {
    return <Button data-size={size} variant={variant} size={size} className={cn('shadow-none', className)} {...props} />;
}

export function InputGroupInput({ className, ...props }: ComponentProps<'input'>) {
    return <Input data-slot="input-group-control" className={cn('flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent', className)} {...props} />;
}
