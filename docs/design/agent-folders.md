# Agent folders: design and implementation plan

Status: implemented; packaged launch and extended recovery validation remain pending. The local controller, shared chat tabs, visible session storage, scoped protocol, and Linux headless-worker adapter are implemented. The [interactive HTML mockup](mockups/agent-folder.html) remains the design reference.

The runnable fixture is [`example/`](../../example/README.md), with an agent folder next to ordinary `notes/` and `projects/` folders. `npm start -- example/research-agent` opens the agent directly.

Validation on 31 October: typecheck/layer/UI checks pass; all 897 core tests and the complete `npm test` suite pass. The nine-step Electron agent-folder scenario and the real-daemon worker scenario pass, including queueing, Apply/Undo, disconnect/replay, and deduplication. Real light/dark/560-pixel screenshots verify the centered 768-pixel chat column. Installed-package launch, multiple-window ownership races, daemon/shim restart, and the remaining extended performance/recovery gates below have not been certified.

The mockup uses the current application shell as shown in `docs/assets/files.png` and `assistant-poster.png`, with menu bar, vertical activity rail, Explorer sections, shared header, document tabs, Visual/Code controls, formatting toolbar, and Geist typography. The session panel is the proposed addition.

Agreed layout: **folder tree on the left, chat in the center, session list on the right**. Preserve Markwork's existing shell, navigation, header, document tabs, Geist typography, zinc theme, primitives, and responsive panel behavior. An agent folder changes the workspace's default tab, not the identity of the application. Chat sessions and editable Markdown files share the existing document tab strip.

## 1. Product behavior

A folder containing a valid `agent.json` opens an Agent page when activated. Opening that folder as the work folder selects its chat by default; activating it inside a parent workspace keeps the existing workspace tree visible. One folder defines one agent, with many independent chat sessions. Its documents supply shared reference material; each conversation retains its own transcript, work plan, proposals, and recovery state.

- Left: the current vertical activity rail and Explorer, with Open Editors, the workspace folder tree, Outline, and Timeline. Reuse `FilesView` and its controller. Selecting a document opens it with the existing editor and tabs; each chat session is a non-document tab alongside ordinary editable Markdown tabs. Selecting the chat tab returns to its conversation without closing or changing a document.
- Center: the existing tab strip contains both chats and files. A chat tab shows its conversation, tool activity, context/token information, work plan, review actions, and composer. A Markdown tab shows the normal editable document, with Visual/Code modes, autosave, Undo/Redo, and the existing save state. Long history scrolls inside the conversation, with the header, tabs, and composer bounded by the pane; test saved history and streaming in narrow and split panes. Reuse the Assistant's chat rendering/approval components and the existing editor; do not replace documents with read-only previews.
- Right: while the focused tab is a chat, show New chat and sessions; on documents and every other layout, show the ordinary Assistant. Each session row shows its title and status. Selecting a session focuses its existing chat tab, or opens one if necessary, without duplicating it. New chat opens a new chat tab. Closing a chat tab only closes its view; it neither deletes the session nor stops its active turn. Stop is an explicit session action. Selecting another session does not transfer output/proposals between tabs.
- Keep Home, Journal, search, Git, and the normal workspace workflow available. Folders without a valid agent configuration keep their existing startup behavior.
- The agent page's context defaults to folder files and explicit attachments, not the last document parked behind a non-document page. Inspecting a file does not silently add it to the next prompt; attachments remain explicit.
- Session history is independent. New chat receives the agent instructions and searchable workspace, but no other session's conversation. Cross-session memory is deferred.

The mockup simulates file previews, sessions, proposal review, runtime status, and closing the window. It includes a small editable document simulation with Visual/Code modes, a dirty indicator, and Save that only updates in-memory preview state. It does not invoke a model, write actual files, launch a daemon, or implement the production CodeMirror editor. Its optional metadata tree preview is not a decision to expose chat history to ordinary workspace discovery.

The mockup also shows ordinary sibling folders (`notes/` and `projects/`) alongside `asisten-riset/`, which alone carries an Agent badge. Their Markdown files open as normal editable tabs. An agent is identified by `agent.json`; ordinary folders have no marker. Its visible `chats/` directory contains session files. The visible workspace root and the active agent root must be distinct when showing this arrangement: agent context, proposals, instructions, and sessions remain scoped to the configured agent folder. Opening a sibling document does not add that folder to agent access. Support for selecting an agent subfolder from a parent workspace requires explicit root-scoped activation; do not infer it from a document tab or scan the entire tree on every turn.

## 2. Configuration and persistence

The exact file `agent.json` at a folder's root is its agent marker and configuration. No `.markwork` directory is required for an agent folder. Role instructions live in an ordinary editable Markdown file referenced by the configuration:

```json
{
    "version": 1,
    "name": "Research Assistant",
    "description": "Read references and prepare research briefs.",
    "instructions": "instructions.md"
}
```

```text
asisten-riset/
├── agent.json
├── instructions.md
├── chats/
│   ├── <conversation>.md
│   └── <conversation>.log.jsonl
├── referensi/
└── hasil/
```

The presence of `agent.json` marks the folder as an agent; malformed JSON or unsupported versions display a configuration error rather than hiding that identity or starting a model request. Require `version`, `name`, and a safe relative `instructions` path; `description` is optional. Validate a bounded JSON schema in the core. `instructions.md` opens in the normal editable Markdown tab with Visual/Code modes. The configuration file follows the application's existing JSON/code page behavior.

Reuse the current Markdown transcript serialization in `src/agent/transcript.ts`. Agent-folder transcripts use frontmatter `layout: chat`, including empty sessions. Add an explicit storage policy to `chatstore.ts`: agent-folder sessions use `<agent-root>/chats`; the ordinary Assistant keeps its existing `<work-folder>/.markwork/chats` behavior and compatibility. Do not globally change the existing default or silently move/delete existing history. Add backward-compatible optional metadata only where needed. Stable session IDs must survive title changes and must not be inferred from display titles. Machine-local run bindings and ownership records remain in application state outside the portable agent definition; no `.markwork` directory is required to run an agent folder.

Configuration and storage rules:

1. Inspect only the explicitly activated folder's exact `agent.json`. Keep the visible workspace root separate from the captured agent root when selecting a child folder. Do not discover agents through an unbounded recursive scan or inherit instructions from an ancestor. Check markers lazily for visible folders to show the Agent badge.
2. Validate config/instruction size, UTF-8 text, JSON shape, supported version, field types, and instruction context budget before sending instructions. Missing marker means ordinary folder; malformed marker means an agent configuration error with file/editor access and retry. An empty instructions file is allowed if the configuration and path are valid.
3. Reject a marker or `chats/` location that escapes the agent root through symlinks. Resolve disk paths through `platform().paths`. Resolve the configured instructions path inside the captured agent root; reject absolute paths, traversal, symlink escapes, and references into `chats/`. The agent definition cannot choose its transcript directory, executable, external roots, or arbitrary output paths.
4. Load role instructions from the configured Markdown file once per revision, without duplicating them as a reference excerpt. Every instruction token counts against the context budget. Changes take effect on the next turn from the current accepted revision; a running turn retains its captured revision. Removing/renaming the marker stops offering new agent turns until configuration returns, but never deletes chats or implicitly cancels detached work.
5. No credentials, shell hooks, arbitrary commands, or approval bypasses are introduced by configuration. Editing instructions does not change application access boundaries. Opening or saving the file alone never starts a model request.
6. Show `chats/` in Explorer as an ordinary visible directory, but exclude its entire subtree from this agent's automatic project map, retrieval, related excerpts, tool file search/read access, and general proposal targets. Exclude both Markdown transcripts and `.log.jsonl` sidecars at the source boundary shared by local and background runtimes. Existing dot-folder exclusions remain in place. A normal non-agent folder named `chats` elsewhere retains ordinary workspace behavior.
7. Manage sessions through explicit session operations. A transcript carrying `layout: chat` in a configured agent’s `chats/` directory opens the matching chat session from the tree. It focuses an existing session tab without duplication and starts no model turn until Send. Ordinary Markdown files remain editable documents. An unsaved transcript already open in the editor stays there until saved and reopened. Restoring a plain transcript file path also selects its chat page. Manual transcript edits never approve pending changes or become executable journal events; validate loaded history and reconcile against trusted operation receipts and actual files. Coordinate editor saves with the runtime's single history writer, detect conflicts, and do not overwrite an unsaved transcript buffer. Provide a clear conflict/reload path for a transcript being updated by an active session.
8. Reserve `<agent-root>/chats` for sessions only after validating existing contents. Do not adopt an unrelated existing file/directory as storage or overwrite unknown notes; report a collision and offer inspection. Create the directory lazily on the first saved session. Use unique IDs and atomic/checked writes through the existing file helpers.
9. Preserve private conversation defaults despite visible storage: new `chats/` directories get a narrowly scoped `chats/.gitignore` containing `*`, without editing the repository index or other ignore rules. Do not overwrite an existing ignore file. Keep `agent.json` easy to share and explain how users can intentionally track chats if desired. Existing ordinary Assistant privacy behavior remains unchanged.
10. Test a readable but non-writable root, a marker deleted during a turn, a normal `chats` folder outside an agent, a symlinked storage directory, and concurrent transcript editing. No migration is needed from the proposed `agent.md` design because it has not shipped; compatibility work must preserve real existing Assistant transcripts.

## 3. Existing foundation and gaps

| Area | Current code | Planned use or gap |
| --- | --- | --- |
| Folder opening | `src/app/session.ts`, `src/app/files.ts` | Detect configuration during explicit folder activation; distinguish visible workspace root from agent root, and guard asynchronous results with the root/generation. |
| Non-document pages | `src/app/document.ts`, `documents.ts`, `views.ts` | Add session-specific chat pages through the existing Page model and tab lifecycle; keep ordinary Markdown as editable Doc instances. |
| Assistant | `src/app/assistant.ts`, `src/agent/chatcontroller.ts`, `session.ts` | Reuse provider/tools/context/approval logic; current controller owns one conversation and resets/stops on open/reset. |
| History | `src/agent/chatstore.ts`, `transcript.ts` | Reuse Markdown serialization/logs with a root-scoped storage policy: agent sessions in `chats/`, legacy Assistant sessions unchanged. Add stable identity/activity/status without parsing full logs on every render. |
| Context | `src/agent/context.ts`, `chatcontroller.ts` | Introduce explicit agent instructions and folder-oriented context while preserving normal Assistant defaults and token accounting. |
| Review/write | `src/app/agentwrites.ts`, `src/agent/changes.ts`, `batch.ts` | Keep user Apply, fresh snapshots, partial review, Undo, and journal reconciliation. |
| Window shell | `electron/renderer/App.tsx`, `components/FilesView.tsx`, `Chat.tsx`, `lib/client.ts` | Reuse left panel and chat content; right panel becomes sessions on the Agent page. Avoid a second Assistant for the same session. |
| App messages | `src/app/protocol/chat.ts`, `messages.ts`, `frontend.ts`, `handlers/` | Add session-scoped notices/requests and plain-data state. |
| Daemon | `src/orchestrator/hub.ts`, `daemon.ts`, `src/agent/daemon/` | Reuse connection, spawn, subscription, replay, and detach. A daemon connection alone cannot keep built-in chat alive. |
| Headless runtime | New worker entry point and adapter | Built-in chat currently runs in the app's core process; it needs an independently launched worker to survive app exit. |

`markworkd` currently runs on Linux only. The local mode remains available on Linux, macOS, and Windows. Initial background support is local Linux; remote agent-folder execution requires a separate path, credential, and review design and is deferred.

## 4. Application ownership and session lifecycle

Represent each chat tab as a session-scoped Page (proposed kind `agent` with a validated session ID) and each Markdown file as its existing Doc. Extend tab restoration to reopen saved chat IDs only within their owning folder. Reuse the pane/tab IDs and selection/close actions; do not create a second renderer-owned tab registry in the implementation. Chat pages have no TextEditor or file save state. A session may continue while its tab is closed; selecting it from the right panel reopens its view. Switching to a document preserves unsaved text, selection, undo history, and its existing save behavior.

Introduce an application controller (proposed `src/app/agentfolder.ts`) for validated configuration, Agent page state, session selection, and runtime capability. Its host contracts and views contain plain data. `AppSession` constructs it, and app protocol handlers validate every session ID against the current folder and the sessions offered by the core.

Introduce a session service with a runtime interface (proposed `src/agent/folderruntime.ts`). It owns conversations independently of the selected view. Local and daemon-backed adapters expose the same operations: list/select snapshot, send, stop, review decision, subscribe, detach, and dispose. Extract reusable turn logic only where necessary; keep application decisions in `app/` and runtime I/O behind `platform()`.

- Carry workspace ID, session ID, turn ID, and event sequence on asynchronous events. Ignore late events from another folder generation. Reopening a session is not `ChatController.reset()` on the running conversation.
- Start with one active model turn per folder. Additional requests queue explicitly; switching sessions is allowed. A turn awaiting approval holds that slot, so interdependent file mutations remain ordered. Stop removes a queued request or cancels the active one without running it again.
- Separate conversation status from connection status. Conversation: idle, queued, running, waiting for approval, completed, stopped, failed, interrupted. Connection: checking, local, connected, reconnecting, unavailable, incompatible.
- Show active work, pending approvals, and failures even when their session is not selected. Keep transient connection loss from being mislabeled as a failed model turn.
- Retain legacy Assistant behavior in ordinary workspaces. Agent folders require durable session saving; fail visibly if unavailable and explain that the ordinary Assistant's optional history switch does not disable agent-folder recovery.
- Derive durable session state from persisted checkpoints/events; list summaries can be a rebuildable cache. Bound history listings and load conversation/log content lazily.

## 5. Background runtime through markworkd

Availability means a successful compatible connection **and** an executable worker, allowed program/root, usable credentials, and supported worker protocol. An installed binary or live socket alone does not justify “Background available”. Detection is bounded; normal folder opening never waits indefinitely for it.

### Worker and transport

Add a packaged, headless worker for the existing assistant engine, launched as a trusted program by `markworkd`. Use the same worker protocol in a locally supervised process where practical. The exact entry point and packaging are an implementation spike: verify a stable executable on installed Linux builds, updates, sandboxed packages, and developer builds. Do not assume a system Node installation or pass arbitrary executable paths from folder config.

- Keep Go protocol-agnostic. Markwork's adapter interprets worker JSONL; markworkd continues moving records and enforcing program/root/env policies.
- The app authorizes the chosen folder; the daemon's configured roots/program allowlist must also permit it. Do not route through the pi harness or weaken `checkProjectFolder()`, which deliberately excludes the work folder because that harness writes freely.
- Define a versioned worker handshake, session-scoped commands/events, request IDs, bounded frames, request timeouts, and explicit terminal states. Bound the worker event envelope below the daemon frame limit.
- Commands: start/send, cancel, subscribe snapshot, review decision/result, shutdown. Persist deduplication receipts for commands with side effects; transport replay does not itself make stdin commands idempotent.
- Launch daemon-backed work before a turn begins. Closing the window detaches from the existing run; it does not cancel/restart a model request or transfer an in-flight call between processes.
- Reattach by durable workspace/session/run identity and replay position. Deduplicate events, reconcile the checkpoint, and never apply a proposal while replaying it. Missing/lost runs become interrupted with an explicit resume action, not automatic resubmission.
- Use one owner of transcript/checkpoint writes per folder runtime. Multiple windows attach to the owner; they must not each start workers, overwrite history, or race approval decisions. Prototype a lock/lease and durable command receipts, including stale-owner recovery.
- If the connection drops during a run, keep its identity and reconnect. Do not start a local replacement that could duplicate requests or proposals. Local fallback is available for new work only after confirming no competing owner.

### Credentials and document buffers

Use worker-side access to the existing credential source where supported. Verify Linux secret-service/keyring access in an actual daemon session. Never place an API key in `agent.json`, spawn labels, daemon `env`, `initial_input`, stdout, or recorded stdin; markworkd persists those records. If the key is available only through Electron's main-process vault, background mode is unavailable until a deliberate non-logged credential handoff is designed and tested. Do not silently copy a credential into a new plaintext store.

Worker reads disk snapshots. A live window may supply explicitly identified unsaved buffer content when building a turn, but the worker must not assume buffers survive window exit. Closing with unsaved documents follows the existing Save/Discard/Cancel flow; review preflight always checks current disk and open-buffer snapshots. Display whether a turn uses saved files or supplied buffer snapshots.

### Review while the window is closed

The worker may read, reason, and produce a **pure proposal** while detached. Persist the pending proposal before exposing it, then wait. No window means no automatic approval and no application of proposal content.

When a window returns, it retrieves the pending proposal with its original ID and snapshots. The application applies selected changes through existing `agentwrites` preflight and journals its actual result. The worker continues only from that recorded result. Resolve one proposal once across clients, reconcile a lost acknowledgement against actual files/journal, and refuse stale edits. Pending approvals can outlive the worker's idle TTL; restore as pending/interrupted work without issuing another write.

### Closing behavior

| Runtime | On window close | On return |
| --- | --- | --- |
| Local, active work | Offer Stop and close / Keep open; checkpoint before stopping. | Show stopped/interrupted work and explicit Continue. |
| Daemon-backed, active work | Detach after the normal document-save flow; show that work continues. | Reattach/replay without a new model call. |
| Daemon-backed, pending approval | Keep proposal pending; never infer approval from closing. | Restore the same review. |
| Connection lost | Explain that background state is unknown; do not claim work stopped or restart it. | Query/reconcile original run before any resume. |

Do not interrupt every idle close with a confirmation. Schedules, inbound messages, external integrations, automatic triggers, concurrent turns, and remote machines are outside the initial scope. “Background” means continuing work already started while the computer remains running; it does not imply completing work while powered off.

## 6. Implementation sequence

Each phase has its own acceptance gate; the full feature is complete only after background support and recovery pass.

1. **Configuration and Agent page.** Add JSON schema parsing, exact `agent.json` detection, safe referenced instruction loading, and reserved `chats/` storage exclusion; wire root-scoped discovery, invalid-config fallback, session-specific chat tabs alongside normal editable document tabs, and normal editor navigation. Tests cover missing/malformed/unsupported config, traversal/symlinks, root switch races, and parked-document context. No model request occurs on open.
2. **Three-column local experience.** Reuse Files/sidebar and HeaderBar; mount shared chat content centrally and a new session list on the right. Implement session identity, lifecycle, lazy history, empty/error states, queue, and keyboard actions. Verify session switching during streaming/proposal review without cancelling or misrouting events. Open/edit/save a Markdown file from the tree, switch to a chat and back with an unsaved draft, close/reopen a chat via the session list, and restore the mixed tab strip after restart. Disable conflicting duplicate Assistant surfaces on the Agent page.
3. **Instructions and approval integration.** Include validated role instructions in the stable context prefix with a counted budget; preserve application access rules, token/context inspection, review, partial Apply, Undo, verification, and recovery. Configuration edits take effect on the next turn. Ordinary Assistant tests remain unchanged in behavior.
4. **Worker and packaging spike.** Prove headless provider/tools execution, installed-worker launch, daemon allowlists, key access, folder ownership, protocol handshake, and local supervisor shutdown. Deliver deterministic fake-provider end-to-end coverage and a working installed Linux package before claiming background availability.
5. **Daemon execution and durable review.** Start the worker under markworkd; implement detach/reattach, event replay, durable IDs/receipts, pending approvals, file conflict handling, and multiple-window ownership. Test app exit, daemon/shim restart, lost run, idle expiry, disconnected approval, and lost Apply acknowledgement without duplicate writes.
6. **Documentation and final validation.** Update feature/architecture docs and learning pages, capture real application screenshots, measure performance, and run the complete required suites. Keep the mockup labeled as a proposal until implemented.

## 7. Verification and performance gates

Use fake providers and temporary folders; never require a paid API for default tests.

- Core: JSON parser/path constraints, agent-local `chats/` exclusions across search/context/tools, legacy Assistant storage compatibility, transcript edit conflicts, identity, queue/cancellation, config revisions, session history compatibility, folder generations, context budgets, approval results, stale files, partial approval/Undo, ownership, replay, and idempotent command handling.
- App protocol: plain-data contracts; invalid, cross-folder, or expired session/proposal IDs rejected by the core; a forged renderer success cannot mark a proposal applied.
- Electron: valid/invalid agent folder, three columns, mixed chat/Markdown tabs, normal editable Visual/Markdown documents, dirty-buffer preservation across chat selection, save and Undo/Redo, duplicate session-tab prevention, closing a chat without cancelling work, restoring mixed tabs, new and reopened sessions, session switching during streaming, background status/close flow, keyboard access, context details, failed saving, and ordinary workspace regression.
- Daemon: fake worker starts through actual markworkd, window detaches, worker progresses, reopening recovers; a closed window never approves a proposal. Cover configured-root/program refusal, unavailable credentials, incompatible worker, reconnect, shims, stale ownership, and terminal lost runs.
- Browser visual checks: real screenshots in light/dark at wide, below 900 px, and below 600 px; inspect and show screenshots. Right sessions floats below 900 px, left tree below 600 px; controls remain available and content does not overflow.
- Performance: measure opening an ordinary folder versus an agent folder, first history list, switching among 200 sessions, 1,000 incoming event records, replay, checkpoint writes, and steady-state memory. Report median/p95/maximum with fixtures and repeated equivalent runs. Keep one owner/watch set; avoid rescanning/parsing all transcripts for every token.
- Run `npm run typecheck`, `npm run test:core:node`, the affected Electron files after `npm run electron:build`, and `npm test` before declaring implementation finished. Save/read full logs; investigate app errors/stack traces, not only failing assertions. Use `npm run bench:agentic` for the agent pipeline, plus the new folder/session measurements. Run markdown benchmarks only if its code changes.
- If Go changes, run `go vet ./...`, `go test -race ./...`, and the shim supervisor suite from `markworkd/`. Reusing the daemon should normally need no Go change.

## 8. Documentation to ship with implementation

- `README.md`: agent-folder feature, folder layout, Agent page, instructions, sessions, runtime, and recovery.
- Relevant pages in `docs/docs/`, `limitations.html`, and navigation if a new page is needed; add an agent feature card to `docs/index.html`. Update tool documentation only if actual tool behavior changes.
- `docs/learn-agent.html`: before/after context, session ownership, approval boundaries, daemon recovery, verified limits, updated journey data and KPIs, and a labeled simulation where useful.
- `docs/learn-clean-code.html`: new controller/host interfaces and extracted ownership with fresh measurements and current code excerpts. Do not expand layer exceptions.
- `docs/learn-performance.html` if the implementation includes a measured performance improvement.
- `docs/design/markworkd.md` and packaging notes for the trusted worker and required daemon policy; keep daemon transport independent of chat semantics.
- Capture actual feature scenes with `npm run docs` when ready, and browser-check changed documentation at 375 px for console errors and overflow.

## 9. Completion criteria

A configured folder opens the existing Markwork shell with Files left, a shared document/chat tab strip in the center, and sessions right. Markdown files open as normal editable documents; chat tabs never replace them with a preview. Switching between chat and documents preserves unsaved edits, cursor, undo history, and active conversations. File editing and ordinary workspaces still work. Sessions stay isolated, persist, and can be switched without losing active work. Without markworkd the feature runs locally and explains its close limit. With a compatible configured daemon and worker, started work survives app exit and is recovered without repeating the request. Changes remain proposals until Apply; closing, reconnecting, or replaying never grants approval.

The implementation changes runtime behavior. The acceptance gates above remain the completion checklist; outstanding validation is recorded at the top of this document.
