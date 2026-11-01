# Plan: persistent folder agents powered by pi

Status: proposed; no runtime behavior is changed by this document. This plan supersedes the custom-engine execution direction in [agent-folders.md](agent-folders.md), while retaining compatible UI and lifecycle requirements.

Phase 0 local spike: **passed** on 1 November 2026. See [the runnable experiment, decisions, evidence, and remaining limits](agent-folders-pi-phase0.md). This does not enable pi-based Agent Folders in the application; Phase 1 and later gates remain pending.

## 1. Goal and agreed decisions

An Agent Folder is the home of a persistent personal agent/bot, not a folder-scoped instance of the built-in Assistant.

- Pi owns provider interaction, the agent loop, tool calling, context management, compaction, and native sessions.
- Markwork owns agent identity, chat tabs, session routing, queues, workspace navigation, and process lifecycle integration.
- The bot can write directly to its workspace, maintain memory, use shell/programs, access the internet, research sources, and produce reports without per-action Apply.
- Initial delivery prioritizes a working trusted-local prototype. Sandboxing, scoped capability enforcement, and network isolation are not prerequisites.
- The workspace is the intended working directory, not an enforced filesystem boundary in the initial release.
- markworkd remains a protocol-agnostic supervisor and transport.
- The ordinary Assistant and existing pi card workflow retain their current behavior and approval boundaries.
- Backward compatibility for the old Agent Folder implementation is not a requirement. Do not build legacy readers, automatic migration, schema compatibility, or fallback execution paths for it. This does not authorize deleting existing user files.

An agent is not a session or process. Its identity and memory persist when pi stops. Independent sessions share the workspace and curated memory, not their entire conversation histories.

## 2. Initial trust model — explicit limitations

The first version runs pi and its tools with the permissions of the account that launches them. It is for trusted personal use, not untrusted multi-tenant execution.

- Shell and file tools may access files outside the workspace, including agent configuration, transcripts, and account-readable secrets. Instructions to avoid those files are conventions, not enforced protection.
- Network access may reach public sites, localhost, private networks, and services available to the execution account. No egress filter or SSRF protection is promised initially.
- Internet content can contain prompt injection. Such content must be treated as reference data in instructions, but this does not provide a hard security boundary.
- Workspace or explicitly supplied data may be sent to the configured model provider or network destinations by tools. Do not use sensitive data without understanding this risk.
- Installed pi extensions and programs are executable code with the runtime account's authority. Do not automatically install code merely because an agent folder or web page requests it.
- A working directory, daemon program/root allowlist, or prompt instruction is not a sandbox for child tools.

Before the first run of an agent, require explicit user activation and show a clear notice that file changes, command execution, and network requests can occur without individual approval. Opening a folder or editing instructions alone must not execute the agent.

Do not claim “workspace-only access,” “protected configuration,” or “all external writes require approval” in the initial UI or documentation. These are hardening goals, not implemented guarantees. The user has explicitly chosen to defer strict enforcement so the working flow can be delivered first.

## 3. Scope

### Initial functional delivery

- Explicitly activated Agent Folders with stable agent IDs.
- New Agent Folders can only be created at `<workspace-root>/agents/<agent-name>/`, as direct children of the root's `agents/` directory. No arbitrary parent, deeper nesting, or agent-inside-agent creation is supported. When the opened root is itself an Agent Folder, creation of another agent is unavailable. Opening an existing Agent Folder directly remains supported.
- Existing Explorer, editable documents, shared chat/document tabs, and session list.
- Pi RPC with native sessions and authentication from the execution machine's pi setup.
- Built-in pi file and shell tools where suitable; no custom model loop or mandatory replacement tool suite.
- Network research through available programs and, where useful, a trusted search/fetch/browser integration. Pi does not automatically provide a search engine simply because shell is enabled.
- Direct workspace writes, persistent memory, and reports with source references.
- One active turn per agent, with an explicit queue across sessions.
- Explicit Stop; closing a chat tab does not stop the agent.
- Local execution first, then Linux background execution through markworkd.
- Observable tools, file updates, session restore, and clear interruption handling.

### Deferred

- OS sandboxing, separate runtime identities, strict path grants, network filtering, and credential isolation.
- A guaranteed external-write approval boundary and custom proposal bridge for folder agents.
- External messaging channels, schedules, autonomous triggers, and inter-agent messaging.
- Concurrent turns in one agent workspace and remote Agent Folder execution over SSH.
### Out of scope

- Compatibility with old Agent Folder configuration, storage, transcripts, or custom-worker execution. Use the new format directly; no migration or legacy continuation is required.

## 4. Folder layout and ownership conventions

Proposed portable layout:

```text
research-agent/
├── agent.json          # Identity and declarative configuration
├── instructions.md     # User-managed role instructions
├── workspace/          # Default working directory; direct bot writes
│   ├── memory.md
│   ├── memory/
│   ├── knowledge/
│   ├── research/
│   └── output/
└── chats/              # System-managed readable transcript projections
```

Instructions should tell the bot to work in `workspace/`, maintain relevant memory, and avoid changing configuration or transcripts. These are ownership conventions in the prototype, not protection against shell access.

The configuration schema must be versioned and include a stable agent ID. Configuration does not launch a process on load or choose arbitrary executables/hooks. The application selects pi through trusted program discovery. Adding runtime grants or hooks later requires a separate design.

Native pi sessions, run bindings, event cursors, and ownership records belong in application-managed runtime storage. Decide its location before implementation. Do not intentionally put credentials in agent configuration, prompts, daemon labels, or recorded spawn input.

Use the new folder layout and configuration directly. Existing folders are not automatically migrated or adopted; reject creation collisions rather than overwriting contents. Missing or malformed configuration starts no model request.

### Creation location

All newly created agents live directly inside the ordinary workspace root's `agents/` directory:

```text
workspace-root/
├── agents/
│   ├── research-agent/       # Allowed
│   └── writing-agent/        # Allowed
├── another-agent/            # Not allowed through New Agent
└── projects/
    └── agents/
        └── nested-agent/     # Not allowed through New Agent
```

The core derives the creation parent as `<workspace-root>/agents`; do not trust a parent path supplied by the renderer or infer it from the selected Explorer folder. Create `agents/` lazily when needed. If that path is a file or resolves outside the root through a symlink, report an error rather than replacing it or writing elsewhere. Validate the new agent name and resolved destination, reject collisions and symlink escapes, and do not overwrite existing contents. Explorer entry points must either be unavailable at unrelated locations or clearly create in the root's `agents/` directory, regardless of the selected folder. Enforce the same rule for the File menu and command palette.

## 5. Architecture

```text
Markwork UI and application controllers
  ├─ Agent identity and instructions
  ├─ Session routing and per-agent queue
  ├─ Explorer/editor coordination
  └─ Run, Stop, restore, and runtime status
                   │
           Folder pi adapter
                   │
         Shared pi RPC transport
             /             \
    Local subprocess    markworkd process
             \             /
               pi --mode rpc
                 ├─ Provider/authentication
                 ├─ Agent loop and context
                 ├─ Native sessions
                 └─ File, shell, and research tools
```

Launch with `workspace/` as the working directory. Reuse transport mechanics from the card harness, not its card/worktree lifecycle. Keep card project validation and its existing access assumptions unchanged; folder activation is a separate explicit launch path.

Runtime I/O remains behind the platform port. Application decisions belong in `src/app/`; renderer messages remain plain data. The transport must not become another model or tool loop.

### Expected code changes

| Area | Planned change |
| --- | --- |
| `src/app/agentfolders.ts` | Keep activation, sessions, tabs, and queue; stop constructing an Assistant engine for folder chat. |
| `src/app/agentfolderruntime.ts` | Execute and reconnect to pi rather than the custom worker. |
| Shared pi RPC transport | Framing, response correlation, event reconstruction, deadlines, cancellation, exit, and backpressure. |
| Folder pi adapter | Map agent/session actions and pi events into existing chat views. |
| Chat presentation | Reuse rendering without requiring `ChatController` to own execution. |
| `src/agent/folderworker.ts` and entry point | Retire from Agent Folder execution after replacement coverage passes. |
| Ordinary Assistant and card review | Preserve existing behavior; do not remove their approval checks. |

Avoid building custom file tools, a permission broker, or a proposal protocol just to reproduce pi's standard capabilities in the initial delivery.

## 6. Sessions, memory, and research

- Agent and chat IDs remain stable across title/folder-name changes.
- Each Markwork chat binds to a native pi session, which is the execution source of truth.
- `chats/*.md` are readable projections, not a second executable history. Manual edits must not fabricate trusted runtime receipts.
- Use one owner per session/projection; another window attaches or refuses competing execution rather than starting a second writer.
- Memory in `workspace/` is agent-maintained and shared across sessions. Do not automatically inject every chat or all memory files into every request.
- Capture the instructions revision for each turn. Verify how resumed pi sessions receive updated instructions without duplicate prefixes or lost history.
- New chats use native pi sessions directly. Do not implement import, continuation, or compatibility readers for old Agent Folder transcripts. The ordinary Assistant's existing storage behavior is outside this replacement.
- Research output should record source URLs, access dates, supporting evidence, and uncertainty. Search results alone are not verification.
- Validate one public-internet research flow during manual testing; keep paid models and live network dependencies out of default CI.

Example workflow: search for a topic, fetch sources, store useful material under `workspace/research/`, run an analysis script, write a cited report under `workspace/output/`, and update memory where appropriate. No per-step Apply is required.

## 7. Data safety and observability

Deferring security isolation does not justify silently losing user work.

- Show tool activity, errors, and actual outcomes; refresh Explorer and clean documents after disk changes.
- Preserve dirty editor buffers when files change on disk. Display a conflict rather than silently replacing unsaved text.
- Native shell writes cannot be claimed to honor an editor lock or checked-write protocol. Initially, warn against editing the same files while the bot is working, detect disk conflicts, and provide an explicit resolution path.
- Do not add a custom model worker solely to coordinate writes. Stronger coordination can follow if the integration demonstrates a need.
- Never promise editor Undo for arbitrary disk writes, shell deletion, or commands. Recommend version control/backups and explain the limitation.
- Bound retained UI logs and redact known credential fields. Arbitrary program output may still expose secrets; do not claim complete secret detection.
- Stop must cancel active work through supported pi/process controls and report failures honestly. It does not undo commands that already ran or guarantee termination of intentionally detached programs.

## 8. Local and background lifecycle

### Local

- Discover and launch pi through the platform process abstraction.
- Subscribe before prompting and correlate command responses.
- Distinguish accepted prompts from completion; wait for `agent_settled` rather than treating `agent_end` as terminal.
- Bound startup, acknowledgements, disconnected waits, and shutdown. Respect framing limits and streaming backpressure.
- On application close, explain the local execution limit and stop/checkpoint explicitly when required.

### Background

- Run pi directly under markworkd instead of `markwork-agent`.
- Check the executable, compatible RPC behavior, allowed daemon program/root, and usable pi authentication on the execution machine.
- Do not copy API keys into recorded daemon arguments, environment, stdin, or labels to make background execution work.
- Detach after normal Save/Discard handling and reattach using durable agent/session/run identity and event position.
- Query the original run before starting a replacement after disconnection.
- Missing runs become interrupted with an explicit recovery action. Never automatically resend prompts or rerun potentially completed commands.
- Keep one active turn per agent; switching tabs does not reroute output or release its slot.

markworkd remains protocol-agnostic. Go changes are unnecessary unless a concrete transport limitation is demonstrated.

## 9. Implementation phases

### Phase 0 — Minimal pi integration spike

- Read the applicable installed pi RPC, session, instruction/resource, authentication, and tool documentation before implementation.
- Prove prompt/stream/Stop, native session resume, instruction updates, shell execution, and a simple internet research/report flow.
- Decide runtime storage, supported pi versions, configuration, working directory, and explicit activation notice.
- Confirm which tools/programs are available; show missing dependencies rather than claiming browsing works automatically.

Gate: a manually runnable local agent produces a report in its workspace using pi, with documented unsandboxed limitations.

### Phase 1 — Shared transport and local Agent Folder

- Reuse/extract only pi process and RPC mechanics; preserve card behavior.
- Replace custom folder execution with the pi adapter.
- Deliver session bindings, memory instructions, queues, mixed tabs, streaming, Stop, and transcript projections.
- Show disk changes and dirty-buffer conflicts.

Gate: deterministic tests cover lifecycle and session isolation; a real local smoke test covers shell and research. No sandbox or custom tool broker is required.

### Phase 2 — Background and recovery

- Execute pi through markworkd, verify authentication, and implement detach/reconnect.
- Prevent duplicate session owners and automatic reruns after unknown outcomes.

Gate: a real-daemon test proves continued work across window close and explicit recovery of lost runs.

### Phase 3 — Retire the old folder implementation

- Remove the custom folder worker, obsolete packaging, and old Agent Folder paths after replacement coverage passes.
- Do not retain compatibility adapters, migration tooling, or fallback to the custom engine.
- Do not delete existing user files as part of code retirement. Old Agent Folder data need not be recognized by the new runtime.
- Keep the ordinary Assistant and card harness unchanged in behavior.

Gate: Agent Folders use only the new pi-based execution and storage paths; no legacy folder runtime remains.

### Phase 4 — Security hardening (separate follow-up)

After the core flow is usable, design and implement incrementally:

1. User-controlled grants stored outside bot-writable state.
2. Runtime filesystem/process isolation and credential separation.
3. Public-web egress policy and controlled grants for private services.
4. Controlled extension/resource loading and resource limits.
5. Enforced workspace writes and external proposal/Apply boundaries, if desired.
6. Stronger editor/write coordination and recoverable file operations.

When shell remains enabled, restricted file tools alone cannot enforce these boundaries. Hardening needs enforcement below arbitrary shell/program access. Document each guarantee only after implementation and adversarial verification.

## 10. Verification and performance

Default tests use temporary folders and fake pi processes/providers. Do not execute the user's real pi or require paid APIs in CI.

Core/protocol coverage:

- New-format configuration, explicit activation, stable identities, creation collisions, and folder-switch races.
- Agent creation only at `<workspace-root>/agents/<agent-name>/`: lazy creation of `agents/`; direct-child success within that directory; rejection of root-level, deeper nested, and forged destinations; no child-agent creation when the opened root is itself an agent; collision and symlink handling; consistent File menu, command palette, and Explorer behavior. Opening an existing agent directly still works.
- RPC responses/events, errors, framing, bounded waits, session resume, queues, Stop, and late-event isolation.
- Instructions, memory policy, native history/projection ownership, duplicate events, lost responses, and explicit interrupted recovery.
- Plain-data contracts and validation of renderer session IDs/actions.

Electron/daemon coverage:

- Mixed tabs, session switching during streaming, close-tab versus Stop, disk refresh, dirty-buffer preservation, and native pi chat restore.
- Shell/file tool event rendering and research dependency errors through fakes.
- Detach/reattach, reconnect, competing windows, lost runs, unavailable credentials, and denied daemon roots/programs.
- Ordinary Assistant approvals and card/worktree behavior remain unchanged.
- Real screenshots in light/dark and narrow windows for UI changes; inspect and show them to the user.

Do not assert workspace isolation, network filtering, or enforced external-write approval in initial tests/docs. These guarantees are explicitly deferred.

Measure folder activation, session-list loading, switching among 200 sessions, 1,000 incoming events, replay, transcript projection, and memory impact with equivalent repeated fixtures. Report median, p95, maximum, and regressions. Avoid reparsing all histories or rewriting full transcripts per token.

Run typecheck, core tests, affected Electron tests after rebuilding, and complete `npm test`. Save and inspect logs for application errors/stack traces. If Go changes, run vet, race tests, and the shim suite. Validate installed-package background launch separately.

## 11. Documentation and completion

Update README, the original Agent Folder design, user docs/limitations, relevant tool docs, daemon launch notes, and actual UI screenshots during implementation. Update agent and clean-code learning pages for execution/state ownership changes, and the performance learning page if a measured improvement is delivered.

Initial completion means a persistent folder agent uses pi for execution, can research over the internet, run programs, write reports/memory, restore sessions, and continue through configured markworkd. Markwork does not duplicate the model loop. Dirty editor buffers are preserved, lifecycle failures are visible, and unknown command outcomes are not silently replayed. Compatibility with old Agent Folder data is not a completion gate.

The initial version is explicitly unsandboxed trusted-local execution. Strict security enforcement is a later milestone, not a hidden guarantee or a prerequisite for the first working delivery.
