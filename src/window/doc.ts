// The open document records as the GTK window holds them: app/document.ts's Doc with a MarkdownView as its editor.

import type { Doc as AppDoc } from '../app/document.js';
import type { MarkdownView } from '../editor/view.js';

export type Doc = AppDoc<MarkdownView>;
