// Markwork — Markdown workspace for humans and AI agents (Markdown editor, kanban, Git history, AI assistant) with GTK 4 + GtkSourceView 5 (GJS).
// Application entry point. Build: npm run build, then run: gjs -m dist/markwork.js [file.md]

import './platform/gjs/install.js';   // first: the runtime for platform(), and the gettext domain before any module calls _()
import System from 'system';
import { main } from './app.js';

System.exit(main(System.programArgs));
