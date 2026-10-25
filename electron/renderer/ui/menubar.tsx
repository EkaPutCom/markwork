// shadcn/ui Menubar (the parts this window uses): the row of menus at the top, as VS Code's. Like the DropdownMenu, a menu
// closes at once, so the next click is not swallowed.

import type { ComponentProps } from 'react';
import { Menubar as MenubarPrimitive } from 'radix-ui';
import { CheckIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Menubar({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Root>) {
    return <MenubarPrimitive.Root data-slot="menubar" className={cn('flex items-center gap-0.5', className)} {...props} />;
}

export function MenubarMenu(props: ComponentProps<typeof MenubarPrimitive.Menu>) {
    return <MenubarPrimitive.Menu {...props} />;
}

export function MenubarTrigger({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Trigger>) {
    return (
        <MenubarPrimitive.Trigger data-slot="menubar-trigger"
            className={cn('flex h-6 cursor-default select-none items-center rounded-sm px-2 text-ui outline-hidden hover:bg-accent focus:bg-accent data-[state=open]:bg-accent', className)}
            {...props} />
    );
}

const popup = 'z-50 min-w-[8rem] origin-(--radix-menubar-content-transform-origin) overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95';
const row = "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";

export function MenubarContent({ className, align = 'start', alignOffset = -4, sideOffset = 6, ...props }: ComponentProps<typeof MenubarPrimitive.Content>) {
    return (
        <MenubarPrimitive.Portal>
            <MenubarPrimitive.Content data-slot="menubar-content" align={align} alignOffset={alignOffset} sideOffset={sideOffset}
                className={cn(popup, 'max-h-(--radix-menubar-content-available-height) min-w-56', className)} {...props} />
        </MenubarPrimitive.Portal>
    );
}

export function MenubarItem({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Item>) {
    return <MenubarPrimitive.Item data-slot="menubar-item" className={cn(row, className)} {...props} />;
}

export function MenubarCheckboxItem({ className, children, checked, ...props }: ComponentProps<typeof MenubarPrimitive.CheckboxItem>) {
    return (
        <MenubarPrimitive.CheckboxItem data-slot="menubar-checkbox-item" checked={checked} className={cn(row, 'pl-8', className)} {...props}>
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <MenubarPrimitive.ItemIndicator><CheckIcon className="size-4" /></MenubarPrimitive.ItemIndicator>
            </span>
            {children}
        </MenubarPrimitive.CheckboxItem>
    );
}

export function MenubarSeparator({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Separator>) {
    return <MenubarPrimitive.Separator data-slot="menubar-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export function MenubarLabel({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Label>) {
    return <MenubarPrimitive.Label data-slot="menubar-label" className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)} {...props} />;
}

export function MenubarShortcut({ className, ...props }: ComponentProps<'span'>) {
    return <span data-slot="menubar-shortcut" className={cn('ml-auto pl-6 text-xs tracking-widest text-muted-foreground', className)} {...props} />;
}

export function MenubarSub(props: ComponentProps<typeof MenubarPrimitive.Sub>) {
    return <MenubarPrimitive.Sub {...props} />;
}

export function MenubarSubTrigger({ className, children, ...props }: ComponentProps<typeof MenubarPrimitive.SubTrigger>) {
    return (
        <MenubarPrimitive.SubTrigger data-slot="menubar-sub-trigger" className={cn(row, className)} {...props}>
            {children}<ChevronRightIcon className="ml-auto size-4" />
        </MenubarPrimitive.SubTrigger>
    );
}

export function MenubarSubContent({ className, ...props }: ComponentProps<typeof MenubarPrimitive.SubContent>) {
    return (
        <MenubarPrimitive.Portal>
            <MenubarPrimitive.SubContent data-slot="menubar-sub-content" className={cn(popup, 'min-w-44', className)} {...props} />
        </MenubarPrimitive.Portal>
    );
}
