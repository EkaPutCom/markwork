// shadcn/ui ToggleGroup: one of several choices, or several of them, joined into one row (a layout, Aa / ab / .*).

import { createContext, useContext, type ComponentProps } from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { toggleVariants } from '@/ui/toggle';

const ToggleGroupContext = createContext<VariantProps<typeof toggleVariants>>({ size: 'default', variant: 'default' });

export function ToggleGroup({ className, variant, size, children, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Root> & VariantProps<typeof toggleVariants>) {
    return (
        <ToggleGroupPrimitive.Root data-slot="toggle-group" data-variant={variant} data-size={size}
            className={cn('group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs', className)} {...props}>
            <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
        </ToggleGroupPrimitive.Root>
    );
}

export function ToggleGroupItem({ className, children, variant, size, ...props }: ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
    const context = useContext(ToggleGroupContext);
    const v = context.variant ?? variant, s = context.size ?? size;
    return (
        <ToggleGroupPrimitive.Item data-slot="toggle-group-item" data-variant={v} data-size={s}
            className={cn(toggleVariants({ variant: v, size: s }), 'min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l', className)}
            {...props}>
            {children}
        </ToggleGroupPrimitive.Item>
    );
}
