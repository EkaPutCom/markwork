// Markwork — Markdown workspace for humans and AI agents (Markdown editor, kanban, Git history, AI assistant) with GTK 4 + GtkSourceView 5 (GJS).
// Application entry point. Build: npm run build, then run: gjs -m dist/markwork.js [file.md]

import './i18n.js';   // bind the gettext domain before other modules are evaluated
import './platform/gjs/install.js';   // the core reaches the runtime through platform()
import System from 'system';
import { main } from './app.js';

System.exit(main(System.programArgs));
