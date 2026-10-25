// shadcn/ui ContextMenu: the menu of a right click. Like DropdownMenu it opens with shadcn's animation and closes at once,
// so a menu still fading out never swallows the next click.

import type { ComponentProps } from 'react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import { CheckIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEM = "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";
const CONTENT = 'z-[60] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95';

export function ContextMenu(props: ComponentProps<typeof ContextMenuPrimitive.Root>) {
    return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

export function ContextMenuTrigger(props: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
    return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Content>) {
    return (
        <ContextMenuPrimitive.Portal>
            <ContextMenuPrimitive.Content data-slot="context-menu-content"
                className={cn(CONTENT, 'max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin)', className)} {...props} />
        </ContextMenuPrimitive.Portal>
    );
}

export function ContextMenuGroup(props: ComponentProps<typeof ContextMenuPrimitive.Group>) {
    return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

export function ContextMenuItem({ className, inset, variant = 'default', ...props }: ComponentProps<typeof ContextMenuPrimitive.Item> & { inset?: boolean; variant?: 'default' | 'destructive' }) {
    return (
        <ContextMenuPrimitive.Item data-slot="context-menu-item" data-inset={inset} data-variant={variant}
            className={cn(ITEM, "data-[inset]:pl-8 data-[variant=destructive]:text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground", className)} {...props} />
    );
}

export function ContextMenuCheckboxItem({ className, children, checked, ...props }: ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
    return (
        <ContextMenuPrimitive.CheckboxItem data-slot="context-menu-checkbox-item" checked={checked} className={cn(ITEM, 'py-1.5 pr-2 pl-8', className)} {...props}>
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <ContextMenuPrimitive.ItemIndicator><CheckIcon className="size-4" /></ContextMenuPrimitive.ItemIndicator>
            </span>
            {children}
        </ContextMenuPrimitive.CheckboxItem>
    );
}

export function ContextMenuSub(props: ComponentProps<typeof ContextMenuPrimitive.Sub>) {
    return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

export function ContextMenuSubTrigger({ className, inset, children, ...props }: ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { inset?: boolean }) {
    return (
        <ContextMenuPrimitive.SubTrigger data-slot="context-menu-sub-trigger" data-inset={inset}
            className={cn(ITEM, 'data-[inset]:pl-8 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground', className)} {...props}>
            {children}
            <ChevronRightIcon className="ml-auto" />
        </ContextMenuPrimitive.SubTrigger>
    );
}

export function ContextMenuSubContent({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
    return <ContextMenuPrimitive.SubContent data-slot="context-menu-sub-content" className={cn(CONTENT, 'origin-(--radix-context-menu-content-transform-origin) shadow-lg', className)} {...props} />;
}

export function ContextMenuLabel({ className, inset, ...props }: ComponentProps<typeof ContextMenuPrimitive.Label> & { inset?: boolean }) {
    return <ContextMenuPrimitive.Label data-slot="context-menu-label" data-inset={inset} className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground data-[inset]:pl-8', className)} {...props} />;
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
    return <ContextMenuPrimitive.Separator data-slot="context-menu-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export function ContextMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
    return <span data-slot="context-menu-shortcut" className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)} {...props} />;
}
