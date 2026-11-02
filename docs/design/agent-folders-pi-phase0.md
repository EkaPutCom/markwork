# Agent Folder pi spike — Phase 0

Status: the local execution gate passed on 1 November 2026. This is a developer experiment, not the Agent Folder runtime shipped by Markwork. Phase 1 has not started. The ordinary Assistant, existing folder worker, card harness, and approval behavior are unchanged.

Parent plan: [persistent folder agents powered by pi](agent-folders-pi-plan.md).

## Run it explicitly

Requirements: Node.js, **pi 1.4.0** on trusted PATH, pi authentication for the selected provider/model, a shell, `curl`, and `python3`. No package or extension is installed by the spike. Missing requirements fail visibly. Authenticate using pi itself; do not put a credential in these commands. The model and tools run with the execution account's permissions and may consume paid quota.

```sh
npm run test:pi-folder-spike
npm run spike:pi-folder -- --activate --live --provider openai --model YOUR_MODEL_ID
# Optional: --out /absolute/path/to/a-new-directory
```

Without both activation flags and an explicit provider/model, the script exits before launching pi or creating files. It prints the unsandboxed execution notice. The output directory must not exist; it defaults to a fresh temporary directory. Keep it for inspection or remove it yourself when finished. Do not open the generated fixture in the old application expecting native pi chat support.

The explicit activation notice is: **Trusted-local only: pi may change files, execute commands, and access the network without Apply. The working directory is NOT a sandbox. Uses the execution account's pi authentication and model quota.** Phase 1 must present equivalent wording and require a real user activation; simply opening a folder must not run pi.

## Decisions for Phase 1

| Subject | Decision |
| --- | --- |
| Execution | `pi --mode rpc`; no custom provider loop or replacement file tools. |
| Supported version | Exactly pi 1.4.0 for this experiment. Other versions fail closed until their RPC contract is reviewed and tested. Do not infer support for every pi release. |
| Program | Discover trusted `pi` through the platform program abstraction in the application. The experiment uses PATH. No executable, hooks, or CLI arguments come from `agent.json`. |
| New configuration | Version **2**, stable UUID `id`, `name`, `runtime: "pi"`, and `instructions: "instructions.md"`. No legacy reader, adoption, fallback, or migration. This spike writes the fixture, not a production schema validator. |
| Creation | New agents are direct children of `<workspace-root>/agents/`. The spike constructs a fresh isolated fixture; real creation validation and symlink handling remain Phase 1 work. |
| Working directory | `<agent-root>/workspace/`. Intended ownership convention, not an access restriction. |
| Portable files | `agent.json`, `instructions.md`, `workspace/`, `chats/`. The spike leaves `chats/` empty; projection writing belongs to Phase 1. |
| Durable runtime | Application data storage, **not temporary runtime/cache storage**: `<Markwork-data>/folder-agents/<agent-id>/`, with `sessions/`, instruction snapshots by SHA-256, and later validated chat/session bindings, run records, event cursors, and ownership records. Resolve the data root using the platform port. The experiment substitutes `<out>/runtime/<agent-id>/` outside the portable agent. |
| Authentication | Pi resolves its existing execution-machine authentication/configuration. Do not copy credentials into folder files, arguments, labels, transcripts, or daemon recorded input. Account permissions still allow shell access to secrets. |
| Resources | Disable extensions, MCP, skills, templates, themes, discovered context files, and trust-gated project resources for the controlled experiment. Explicit built-ins: `read,bash,edit,write`. No automatic installation from agent content. These flags are not a sandbox; account-level configuration remains trusted. |
| Instructions | Snapshot the accepted revision by SHA-256. Append that file at process startup. At an idle turn boundary, shut down and resume the exact native session with the new snapshot. No instruction prefix is inserted into each user message. |
| Native history | Persist through `--session-dir`; bind to the exact `get_state.sessionFile`, never implicitly resume the latest folder session. Native history is authoritative; Markdown projections are not executable histories. |
| Stop | Subscribe before sending, clear queued messages, then `abort`; wait for idle/`agent_settled`. Stop cannot undo earlier effects or promise termination of deliberately detached processes. |
| Completion | Prompt acknowledgement is acceptance, not completion; `agent_end` is not terminal. Use `agent_settled` and inspect authoritative assistant errors. |
| Deadlines | Startup/commands 30 s, turns 180 s, shutdown EOF → TERM after 3 s → KILL after 5 s. Unknown outcomes are errors, never automatically resent. |
| Research | Source retrieval using installed programs is proven. A search engine/browser is **not** bundled just because shell exists. |

The script uses Node directly because it is isolated development tooling. Do not import it into `src/` or treat it as the shared production transport. Phase 1 transport I/O must remain behind `platform()` and preserve card behavior.

## What the executable spike checks

1. Start with revision one; prompt and receive actual text deltas.
2. Remember a random token only in conversation, save the native session, and shut down pi normally.
3. Change instructions, restart with that exact session, and verify identical session identity and restored user history.
4. Ask the model for the token and current revision. Reconstruct persisted system sections to verify the active prefix contains revision two exactly once and no old revision.
5. Execute a direct RPC shell command and check its real exit code/output; check the research dependencies.
6. Ask the model to fetch `https://example.com` and `https://www.iana.org/help/example-domains` with bounded curl requests, save sources, analyze using Python, write a cited report with access date/uncertainty, and update memory.
7. During a model-invoked `sleep 60`, verify the actual tool command, issue Stop, require an aborted settled event and idle state in less than ten seconds.
8. Save aggregate event counts, instruction hashes, native session identity, timings, reported tokens/cost, and limitations to `result.json`. Native sessions retain detailed evidence; stdout does not dump model content, shell output, credentials, or arbitrary stderr.

The report is manually reviewed against the saved source text. The automated checks establish output existence, source URLs, date syntax, uncertainty, memory, and streaming; they are not a general citation/factuality verifier.

## Observed live result

Linux, installed pi 1.4.0, `openai/gpt-6.1-sol`, low thinking. Evidence from the first run is outside the repository at `/tmp/markwork-phase0-live/`; its report is `agents/research-agent/workspace/output/report.md`. Temporary evidence is not durable release certification.

- Native process restart preserved the session and random token. The new system revision replaced the previous active prefix without duplication.
- Both public pages were retrieved successfully and saved; Python extracted visible text. The report distinguishes documentation-use reservation from a reliable testing/production service, quotes both sources, records the UTC access date, and states that linked RFCs were not reviewed.
- `memory.md` records a useful finding. There was no Apply step.
- 169 text deltas, 1,216 message updates, five model tool executions, four settled runs.
- Two tool errors are accounted for: the model initially listed a not-yet-created `memory.md` (exit 2), then created it successfully; the final shell cancellation is intentional. No Markwork exception or transport failure was observed. A recovered tool error is not concealed as an entirely error-free model trace.
- Two startup samples: 346.121 and 345.575 ms; first turn 4,573.405 ms; resumed revision check 6,012.372 ms; research 55,559.651 ms; Stop 8.114 ms. These are individual live observations, **not** percentile estimates or speedup claims.
- Pi-reported total: 21,105 tokens, estimated $0.0297924. Provider billing may differ.

A second independent live run at `/tmp/markwork-phase0-repeat/` also passed, including checking the exact `sleep 60` tool command and bounded Stop. It streamed 185 text deltas; research took 56,335.894 ms and Stop 6.231 ms. Pi reported 21,367 tokens and estimated $0.024142. Its only tool error was the intentional cancellation. The two live runs cost an estimated $0.0539344 combined. The generated fixture version was subsequently set to 2 to distinguish it from the current application's old folder format; configuration parsing remains Phase 1 work.

## Deterministic verification and performance

`npm run test:pi-folder-spike` passes 16 tests using fake subprocesses only, without credentials or network. Coverage includes the manual activation guard, response correlation, LF/CRLF framing with Unicode separators and split UTF-8, completion before acknowledgement, nonterminal `agent_end`, provider failure after acceptance, handled prompts, clear-queue-before-abort ordering, rejection, deadlines without retries, malformed/oversized frames, child exit, startup failure, and listener cleanup.

Twenty repeated batches of 1,000 synthetic streaming records after three warmups measured JSONL parse/delivery (including pipe scheduling): **median 2.798 ms, p95 3.425 ms, maximum 4.180 ms** in the final full test run. Earlier samples were 2.702/4.727/4.805 ms and 5.200/5.840/5.961 ms (the latter alongside the application suite); scheduling noise and the absence of a controlled old/new baseline prevent a regression or improvement claim. This is a transport smoke measurement, not a comparison with the old engine or an application performance improvement. No application code changed; editor/Markdown benchmarks were not run because there is no application runtime impact. Session-list loading, 200-session switching, replay, projection writes, steady-state memory, and daemon overhead are not measured in Phase 0.

## Final validation

- `npm run typecheck`: passed, including layer, complexity, and UI rules.
- `npm test`: exit 0, 904 core tests, all Electron files, and 16 deterministic spike tests passed. The real-daemon test of the existing worker also passed; it does not certify the future pi daemon adapter.
- Saved logs were searched for errors, warnings, unhandled/uncaught failures, and application stack traces. Matches were only passing test names (`httpErrorMessage`, `DaemonError`), not diagnostics.
- `docs/learn-agent.html` was served locally and exercised in Chrome at 375 px: 19 input controls plus the loop/batch/Apply/Undo/queue buttons, no JavaScript/console error, document width 375 px. The server's absent favicon was answered with 204 in the browser check; it is not an application error.
- `git diff --check` and Node syntax checks passed. No UI/application code was changed, so no app appearance screenshot or Markdown/editor benchmark is required.
- Logs are outside the repository in `/tmp/markwork-phase0-logs/`. No release was created.

## Not yet verified or implemented

- Application activation UI, root/name/config validation, queues across sessions, chat projections, Explorer refresh, dirty-buffer conflict resolution, and competing-window/session ownership.
- macOS/Windows, installed-package program discovery, any other pi version, and independent native session isolation under an application queue.
- markworkd launch/authentication, detach/reattach, daemon restart/recovery, and durable application bindings.
- General web search, browser automation, arbitrary research quality, memory retrieval across independent chats, or a general tool-output redactor.
- Filesystem isolation, network filtering, external-write approvals, credential isolation, and protection from prompt injection. These remain explicitly deferred security hardening.

The Phase 0 gate is a manually runnable **local** pi agent producing a real researched report in its workspace. It does not certify the entire persistent/background Agent Folder feature.
