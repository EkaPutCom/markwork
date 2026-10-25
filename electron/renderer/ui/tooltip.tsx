// shadcn/ui Tooltip: a control's name and shortcut on hover and on keyboard focus. Most places get it through IconButton
// (docs/design/ui.md "Tooltip and title"). It waits a moment before it shows, so a pointer passing over a toolbar does
// not flash every name; one shown makes the next show at once (Radix's skip delay).

import type { ComponentProps } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function TooltipProvider({ delayDuration = 400, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
    return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

export function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
    return (
        <TooltipProvider>
            <TooltipPrimitive.Root data-slot="tooltip" {...props} />
        </TooltipProvider>
    );
}

export function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({ className, sideOffset = 4, children, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content data-slot="tooltip-content" sideOffset={sideOffset}
                className={cn('z-[60] flex w-fit origin-(--radix-tooltip-content-transform-origin) items-center gap-2 text-balance rounded-md bg-foreground px-3 py-1.5 text-xs text-background animate-in fade-in-0 zoom-in-95', className)}
                {...props}>
                {children}
                <TooltipPrimitive.Arrow className="z-[60] size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
            </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
    );
}
