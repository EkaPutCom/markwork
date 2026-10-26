// The small toolbar that appears over a picture, a diagram, or a code block when the pointer is on it (Zoom, Edit source,
// Copy, Delete), so what a block offers can be seen instead of guessed (a double click, a hidden markup).

import { iconElement, type IconName } from '../components/Icons.js';
import { domButton } from '../ui/dom.js';

export const ZOOM_ICON: IconName = 'zoom-in';
export const DELETE_ICON: IconName = 'edit-clear';
export const SOURCE_ICON: IconName = 'format-code';
const COPY_ICON: IconName = 'edit-copy';
const DONE_ICON: IconName = 'emblem-ok';

export interface Tool { label: string; icon: IconName; run: (button: HTMLButtonElement) => void }

function tool({ label, icon, run }: Tool): HTMLButtonElement {
    const button = domButton({ label, content: iconElement(icon, 14), size: 'icon-xs', className: 'cm-md-block-tool size-6', keepFocus: false, onClick: event => { event.stopPropagation(); run(button); } });
    // The block under the toolbar treats a press as a click on itself (it opens the source); the toolbar's own press is not.
    button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    return button;
}

export function blockTools(tools: readonly Tool[]): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-md-block-tools';
    bar.contentEditable = 'false';
    bar.append(...tools.map(tool));
    return bar;
}

// Copy a text; the button shows a check for a moment.
export function copyTool(text: () => string): Tool {
    return {
        label: 'Copy', icon: COPY_ICON, run: button => {
            void navigator.clipboard.writeText(text()).then(() => {
                button.replaceChildren(iconElement(DONE_ICON, 14));
                setTimeout(() => button.replaceChildren(iconElement(COPY_ICON, 14)), 1200);
            });
        },
    };
}
