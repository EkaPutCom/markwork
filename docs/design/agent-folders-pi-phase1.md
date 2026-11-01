# Phase 1: local pi Agent Folders

Implemented on 1 November 2026; final full-suite verification is recorded below. This is the local milestone of [the plan](agent-folders-pi-plan.md), following [the Phase 0 contract experiment](agent-folders-pi-phase0.md). Background pi and legacy code removal remain separate phases.

## Runtime and ownership

- `src/agent/pirpc.ts` provides platform-backed pi RPC: correlated command IDs, event subscriptions before prompt submission, acknowledgement/turn deadlines, acceptance versus `agent_settled`, bounded records, input-backpressure failure, exit propagation and bounded shutdown. Card commands and event decoding reuse the codec; the existing card lifecycle, extension UI, worktrees and review are unchanged. Local process framing/backpressure stay in `platform/node/process.ts`; no standalone spike transport is imported by production.
- `src/app/folderpi.ts` uses exactly pi 1.4.0. Pi owns providers/auth, tools, context, compaction and native history. Folder chat never constructs the Assistant engine or falls back to its worker. Known credential field names are redacted before UI-log retention; arbitrary output is not secret-safe.
- Every turn starts a local RPC process in `workspace/`, resumes the exact bound native session (or creates the chat's stable UUID), snapshots saved instructions with SHA-256, and uses `--append-system-prompt`. The process closes after settlement. Snapshot changes replace the active prefix at the next idle boundary, not user-prompt history. The binding records the latest instruction revision; append-only `turns.jsonl` provenance binds every attempted turn to its chat UUID, exact native file, saved instruction revision and timestamp. It contains no prompts/credentials and is never executable replay input. Immutable snapshots remain inspectable.
- Extensions, MCP, skills, templates, themes and context-file discovery are disabled. Standard `read,bash,edit,write` tools remain. There is no custom tool broker or per-tool Apply.
- `src/agent/folderstore.ts` owns the durable index, exact native paths, projection hashes and exclusive owner directory under `<dataDir>/markwork/folder-agents/<agent-id>/`. Only indexed new-format projections route as chats. Edited/unknown Markdown never becomes executable history. Explicit Restore reads native messages and regenerates the projection without resending tools/prompts.
- `AgentFoldersController` owns activation and the per-agent turn queue. Independent chats share workspace memory, not conversations. Switching/closing a tab does not stop work; Stop is explicit. Orderly app close waits for bounded local shutdown and releases ownership. Another window refuses a competing writer. A crash can leave a stale owner or process: inspect it before manual owner removal and explicit native restore; unknown outcomes are never retried automatically.
- `FolderDisk` coordinates external disk changes with normal documents/autosave. Clean buffers reload; dirty drafts survive, saving pauses, and confirmed reload/keep actions resolve the conflict. Native tools do not honor an editor lock.

## Format and creation

Version 2 requires `id` (UUID), `runtime: "pi"`, `name`, and `instructions`; optional `description` is supported. `workspace/` must exist. No version-1 compatibility, migration, transcript adoption or fallback is implemented. User files are not deleted.

New Agent always derives `<ordinary-workspace-root>/agents/<name>/` in the core. It rejects invalid names, forged/deeper parents in the creation helper, existing destinations, symlink escapes, non-directory `agents/`, and nesting. Exclusive staged allocation avoids adopting a colliding directory. Explorer explicitly says it creates in workspace `agents/`; File/palette and core reject creation when the opened root itself has an agent marker.

## Safety boundary

Activation is explicit and temporary to the open workspace. Opening/editing alone never executes pi. Pi uses the execution account's permissions and its own authentication. Workspace paths, memory instructions and resource flags are conventions, **not a sandbox**. Tools can read/write outside it, reach secrets/private networks and send data to providers or arbitrary destinations. No guaranteed editor Undo, rollback of completed commands, complete secret detection or termination of detached programs is promised. Ordinary Assistant approvals and card/worktree review retain their existing behavior.

## Verification

Deterministic tests cover new-format validation/creation races, activation, native session isolation/resume, revisioned instructions, queues/Stop, prompt acceptance versus settlement, out-of-order responses, process exits, missing responses/no replay, malformed/oversized records, backpressure, recovery, competing ownership, disk conflicts and protocol routing. Electron coverage includes File/palette/Explorer creation, mixed tabs, close-tab versus Stop, streaming queues, direct tool writes, draft preservation, explicit native restore, long histories and split panes. Default tests never launch the user's pi or require network/paid credentials.

Manual live command (requires a built application and a display, real pi authentication, curl and Python):

```sh
xvfb-run -a node tests/live/folderpi.mjs --activate
```

Successful real in-app evidence: `/tmp/markwork-folderpi-live-lXMbsF/result.json`. Pi used bash/curl to fetch `https://example.com` and `https://www.iana.org/help/example-domains`, analyzed titles and byte counts using Python, wrote a 979-byte sourced report and shared `memory.md`, resumed the exact native session with a revised instruction prefix, and stopped a requested `sleep 60` before the subsequent file write. Research turn: 71,757 ms; UI Stop to settled: 123.36 ms; 37,189 cumulative assistant-reported tokens across the smoke's turns. No renderer errors. This proves source retrieval, not a general search engine. Two earlier manual harness attempts failed because its textbox locator/revision assertion were wrong; those harness defects were fixed, not counted as successful runs.

Initial milestone validation: `npm run typecheck` and `npm test` pass (908 core tests, all Electron files, 16 spike tests, plus Git/site checks). Full-suite exit code is 0 in `/tmp/phase1-npm-test-final.exit`; `/tmp/phase1-npm-test-final.log` was scanned and has no application errors, warnings, unhandled failures or stack traces (the two Error-name matches are passing test names). Focused Agent Folder/New Agent/layout checks were also repeated successfully. Screenshots were read/inspected in light/dark and narrow windows, including activation, conflict controls and New Agent. Documentation images were recaptured with `MARKWORK_SCENES=agentfolders xvfb-run -a npm run docs`. The updated documentation/learning pages were opened through a local HTTP server at 375 px; controls/simulations were exercised with no JavaScript errors or horizontal overflow.

## Performance baseline (not a speedup claim)

Node v24.21.0, Linux, local temporary disk, 3 warmups + 20 repetitions. Reproducible in the `folder pi measurement` test (`npm run test:core:node`; then `node dist-node/run-core-node.js --only-agent-folders`):

| Operation | Median ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: |
| Load/validate 200 session bindings | 0.904 | 1.171 | 1.428 |
| List 200 bindings | 0.024 | 0.041 | 0.060 |
| Open/verify an ~18 KB readable history | 0.692 | 1.086 | 1.805 |
| Checked projection + atomic index write, 200 bindings | 6.975 | 7.751 | 8.232 |
| Append per-turn instruction/native provenance | 0.102 | 0.182 | 0.251 |
| Decode and dispatch 1,000 RPC events | 1.728 | 2.242 | 2.734 |

Real Electron, 50 initial history turns plus a streamed continuation, 3 warmups + 20 tab switches: median 150.465 ms, p95 167.948 ms, max 172.972 ms; renderer heap snapshot 16,809,164 bytes (~16.0 MiB). Measured via Playwright wall time and Chromium CDP in `tests/electron/agentchat-layout.mjs`. Another concurrent-suite sample was slower; these are local baselines, not before/after regressions or CI timing thresholds. Logs retain at most 2,000 trace events and 1,024 coalesced pending UI events; projection string length is capped at 2 × 1024² UTF-16 units. Native pi history/compaction remains pi-owned.

Not measured: large native-session replay, long-duration heap growth, 1,000-session stress, real daemon recovery, packaged-app launch, macOS/Windows live pi, OS sandboxing, egress filtering, guaranteed write coordination or cancellation of intentionally detached descendants. Pi startup, provider latency and network cost dominate real turns; no equivalent old-engine comparison is claimed. See `tests/bench/AGENTIC.md` for the Assistant benchmark history and live cost limitations.

## Research presentation follow-up

Chat now renders GFM tables through the shared table parser and safe inline runs, preserving header/body structure, column alignment, escaped pipes and inline formatting. Numbered and task markers are preserved. Matching fence characters/lengths keep literal table markup in code, including unfinished streaming code. Raw HTML remains escaped and images do not load automatically.

On tool completion, FilesController refreshes loaded agent subfolders rather than only the top-level work folder. A bounded metadata inventory of `workspace/` identifies new and changed reports and expands their parents (including nested shell outputs), without opening a document or changing tree/tab selection. It reads no file contents and skips symbolic links, hidden folders and node_modules. Discovery stops beyond 1,000 entries or eight nested directory levels; incomplete inventories never infer new outputs, while normal loaded-folder refresh continues. This is navigation feedback, not a filesystem/tool access boundary.

Regression coverage includes safe/aligned tables, partial streams, numbered/tasks/rules and long fences; unavailable filesystem watches, nested and overwritten reports, unchanged/over-budget inventories, skipped links and preserved selection. The fake pi Electron scenario renders a research table and writes `output/research/cve-report.md` through a shell-shaped event that names no trusted output path. The output appears without manually expanding its parents. Light/dark/narrow screenshots and the documentation capture were inspected. No live pi or paid credentials were needed for this fix.

New-workload median/p95/max: 200-row chat HTML **2.711/3.240/3.316 ms**; metadata discovery/loaded-folder refresh with 200 initial files and accumulating nested reports **18.369/26.454/29.362 ms**, 3 warmups + 20 samples. The normal mixed 100-block/10-repetition Markdown comparison was repeated three times; positive deltas, including +14% for table render and +29% (~0.02 ms) for board parsing in the last repeat, are retained in `tests/bench/AGENTIC.md`. The baseline was not replaced and no speedup is claimed. Large browser table layout, maximum-budget and non-Linux timings remain unmeasured.

Follow-up validation: `npm run typecheck` and the final `npm test` pass: **915 core tests**, all Electron suites (including **12 Agent Folder steps**) and **16 spike tests**, plus Git/site checks. `/tmp/chat-output-final-npm-test.exit` is `0`. The saved full log `/tmp/chat-output-final-npm-test.log` was scanned and read: only two passing Error-named test titles matched; there are no application errors, warnings, unhandled failures or stack traces. The Agent Folder scenario was also repeated with light/dark/560 px screenshots in `/tmp/markwork-chat-output-shots/`. Updated documentation and learning pages were served locally and exercised at 375 px without JavaScript errors or horizontal overflow. The four Agent Folder documentation images were regenerated through `npm run docs`.
