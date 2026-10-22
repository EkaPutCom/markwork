// The small toolbar that appears over a picture, a diagram, or a code block when the pointer is on it (Zoom, Edit source,
// Copy, Delete), so what a block offers can be seen instead of guessed (a double click, a hidden markup).

const SVG = (paths: string) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const ZOOM_ICON = SVG('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>');
export const DELETE_ICON = SVG('<path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 11v5M14 11v5"/>');
export const SOURCE_ICON = SVG('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>');
export const COPY_ICON = SVG('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>');
const DONE_ICON = SVG('<path d="M20 6 9 17l-5-5"/>');

export interface Tool { label: string; icon: string; run: (button: HTMLButtonElement) => void }

function tool({ label, icon, run }: Tool): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-md-block-tool';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    // The block under the toolbar treats a press as a click on itself (it opens the source); the toolbar's own press is not.
    button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', event => { event.stopPropagation(); run(button); });
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
                button.innerHTML = DONE_ICON;
                setTimeout(() => { button.innerHTML = COPY_ICON; }, 1200);
            });
        },
    };
}
