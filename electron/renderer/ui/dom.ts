// The primitives for a widget that builds its DOM without React (an editor widget, the find bar in lib/): the same
// classes as the React primitive, so it looks and behaves the same (docs/design/ui.md "Widgets without React").

import type { VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { iconElement } from '@/components/Icons';
import { buttonVariants } from '@/ui/button';
import { checkboxClasses, checkboxIndicatorClasses } from '@/ui/checkbox';
import { inputClasses } from '@/ui/input';
import { kbdClasses } from '@/ui/kbd';
import { addonVariants, inputGroupClasses, inputGroupInputClasses } from '@/ui/input-group';
import { toggleVariants } from '@/ui/toggle';

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
    button.className = cn(buttonVariants({ variant, size }), className);
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

export interface DomToggleOptions extends VariantProps<typeof toggleVariants> {
    // Its name, as for an icon button: aria-label and title.
    label: string;
    content: Node | string;
    pressed?: boolean;
    className?: string;
    // Called with the new state after a click has turned it.
    onChange?: (pressed: boolean) => void;
}

// A Toggle: a button that stays pressed, its state in aria-pressed (which the classes draw). It keeps the focus where it is.
export function domToggle({ label, content, pressed = false, variant, size, className, onChange }: DomToggleOptions): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.slot = 'toggle';
    button.className = toggleVariants({ variant, size, className });
    button.append(content);
    button.title = label;
    button.setAttribute('aria-label', label);
    setPressed(button, pressed);
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => { setPressed(button, !isPressed(button)); onChange?.(isPressed(button)); });
    return button;
}

export const isPressed = (button: HTMLElement): boolean => button.getAttribute('aria-pressed') === 'true';
export const setPressed = (button: HTMLElement, on: boolean): void => button.setAttribute('aria-pressed', String(on));

export interface DomInputOptions {
    // Its name for a screen reader, when no label stands beside it.
    label?: string;
    value?: string;
    placeholder?: string;
    name?: string;
    className?: string;
}

// An Input; with `inGroup` the entry of an InputGroup (no border of its own).
export function domInput({ label, value = '', placeholder, name, className }: DomInputOptions, inGroup = false): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.slot = inGroup ? 'input-group-control' : 'input';
    input.className = cn(inputClasses, inGroup && inputGroupInputClasses, className);
    input.value = value;
    input.spellcheck = false;
    if (placeholder) input.placeholder = placeholder;
    if (name) input.name = name;
    if (label) input.setAttribute('aria-label', label);
    return input;
}

// An InputGroup: an entry with addons (an icon, toggles, buttons) inside its border.
export function domInputGroup(className?: string): HTMLDivElement {
    const group = document.createElement('div');
    group.dataset.slot = 'input-group';
    group.setAttribute('role', 'group');
    group.className = cn(inputGroupClasses, className);
    return group;
}

// An addon of an InputGroup; a click on it, not on a button in it, puts the cursor in the group's entry.
export function domInputGroupAddon(align: 'inline-start' | 'inline-end' = 'inline-start', className?: string): HTMLDivElement {
    const addon = document.createElement('div');
    addon.dataset.slot = 'input-group-addon';
    addon.dataset.align = align;
    addon.className = cn(addonVariants({ align }), className);
    addon.addEventListener('click', event => {
        if ((event.target as HTMLElement).closest('button')) return;
        addon.parentElement?.querySelector<HTMLInputElement>('[data-slot=input-group-control]')?.focus();
    });
    return addon;
}

// A Checkbox as Radix draws it: a button with role checkbox, its state in aria-checked and data-state. The caller turns it
// (`setChecked`) when the state it stands for changes.
export function domCheckbox({ label, checked = false, className }: { label: string; checked?: boolean; className?: string }): HTMLButtonElement {
    const box = document.createElement('button');
    box.type = 'button';
    box.dataset.slot = 'checkbox';
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-label', label);
    box.className = cn(checkboxClasses, className);
    setChecked(box, checked);
    return box;
}

export function setChecked(box: HTMLButtonElement, checked: boolean): void {
    box.setAttribute('aria-checked', String(checked));
    box.dataset.state = checked ? 'checked' : 'unchecked';
    box.replaceChildren();
    if (!checked) return;
    const indicator = document.createElement('span');
    indicator.dataset.slot = 'checkbox-indicator';
    indicator.className = checkboxIndicatorClasses;
    const icon = iconElement('emblem-ok', 14);
    icon.classList.add('size-3.5');
    indicator.append(icon);
    box.append(indicator);
}

// A Kbd: a key, as a hint beside what it does.
export function domKbd(key: string): HTMLElement {
    const kbd = document.createElement('kbd');
    kbd.dataset.slot = 'kbd';
    kbd.className = kbdClasses;
    kbd.textContent = key;
    return kbd;
}
