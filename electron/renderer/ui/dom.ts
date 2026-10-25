// The primitives for a widget that builds its DOM without React (an editor widget, the find bar in lib/): the same
// classes as the React primitive, so it looks and behaves the same (docs/design/ui.md "Widgets without React").

import type { VariantProps } from 'class-variance-authority';
import { buttonVariants } from '@/ui/button';

export interface DomButtonOptions extends VariantProps<typeof buttonVariants> {
    // The button's name: its text, or for an icon only its aria-label and its title (no Tooltip outside React).
    label: string;
    // What it shows instead of the label: an icon (iconElement) or a shorter text.
    content?: Node | string;
    type?: 'button' | 'submit';
    className?: string;
    // The editor keeps the focus and the selection while the button is pressed (true by default).
    keepFocus?: boolean;
    onClick?: (event: MouseEvent) => void;
}

// A Button: `ghost` and `sm` by default, as in the window's bars; an icon size for an icon only.
export function domButton({ label, content, variant = 'ghost', size = 'sm', type = 'button', className, keepFocus = true, onClick }: DomButtonOptions): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = type;
    button.dataset.slot = 'button';
    button.className = buttonVariants({ variant, size, className });
    if (content === undefined) button.textContent = label;
    else {
        button.append(content);
        button.title = label;
        button.setAttribute('aria-label', label);
    }
    if (keepFocus) button.addEventListener('mousedown', event => event.preventDefault());
    if (onClick) button.addEventListener('click', onClick);
    return button;
}
