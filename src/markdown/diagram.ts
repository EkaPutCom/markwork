// Which fenced code blocks are drawn as diagrams. Shared by every frontend: GTK draws them in editor/mermaid.ts (DBML is
// first translated by dbml.ts) and leaves them out of the code coloring in editor/codelayer.ts.

import type { CodeBlock } from './highlight.js';

export type Kind = 'mermaid' | 'dbml';

// The diagram type of a code block, or null if it is not a diagram (or is empty/unclosed).
export const diagramKind = (block: CodeBlock): Kind | null => {
    if (!block.closed || block.text.trim() === '') return null;
    const lang = block.lang.toLowerCase();
    return lang === 'mermaid' ? 'mermaid' : lang === 'dbml' ? 'dbml' : null;
};
