# Pi Agent Folders — Phase 2

Status: implemented. Commit subject: `feat(agent): support background pi folder execution`. Pi remains the agent runtime; local Linux markworkd owns background process lifetime. The ordinary Assistant and card/worktree semantics are unchanged. No Go/protocol changes or custom-worker fallback are involved.

## Setup and boundary

1. Install pi **1.4.0** and authenticate using pi in the account that runs local markworkd. Environment-only credentials must already be available to that daemon; Markwork does not forward Assistant credentials or secrets through daemon arguments, env, labels or stdin.
2. Configure markworkd’s `programs.pi` with the installed executable and allow the agent’s `workspace/` as a working directory. Example configuration:

   ```json
   { "roots": ["/home/me/notes/agents/research/workspace"],
     "programs": { "pi": "/home/me/.local/bin/pi" },
     "default_idle_ttl_sec": 0 }
   ```

   Use real absolute paths for your installation. Set daemon record/log limits for expected pi JSON records; truncated records fail closed rather than being interpreted. Session/instruction files reside in application data. Daemon roots validate cwd, not file access through pi arguments or tools: this is **not a sandbox**.
3. Activate the Agent Folder and choose **Use background pi**. Selection is not a claim that dependencies work. Before submitting new work, Markwork runs bounded daemon-side version and `pi auth check --provider … --json --no-refresh` probes, never credential-printing commands. Provider identifiers are validated before constructing CLI arguments so RPC data cannot become flags such as `--credentials`. Auth readiness is configuration validation, not a provider-network test. Reauthentication is done in pi, not the Assistant key dialog.

## Lifetime and ownership

`FolderStore` persists execution selection and exact agent/chat/native/run identity before spawn. A failed or lost spawn acknowledgement leaves the original run ID reserved. `FolderDaemonPi` starts unmodified RPC pi through the daemon’s allowlisted program. Its lane is one slot per agent UUID. A runtime owner directory excludes another Markwork window; an old in-memory index is refreshed only after acquiring exclusive ownership so it cannot overwrite a detached run reservation.

`FolderDaemonProcess` follows numbered LF records with gap/truncation checks and coalesced 500 ms durable high-water checkpoints. Stream reconnect resumes after the last delivered record. A fresh application rebuilds its current-turn presentation from record 1 of that exact single-turn run; merely starting at a persisted cursor without a matching UI checkpoint would lose earlier output. RPC command IDs include a fresh instance UUID, so historical responses cannot satisfy new queries. Replay observes events only and never writes historical commands to stdin.

Prompts are sent once. Failed writes are not retried, and prompt acknowledgement is not completion: `agent_settled` is required. The same native session is queried before adoption. An unknown, ended or mismatched run is not replaced. A settled process is closed and its run reservation removed only after daemon exit is confirmed. A background process that finishes while disconnected can remain idle until the app reconnects; daemon TTL/log policy may also end it.

Closing a tab does not stop work. Closing the application or switching workspace offers Keep or Stop. Keep detaches background observations, stops local children, cancels the in-memory waiting queue, preserves unsubmitted text as private drafts, then releases ownership. A settings registry of explicitly selected agent IDs/roots enables reattachment even if their chat tabs were closed. Opening does not submit a prompt or auto-run a draft. Closing is never approval for the ordinary Assistant.

## Recovery

- **Transport drop:** numbered followers resume; writes with unknown outcomes are not repeated. Use Reconnect original run if the observation failed.
- **Explicit Stop:** the daemon stops the exact run. Completed tools cannot be undone and detached descendants are not guaranteed terminated. Interrupted native history requires explicit Restore before another prompt.
- **Lost/ended/missing run:** explicit Restore confirms terminal/absent state through a reachable daemon, removes only that reservation, then reads the exact native file. No prompt or tool is replayed. If the original run is still alive, restoration is refused until it is stopped.
- **Daemon unreachable:** no absence/termination inference; keep the reservation. Bounded waits surface an error rather than waiting indefinitely.
- **Application crash/stale owner:** fail closed. Inspect native/daemon state and confirm the old window is gone before manually removing only the runtime owner directory. There is no automatic stale-lock takeover. Do not remove an active window’s ownership.
- **Projection edited:** still not executable history. Explicit native restoration replaces presentation only.

Private drafts and daemon input/output logs contain user/tool text in plaintext under account permissions. They are presentation/recovery records, never automatic execution input. Native pi history remains model authority. Existing user files and old formats are not migrated or removed.

## Evidence and costs

`tests/unit/folderdaemon.ts` builds real markworkd and uses a deterministic executable pi substitute, not the user’s pi, credentials or a paid provider. It checks application close/reopen, continued report creation, exact native binding, no duplicate submission, a competing owner, stale-reader refresh, queued drafts, explicit lost-run recovery, unavailable execution-machine credentials, and provider identifiers that must never become credential-printing flags. Protocol tests reject forged roots, modes and stop requests; the explicit Stop-original control remains reachable after observation failure. `tests/electron/folder-background.mjs` closes an actual Electron window, allows tool completion while closed, then reopens and checks the native result and one submission. It also exercises the visible Stop original run and explicit native restoration controls. Screenshots cover light, dark and 560 px.

A new end-to-end baseline includes daemon-side preflights, native resume, 1,000 streamed updates, disk projection/index and confirmed shutdown: Linux Node v24.21.0, three warmups plus twenty samples, median **185.574 ms**, p95 **191.675 ms**, maximum **194.658 ms** in the initial complete run. This is added background overhead, not a speedup or an equivalent comparison against the local transport microbenchmark. The final full-suite sample was **226.817/241.318/265.627 ms** (about +22% median versus the initial sample); an immediate focused rerun of the same built code was **184.639/198.370/198.671 ms**. These differing suite contexts are not a controlled old/new comparison. All samples, including the higher cost, remain in `tests/bench/AGENTIC.md`.

## Validation

- `npm run typecheck`: passes, including layer, complexity and UI checks; no exceptions added.
- `npm test`: exit 0, **919 core tests**, all Electron suites including the real-window background scenario, 16 spike tests, Git-rule/site checks. The final full log was scanned for errors, warnings, unhandled failures and application stack traces; only two Error-named passing test titles matched.
- Focused Agent Folder rerun: **28 passed**, including real-daemon lifecycle and Stop/recovery. The real-window test passed repeatedly after correcting its test selector and waiting for the actual close event; no fixed test pause is used.
- Light/dark/560 px screenshots inspected; four Agent Folder documentation scenes regenerated through `npm run docs`. Documentation simulations and pages checked through a local HTTP server at 375 px: no JavaScript/console errors or horizontal overflow.
- `git diff --check`: clean. No Go source changed; real daemon binaries are built by the integration tests. No new live-provider request or installed-package smoke was run.

Not verified: installed-package/background launch, real-provider daemon authentication, macOS/Windows or SSH Agent Folders, maximum-size history replay, long-lived heap behavior, recovery after deliberate runtime-state deletion, hard external file locks, sandbox/egress enforcement, and detached-child termination. Existing daemon/shim tests cover generic reconnect/restart transport; that does not substitute for a pi-specific daemon-restart or packaged live experiment.
