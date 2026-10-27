// The sample document shown the first time the app is opened.

export const WELCOME = `# Welcome to Markwork

A personal workspace for notes, plans, and tasks, together with AI agents (open the panel with \`Ctrl+Shift+A\`). Everything is **Markdown** that is formatted live: the syntax is hidden, and shows up again when the cursor is on its line. Try clicking this line.

## Text formatting

- **Bold** with \`Ctrl+B\`, *italic* with \`Ctrl+I\`
- ~~Strikethrough~~, ==highlight==, and \`inline code\`
- Link: [Markwork](https://markwork.id) — **Ctrl+click** to open

## Task list

- [x] Open a work folder
- [ ] Note down today's meeting decisions (click the box to check it)

1. Write a plan
2. Press Enter to continue automatically

> Quotes work too.
> Press Enter on an empty line to leave.

\`\`\`js
function remainingBudget(total, spent) {
    return total - spent;
}
\`\`\`

| Shortcut | Function |
| -------- | ------ |
| Ctrl+1…6 | Heading |
| Ctrl+/   | Source mode |
| F8       | Focus mode |

\`\`\`mermaid
graph LR
    A[Note] --> B{Needs follow-up?}
    B -->|yes| C[Create a task]
    B -->|not yet| A
\`\`\`

---

Open the ☰ menu for HTML export, dark mode, and more.
`;
