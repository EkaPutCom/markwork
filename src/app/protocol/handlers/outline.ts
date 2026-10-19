// The Outline panel: the heading the user chose, by its place in the list the core sent (`view.outline`).

import { num, type HandlerContext } from './context.js';

export function outlineHandlers({ wire, frontend }: HandlerContext): void {
    wire.on('act.outline.jump', p => { frontend.outline.onJump(num(p.index, 'index')); });
}
