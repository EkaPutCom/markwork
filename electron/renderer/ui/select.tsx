// shadcn/ui Select, called as the <select> it replaces: its options are <option> children and onChange gets the shape of a
// select's change event ({ target: { value } }), so a place that had a <select> changes its tag and nothing else. Radix does not
// allow an empty value for an item, so the empty option travels as NONE and is shown as "None".

import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Select as SelectPrimitive } from 'radix-ui';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const NONE = '\u0000none';

interface Choice { value: string; label: ReactNode }

// The <option>s among the children, through fragments and arrays: the value is the attribute, else the text.
function choices(children: ReactNode): Choice[] {
    return Children.toArray(children).flatMap((child): Choice[] => {
        if (!isValidElement(child)) return [];
        const el = child as ReactElement<{ value?: string; children?: ReactNode }>;
        if (el.type === 'option') {
            const text = Children.toArray(el.props.children).join('');
            return [{ value: el.props.value ?? text, label: text }];
        }
        return choices(el.props.children);
    });
}

interface SelectProps {
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    children: ReactNode;
    disabled?: boolean;
    className?: string;
    'aria-label'?: string;
}

export function Select({ value, onChange, children, disabled, className, 'aria-label': label }: SelectProps) {
    const items = choices(children);
    return (
        <SelectPrimitive.Root value={value === '' ? NONE : value} disabled={disabled} onValueChange={v => onChange({ target: { value: v === NONE ? '' : v } })}>
            <SelectPrimitive.Trigger data-slot="select-trigger" aria-label={label}
                className={cn('flex min-h-9 items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-1.5 text-start text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[placeholder]:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50', className)}>
                <SelectPrimitive.Value />
                <SelectPrimitive.Icon asChild><ChevronDownIcon className="size-4 shrink-0 opacity-50" /></SelectPrimitive.Icon>
            </SelectPrimitive.Trigger>
            <SelectPrimitive.Portal>
                <SelectPrimitive.Content data-slot="select-content" position="popper" sideOffset={4}
                    className="relative z-[60] max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-y-auto overflow-x-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
                    <SelectPrimitive.Viewport className="min-w-[var(--radix-select-trigger-width)] scroll-my-1 p-1">
                        {items.map(item => (
                            <SelectPrimitive.Item key={item.value} value={item.value === '' ? NONE : item.value}
                                className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
                                <span className="absolute left-2 flex size-3.5 items-center justify-center">
                                    <SelectPrimitive.ItemIndicator><CheckIcon className="size-4" /></SelectPrimitive.ItemIndicator>
                                </span>
                                <SelectPrimitive.ItemText>{item.label === '' ? <span className="text-muted-foreground">None</span> : item.label}</SelectPrimitive.ItemText>
                            </SelectPrimitive.Item>
                        ))}
                    </SelectPrimitive.Viewport>
                </SelectPrimitive.Content>
            </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
    );
}
