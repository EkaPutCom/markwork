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

The app follows it with a few differences where the app has more than the mockup draws: the sidebar's top menu has
Home and Journal (Inbox is a kind of document, Search one of the pages at the foot), and the layout button is one menu
button rather than a row of three, since there are eight layouts. `docs/assets/` shows the app as it is.
