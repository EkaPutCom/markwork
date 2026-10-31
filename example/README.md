# Example workspace

Open this directory to see ordinary folders beside an agent folder:

```sh
npm start -- example
```

Select **research-agent** in Explorer to open its chat and session list. Its
`agent.json` references the editable `instructions.md`. The `notes` and `projects`
folders are ordinary Markdown folders and stay outside this agent's context.

To start directly in the agent folder:

```sh
npm start -- example/research-agent
```

Configure your model credential in Assistant settings, then try:

- “Compare plan.md with references/meeting.md. What needs updating?”
- “Propose updating the release date to match the meeting decision.”
- “Prepare a short launch brief with citations.”

Review the proposed diff and press **Apply** to change a file. Markdown files
remain editable in normal document tabs. **New chat** opens an independent
conversation; its history is saved in `research-agent/chats/`. Conversations are
ignored by Git by default. Selecting a saved `layout: chat` transcript from Explorer opens that conversation in its chat tab. The example ships without a fabricated conversation.

Without a configured background worker, chat runs while Markwork is open. On
Linux, a compatible `markworkd` with an allowed `markwork-agent` program, this
folder allowed as a root, and a worker-accessible credential can continue started
work after the window closes. Pending file changes still require Apply.
