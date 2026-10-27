// Shared documentation navigation: the sidebar, the page filter, the table of contents, and the previous/next buttons.
// Adding a new page only needs an entry in PAGES; the order also decides the pager.
const PAGES = [
  ['Getting started', [
    ['index.html', 'Quick start'],
    ['concepts.html', 'Basic concepts'],
  ]],
  ['Agent', [
    ['assistant.html', 'The Assistant panel'],
    ['context.html', 'Context and privacy'],
    ['browsing.html', 'Browsing files and Git'],
    ['proposals.html', 'Proposals and approval'],
    ['work.html', 'Plans and verification'],
    ['history.html', 'History, journal, and log'],
    ['orchestrator.html', 'The pi orchestrator'],
  ]],
  ['Workspace', [
    ['editor.html', 'The Markdown editor'],
    ['diagram.html', 'Mermaid and DBML diagrams'],
    ['kanban.html', 'The kanban board'],
    ['layouts.html', 'Views of the same notes'],
    ['inbox.html', 'Inbox'],
    ['home.html', 'Home'],
    ['journal.html', 'The daily journal'],
    ['files.html', 'Files, tabs, and the sidebar'],
    ['git.html', 'Git history'],
    ['collaboration.html', 'Collaboration'],
  ]],
  ['Reference', [
    ['tools.html', 'Agent tool list'],
    ['shortcuts.html', 'Shortcuts'],
    ['settings.html', 'Settings'],
    ['limitations.html', 'Limitations'],
  ]],
  ['For developers', [
    ['../learn-agent.html', 'Learn to build an agent'],
    ['../learn-performance.html', 'Learn performance'],
  ]],
];

window.markworkSite.documentation(PAGES);
