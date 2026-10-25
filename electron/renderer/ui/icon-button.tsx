// A button that shows only an icon (Markwork's own, docs/design/ui.md "Tooltip and title"). Its label is required and is
// both its accessible name and its Tooltip, with the shortcut beside it when there is one, so neither can be forgotten.
// A ghost button of the small icon size unless told otherwise.

import type { ComponentProps } from 'react';
import { Button } from '@/ui/button';
import { Kbd } from '@/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

type IconButtonProps = Omit<ComponentProps<typeof Button>, 'aria-label' | 'size'> & {
    label: string;
    shortcut?: string;
    size?: 'icon' | 'icon-sm' | 'icon-xs';
};

export function IconButton({ label, shortcut, variant = 'ghost', size = 'icon-sm', ...props }: IconButtonProps) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button data-slot="icon-button" variant={variant} size={size} aria-label={label} {...props} />
            </TooltipTrigger>
            <TooltipContent>
                {label}
                {shortcut && <Kbd>{shortcut}</Kbd>}
            </TooltipContent>
        </Tooltip>
    );
}
