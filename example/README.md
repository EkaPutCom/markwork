# Example workspace

Open this directory to see ordinary folders beside a new-format pi agent:

```sh
npm start -- example
```

Select **research-agent** in Explorer, or run `npm start -- example/research-agent`.
Its version-2 `agent.json` has a stable UUID and points at editable `instructions.md`.
Source documents live in `research-agent/workspace/`, pi's working directory.

Install exactly **pi 1.4.0** and authenticate it in a terminal. Select **Activate pi
agent** in Sessions and read the notice. This is trusted-local, unsandboxed use:
pi writes files, runs commands and accesses the network directly, without Apply.
The working directory is not a filesystem boundary. Use backups/version control;
editor Undo cannot reverse arbitrary tool effects. Do not put sensitive data here
without understanding that tools and providers can receive it.

Try:

- “Compare plan.md with references/meeting.md. What needs updating?”
- “Update the release date to match the meeting decision.”
- “Write a sourced launch brief to output/brief.md and save reusable facts in memory.md.”

Markdown stays editable in normal tabs. **New chat** has an independent native
session; sessions share workspace memory, not their entire histories. One turn
runs at a time per agent, with other sessions queued. Closing a chat tab does not
stop it; **Stop** is explicit. Avoid editing the same files while pi works; disk
conflicts preserve unsaved drafts and need explicit resolution before saving.

Native sessions live in Markwork's durable application data. `chats/*.md` are
readable projections, ignored by Git, not executable history. The example ships
without fabricated sessions. Do not reuse this example UUID for a second active
copy on the same machine: use **New Agent…** to create another identity.

Local pi runs while Markwork is open. Background pi/markworkd support is deferred;
there is no fallback to the old folder worker. The ordinary Assistant still uses
its existing proposal/Apply behavior and credential settings.
