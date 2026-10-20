// Matching a key event against the neutral notation of app/commands.ts ("Ctrl+Shift+z"). Ctrl stands for Cmd on macOS.

export function matches(event: KeyboardEvent, combo: string): boolean {
    const parts = combo.split('+');
    const key = parts.pop() ?? '';
    const ctrl = parts.includes('Ctrl'), alt = parts.includes('Alt'), shift = parts.includes('Shift');
    if ((event.ctrlKey || event.metaKey) !== ctrl || event.altKey !== alt) return false;
    // A symbol typed with Shift ("?") is written without it in the table.
    if (event.shiftKey !== shift && !(!shift && key.length === 1 && !/[a-z0-9]/i.test(key))) return false;
    return event.key.toLowerCase() === key.toLowerCase();
}

// How a key is written in a menu or the palette.
export const label = (combo: string): string => combo.replace('Ctrl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl');
