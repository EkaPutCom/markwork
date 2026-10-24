# The shadcn/ui mockup

The reference for the look of the window, approved on 20 October 2026 before the renderer moved to shadcn/ui. Each
`.dc.html` file is one artboard of the design canvas it was drawn on (plain HTML with inline styles; open one in a
browser to see it, the `support.js` it names is the canvas's and is not needed for the picture):

| File | What it shows |
| --- | --- |
| `Main.dc.html` | The editor in the light theme: the sidebar (workspace, Home, Inbox, Journal, Search, the Files tree, the pages at the foot), the header with the breadcrumb and the Unsaved badge, the tabs, the text |
| `Board.dc.html` | A kanban board with the sidebar closed to its rail, the layout switch, tags as badges with a colored dot, an overdue date in red |
| `Assistant.dc.html` | The Assistant beside the editor in the dark theme: a proposal applied with its diff, the actions under an answer, the input with its context |
| `Palette.dc.html` | The command palette (shadcn's Command) over the editor |
| `Programs.dc.html` | Home's Set up section and the Programs page (git, pi, markworkd): agents in this window, on an SSH machine, and through markworkd on this computer (drawn 21 October 2026, plain HTML without the canvas) |
| `Wysiwyg.html` | A proposal, not yet approved: a visual (WYSIWYG) editor for people who do not know Markdown, with a formatting toolbar, a selection menu, a `/` menu, table controls, and a Visual / Markdown switch that shows the file as saved. It works in the browser (drawn 21 October 2026, plain HTML without the canvas) |
| `Split.html` | A proposal, not yet approved: the editor split into panes like VS Code. Each pane has its own tab bar and its own Visual / Markdown switch; a pane is made by the split button, the pane's ⋯ menu, or by dragging a tab (or a file from the sidebar) to the edge of a pane, where the drop zone shows before you let go; the lines between panes are dragged to resize them. A Visual text pane has its own formatting toolbar, block handle, and `/` menu. It works in the browser (drawn 22 October 2026, plain HTML without the canvas) |
| `Sidebar.html` | A proposal, not yet approved: the sidebar like VS Code's. An activity bar that is always there (Files, Search, History, Pull requests; Programs and Preferences at the foot) and a sidebar for the view shown; Files is a view of foldable sections (Open Editors, by pane once the editor is split, the folder, Outline, and Timeline) that share the height, are resized by their lines, and are shown or hidden from the view's ⋯ menu. It works in the browser (drawn 22 October 2026, plain HTML without the canvas) |
| `Debugger.html` | A proposal, not yet approved: an Editor Inspector for finding bugs in the visual editor. The text twice (as drawn, with its hidden ranges, widgets, and prefixes laid over it, and as Markdown with offsets), a dock of transactions, decorations, checks, and replay that turns a recording into a test; the same inspector as `markwork editor` commands in JSON for an AI agent; and a "Something looks wrong" report that saves a repro with the text blurred. It works in the browser (drawn 23 October 2026, plain HTML without the canvas) |

The app follows it with a few differences where the app has more than the mockup draws: the sidebar's top menu has
Home and Journal (Inbox is a kind of document, Search one of the pages at the foot), and the layout button is one menu
button rather than a row of three, since there are eight layouts. `docs/assets/` shows the app as it is.
