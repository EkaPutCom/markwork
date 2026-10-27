// shadcn/ui Sonner: a short notice that goes away (ui.md "Primitives"). The window has one Toaster; `toast(…)` from the
// sonner package shows a notice in it. Never the only place an error is told when the user must act on it.

import type { ComponentProps } from 'react';
import { Toaster as Sonner } from 'sonner';

export function Toaster({ theme = 'system', ...props }: ComponentProps<typeof Sonner>) {
    return (
        <Sonner theme={theme} className="toaster group [--normal-bg:var(--popover)] [--normal-border:var(--border)] [--normal-text:var(--popover-foreground)]"
            toastOptions={{ classNames: {
                toast: 'font-sans text-sm', actionButton: 'font-medium',
                closeButton: '[--toast-close-button-start:auto] [--toast-close-button-end:0] [--toast-close-button-transform:translate(35%,-35%)]',
            } }}
            {...props} />
    );
}
