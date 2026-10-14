# markworkd: design

Status: v1 implemented in `markworkd/` (Go, standard library only, no third-party modules). Section 16 lists where the implementation differs from or settles this draft. The TypeScript client (section 14) is in `src/agent/daemon/` and `src/orchestratordaemon.ts`; the app wiring (settings, following runs again, the close question, Home) is in `src/daemonhub.ts` and `src/window/harness.ts`.

`markworkd` is a small supervisor daemon, one per machine (the desktop and any VPS). It owns the agent processes that Markwork orchestrates, so a run keeps going when the Markwork window is closed, and Markwork can reconnect to it later, locally or over SSH.

## 1. Goals and non-goals

Goals

- A run survives Markwork closing, crashing, or losing its SSH connection.
- Protocol-agnostic: the daemon moves bytes and lines. It never parses an agent's output (pi, Claude Code, Codex, ...). All meaning stays in Markwork's per-agent adapters, so adding or fixing an agent never needs a daemon redeploy.
- The same protocol for local and remote machines; remote is the local socket reached through `ssh ... markworkd bridge`.
- Replayable: a client that reconnects gets everything it missed, in order, without gaps.
- Small, boring, auditable: one static binary, no dependencies, no network listener.

Non-goals (v1)

- Surviving a restart of the daemon itself. The agents' stdio pipes belong to the daemon, so they end with it (see 8.2). A later version may hand pipes over.
- Parsing agent events, answering permission dialogs, or deciding when a card moves. That is the client's job.
- Authentication beyond OS file permissions and SSH. There is no TCP/TLS endpoint.
- Several clients arbitrating who may write. Any connected client may write; clients coordinate themselves.
- Terminal/PTY emulation. Agents are driven through their structured stdio modes (pi `--mode rpc` and similar).

## 2. Concepts

| Term | Meaning |
| --- | --- |
| run | One agent process plus its log. Identified by a client-chosen run id. |
| record | One entry of a run's log: a line of stdout or stdin, or a lifecycle marker. stderr is not part of the log; it is kept apart (4.6, section 6). Numbered by `seq`. |
| lane | A string key. At most one run per lane is running at a time; the rest wait in FIFO order. Markwork uses the project name, which reproduces today's "one harness per project folder" rule. An empty lane means no limit. |
| labels | Opaque string key/values the client attaches to a run (board file, card text, agent name, session id). Lets a client rebuild its view after losing its own state. |

The log is the single source of truth. A run's live state is a fold over its records; subscribers read the log, they do not get a separate copy.

## 3. Transport and framing

- Local: Unix domain socket, stream type.
  - Path: `$XDG_RUNTIME_DIR/markworkd/markworkd.sock`, falling back to `/tmp/markworkd-<uid>/markworkd.sock`.
  - The directory is created `0700`, the socket `0600`. On accept the daemon checks the peer uid with `SO_PEERCRED` (`syscall.GetsockoptUcred`) and drops other users.
- Remote: `ssh -T <host> markworkd bridge`. The bridge copies bytes between its stdio and the local socket, starting the daemon first if needed. Its first output line is a sentinel, `{"ev":"bridge","proto":1}`, so a client can skip anything a login shell printed before it.
- Framing: UTF-8 JSON, one message per line (`\n` terminated, no embedded newlines; `encoding/json` never emits them). Maximum frame size is 16 MiB; a larger inbound frame closes the connection with `frame_too_large`.
- One connection carries any number of concurrent requests and subscriptions. Responses are matched by `id`.

Message shapes

```
client → daemon   {"id":"c7","op":"<name>", ...params}
daemon → client   {"re":"c7","ok":true, ...result}
                  {"re":"c7","ok":false,"error":{"code":"<code>","message":"<text>"}}
                  {"ev":"<name>", ...payload}            push, no id
```

Timestamps are Unix milliseconds (`ts`, integers). Run ids match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`.

## 4. Operations

### 4.1 Session

`hello` must be the first request on a connection.

```
→ {"id":"1","op":"hello","proto":1,"client":"markwork/0.9"}
← {"re":"1","ok":true,"proto":1,"daemon":"markworkd 0.1.0","machine":"vps-1","pid":4242,"features":["watch"]}
```

`proto` is a major version. If the daemon does not support the client's value it answers `unsupported_proto` and lists what it supports in `supported`. New optional fields and new ops are not a major change.

`ping` → `{ok:true}` (liveness; `ssh` links can half-die). `info` → daemon version, uptime, state dir, counts per state, effective limits.

### 4.2 spawn

```
→ {"id":"2","op":"spawn","run":"b6f1c0de","program":"pi",
   "args":["--mode","rpc","--name","Fix login"],
   "cwd":"/home/eka/projects/web",
   "lane":"web",
   "env":{"PI_FOO":"1"},
   "labels":{"agent":"pi","board":"/home/eka/notes/board.md","card":"Fix login"},
   "initial_input":["{\"id\":\"markwork-state\",\"type\":\"get_state\"}","{\"id\":\"p1\",\"type\":\"prompt\",\"message\":\"...\"}"],
   "idle_ttl_sec":86400}
← {"re":"2","ok":true,"run":"b6f1c0de","state":"running","position":0}
```

- `program` is a name, not a path. The daemon resolves it through `programs` in its config, then `PATH` plus `~/.local/bin`, `~/.npm-global/bin`, `~/bin`, and `~/.local/share/mise/shims` (the same places Markwork's `findProgram` searches). A name that resolves nowhere or is not allowed gives `program_not_allowed`.
- `cwd` must be absolute and, after `filepath.EvalSymlinks`, inside one of the configured `roots`. Otherwise `cwd_not_allowed`. With no roots configured every spawn is refused.
- `env` entries are added to the daemon's environment; keys must match `env_allow` in the config (default: none), otherwise `env_not_allowed`.
- `initial_input` lines are written to stdin right after the process starts (and recorded as `in` records). This lets a client start a run, disconnect at once, and still have the prompt delivered, including when the run waits in a lane.
- `idle_ttl_sec`: if no client is subscribed and no output was produced for this long, the daemon closes stdin; if the process is still alive 30 s later it stops it. `0` disables; the default comes from the config and is 24 hours (`default_idle_ttl_sec`: 86400). Output on stderr counts as activity. A paused agent that waits for its next prompt therefore does not live forever.
- Idempotent: repeating a `spawn` with an existing run id and identical parameters returns the existing run (`"existing":true`). Different parameters give `conflict`. A client can retry safely after a dropped connection.
- If the lane is busy the run is `queued` and `position` is its place in line (1 = next).

Run states: `queued`, `running`, `exited`. An exited run carries `exit` = `{reason, code?, signal?, error?}`.

| reason | Meaning |
| --- | --- |
| `exited` | the process ended on its own; `code` is its exit status |
| `signaled` | killed by a signal that the daemon did not send; `signal` is its number |
| `stopped` | ended through the `stop` op |
| `canceled` | stopped while still queued, so it never started |
| `start_failed` | could not be started; `error` has the OS message |
| `idle_timeout` | ended by `idle_ttl_sec` |
| `log_limit` | ended because the log reached `max_log_bytes` |
| `lost` | the daemon restarted while the run was active (8.2) |

### 4.3 write, close_stdin, stop

```
→ {"id":"3","op":"write","run":"b6f1c0de","line":"{\"type\":\"steer\",\"message\":\"use pnpm\"}"}
← {"re":"3","ok":true,"seq":57}
```

- `line` must not contain `\n` or `\r` (`invalid_line`). The daemon appends one `\n`.
- The response means the line was written into the pipe and logged as `in` record `seq`, not that the agent read it. If the pipe stays blocked for 10 s the call fails with `write_timeout`.
- Errors: `not_found`, `not_started` (queued), `not_running` (exited), `stdin_closed`.

`close_stdin {run}` closes the agent's stdin, which for pi's RPC mode ends the run in an orderly way. Idempotent.

`stop {run, grace_ms?}`: a queued run becomes `exited/canceled`. A running one gets SIGTERM to its whole process group, then SIGKILL after `grace_ms` (default 5000). Idempotent. Returns immediately; completion is the `exit` record.

### 4.4 subscribe, unsubscribe

```
→ {"id":"4","op":"subscribe","run":"b6f1c0de","from_seq":1}
← {"re":"4","ok":true,"first_seq":1,"last_seq":212,"state":"running"}
← {"ev":"record","run":"b6f1c0de","seq":1,"ts":1760431200123,"kind":"start","line":"pid 5120"}
← {"ev":"record","run":"b6f1c0de","seq":2,"ts":...,"kind":"in","line":"{...}"}
← {"ev":"record","run":"b6f1c0de","seq":3,"ts":...,"kind":"out","line":"{\"type\":\"response\",...}"}
   ...
← {"ev":"end","run":"b6f1c0de","last_seq":240}
```

- Records from `from_seq` (default 1; 0 or omitted means "from the start"; a value above the current end means "only new ones") to the current end arrive first, then new ones as they are logged. No gap, no duplicate, strictly increasing `seq`.
- After the `exit` record the daemon sends `end` and drops the subscription. Subscribing to an already exited run replays and ends immediately.
- One subscription per run per connection; subscribing again replaces it (use this to resume from a new `from_seq`).
- Backpressure: the log is the buffer. Each subscription reads the log file at its own pace; a slow client simply lags and never blocks the supervisor or other clients. A connection whose socket write stalls for 30 s is closed. After any disconnect the client resumes with `from_seq = last_seen + 1`.
- Record fields: `seq`, `ts`, `kind` (`start`, `in`, `out`, `exit`), `line`, and `truncated:true` when a single line exceeded `max_line_bytes` (default 8 MiB) and only its start was kept. A client should treat a truncated or non-JSON `out` line as a note, as `PiReader` already does.
- `start` carries the pid in `line`; `exit` carries the JSON of the run's `exit` object.

`unsubscribe {run}` stops pushes for that run.

### 4.5 watch

`watch {}` subscribes the connection to state changes of every run, without their logs. The response holds an atomic snapshot so there is no race between listing and listening:

```
← {"re":"5","ok":true,"runs":[ <summary>, ... ]}
← {"ev":"state","run":"b6f1c0de","state":"exited","exit":{"reason":"exited","code":0},"last_seq":240}
```

Markwork uses this to move kanban cards when a run ends while it is connected, and to reconcile at startup.

### 4.6 list, get, forget, stderr

- `list {state?, lane?, labels?}` returns summaries; `labels` is an exact-match filter.
- `get {run}` returns one summary.
- `stderr {run, tail_bytes?}` returns the last `tail_bytes` (default 8192, at most `max_stderr_bytes`) of the agent's stderr as `{"text":"...","head_dropped":false}`. It works while the run is active and after it exits. Markwork uses it for the failure message, as it uses its stderr tail today.
- `forget {run}` deletes an exited run's directory (`not_finished` if it is queued or running). The daemon also removes exited runs older than `retention_days` (default 14).

Summary:

```
{"run":"b6f1c0de","state":"running","program":"pi","args":[...],"cwd":"...","lane":"web",
 "labels":{...},"pid":5120,"created_at":...,"started_at":...,"ended_at":null,
 "exit":null,"last_seq":212,"log_bytes":48211,"stderr_bytes":0,"queue_position":0}
```

### 4.7 shutdown

`shutdown {force?}`: refused with `runs_active` while any run is queued or running, unless `force` is true, in which case the running runs are stopped in an orderly way (they end as `stopped`). Queued runs are not canceled: they stay queued on disk and start with the next daemon. Without `force` this protects against an upgrade script ending live work.

## 5. Errors

`bad_request`, `unknown_op`, `unsupported_proto`, `frame_too_large`, `not_found`, `conflict`, `program_not_allowed`, `cwd_not_allowed`, `env_not_allowed`, `invalid_line`, `not_started`, `not_running`, `stdin_closed`, `write_timeout`, `not_finished`, `runs_active`, `limit_exceeded` (too many active runs or labels too large), `internal`.

`message` is for humans and logs; clients branch on `code`.

## 6. Storage

```
$XDG_STATE_HOME/markworkd/            (default ~/.local/state/markworkd)
  lock                  flock(2): one daemon per state dir
  daemon.log            the daemon's own log
  runs/<run>/
    meta.json           the spawn spec, state, pid, pgid, timestamps, exit; replaced atomically (temp file + rename)
    events.jsonl        the log, append-only, one record per line
    stderr.log          raw stderr of the agent, bounded (see below)
```

- `events.jsonl` lines are the same objects as the `record` push (`{"seq","ts","kind","line","truncated"?}`). A line that is not valid UTF-8 is stored with replacement characters (`encoding/json` behaviour); this is lossy but acceptable for JSON agent protocols.
- Appends are buffered and flushed to the file on every record (so subscribers see them), and `fsync`ed when an `exit` record is written and once per second otherwise.
- Each run keeps a sparse in-memory index of byte offsets (every 256 records) so `from_seq` seeks without scanning from the start. The index is rebuilt by one scan when the daemon starts.
- On startup a trailing partial line (crash during append) is truncated and numbering continues from the last good `seq`.
- `stderr.log` holds raw stderr bytes, not records: no `seq`, no subscription. It is bounded to `max_stderr_bytes` (default 1 MiB): when the file reaches twice that size the daemon rewrites it keeping the last `max_stderr_bytes`, so the end of the output, where errors usually are, is what survives. Because it is outside the event log, an agent that is noisy on stderr cannot bloat the replayed log or trigger `log_limit`.
- The log has a size cap, `max_log_bytes` (default 512 MiB); reaching it ends the run with `log_limit` rather than dropping records silently.
- Config: `$XDG_CONFIG_HOME/markworkd/config.json`.

```json
{
  "roots": ["/home/eka/projects"],
  "programs": {"pi": "/home/eka/.local/bin/pi"},
  "env_allow": ["PI_*"],
  "agent_env": {"PATH": "/home/eka/.local/share/mise/installs/node/24/bin:/usr/local/bin:/usr/bin:/bin"},
  "retention_days": 14,
  "default_idle_ttl_sec": 86400,
  "max_active_runs": 8,
  "max_log_bytes": 536870912,
  "max_line_bytes": 8388608,
  "max_stderr_bytes": 1048576
}
```

(JSON because the standard library has no TOML or YAML parser.) Unknown keys are rejected so a typo does not silently loosen a limit. `env_allow` supports a trailing `*` as the only wildcard. `agent_env` is a fixed set of variables added to every agent's environment (a client's allowed `env` entries are applied after it and win).

## 7. Run lifecycle

```
spawn ──► queued ──(lane free)──► running ──► exited
             │                       │
             └── stop ─► exited(canceled)     └── stop / idle_timeout / log_limit / process ends
```

Starting a run (`runner`): create two pipes with `os.Pipe` (so deadlines work on the stdin side), `exec.Cmd` with `SysProcAttr{Setpgid: true}` so the agent and everything it spawns share a process group, `Dir` set to the validated `cwd`, and a drain period of 1500 ms so that a grandchild holding a pipe open cannot keep the run from finishing (the same grace the current GJS code uses). After the direct child exits, remaining stdout and stderr are read for that period and then the read ends are closed. (`exec.Cmd.WaitDelay` is not used: the daemon reads the pipes itself instead of letting `exec` copy them.)

Per run, three goroutines: a stdout reader (splits at LF only, matching pi's JSONL framing, and appends `out` records) and a stderr copier (appends raw bytes to `stderr.log`, never to the event log), and a stdin writer fed by a bounded channel so a stalled agent cannot block the supervisor. A fourth waits for the process and finalizes the run: write the `exit` record, `fsync`, update `meta.json`, release the lane, start the next queued run in that lane, notify watchers.

Stopping: SIGTERM to `-pgid`, then SIGKILL to `-pgid` after the grace period. Killing the group also reaps the agent's tool subprocesses.

## 8. Failure behaviour

8.1 Client disappears (Markwork closed, SSH dropped). Nothing happens to runs. The daemon only notes there are no subscribers; `idle_ttl_sec` applies if the agent also goes quiet. When pi finishes a turn while no client is attached, it simply waits on stdin; the next client sees the end of turn in the log and decides what to do (close stdin, ask the user a question, send a follow-up).

8.2 Daemon restarts (crash, upgrade, reboot). The agents' pipes end with the daemon, so active agents end too. On startup the daemon:

1. Takes the lock and reads every run directory.
2. For each run recorded as `running`: if its process group still exists, SIGTERM then SIGKILL it (an unmonitored orphan is worse than a stopped run); append an `exit` record with reason `lost`.
3. Keeps `queued` runs queued, in `created_at` order, and starts them as lanes allow.
4. Leaves `exited` runs as they are for retention.

Clients treat `lost` as "interrupted, resume the agent's own session if it has one". `shutdown` without `force` exists to avoid this happening to live work. When the daemon receives SIGTERM (systemd stop, reboot) it first stops every active run in an orderly way, so those runs end as `stopped` with a complete log rather than as `lost`.

8.3 Disk full or log write error. The run is stopped with `log_limit` (or `internal` if the cause is unknown) and the error goes to `daemon.log`.

8.4 Lane starvation. A settled-but-idle agent still holds its lane. This matches today's behaviour (Markwork closes stdin after a turn without a question). `idle_ttl_sec` bounds it for unattended runs.

## 9. Security

- Only the owner's uid can reach the socket (directory `0700`, socket `0600`, peer-credential check).
- Remote access is SSH only; the daemon never listens on a TCP port.
- Markdown content cannot choose what runs: `program` is a name resolved by the daemon, `cwd` must be under a configured root, `env` keys must be allowed. Both Markwork (settings map project name to folder) and the daemon enforce this, so a compromised client alone cannot start arbitrary programs or write outside the roots. (A person with the SSH key can of course do anything their account can.)
- Labels and `initial_input` are stored in clear text under the state directory (mode `0700`); the log contains whatever the agent printed. Do not run an agent that prints secrets you would not keep on disk.
- The daemon never interprets the log's contents, so there is nothing in an agent's output that can make the daemon act.

## 10. Process and service management

Commands (`flag` package, subcommands):

| Command | Purpose |
| --- | --- |
| `markworkd serve` | run in the foreground (used by systemd, and by `start`) |
| `markworkd start` | start in the background if not running; idempotent. Re-executes itself with `Setsid`, output to `daemon.log` |
| `markworkd stop [--force]` | `shutdown` through the socket |
| `markworkd status` | running or not, version, runs per state |
| `markworkd bridge` | stdio to socket proxy for SSH; starts the daemon if needed |
| `markworkd list`, `markworkd logs <run> [--from N] [--follow]` | for people debugging by hand |
| `markworkd version` | |

Systemd (user): ship `markworkd.socket` and `markworkd.service` (installed to `~/.config/systemd/user/`). The daemon accepts a listener passed as fd 3 (`LISTEN_FDS`/`LISTEN_PID`, read with `os.NewFile` and `net.FileListener`, standard library only), so the socket exists at login and the daemon starts on first connection. On a VPS run `loginctl enable-linger <user>` so it survives logout.

```ini
# markworkd.socket
[Unit]
Description=Markwork agent supervisor (socket)

[Socket]
ListenStream=%t/markworkd/markworkd.sock
DirectoryMode=0700
SocketMode=0600

[Install]
WantedBy=sockets.target
```

```ini
# markworkd.service
[Unit]
Description=Markwork agent supervisor
Requires=markworkd.socket

[Service]
Type=simple
ExecStart=%h/.local/bin/markworkd serve
Restart=on-failure
# SIGTERM makes the daemon stop active runs in an orderly way (8.2); give it time.
TimeoutStopSec=20
```

Agents inherit the daemon's environment, and a daemon started by the systemd user manager does not have the PATH of an interactive shell. This was hit while testing: `pi` is a `#!/usr/bin/env node` script and `node` is installed under `~/.local/share/mise`, so under systemd it exited with status 127. Fix it with `agent_env` in `config.json` (as in section 6), or with `systemctl --user import-environment PATH` before the daemon starts. The daemon started from a shell (`markworkd start`) simply inherits that shell's PATH.

`%t` is `$XDG_RUNTIME_DIR`, so the path matches the default in section 3. `KillMode` stays at its default (control group): once the daemon is gone its agents have no monitor and broken pipes anyway. `markworkd start` is for hosts without systemd; it first checks whether the socket already answers, so the two never fight over the path, and the state-directory lock stops a second daemon regardless.

Flatpak note. The Markwork Flatpak (`build-aux/flatpak/com.ekaput.Markwork.json`) shares `home` but not the host's runtime directory, and a daemon started from inside the sandbox would die with it. So: the daemon is installed and started on the host (systemd user unit), and the Flatpak needs `--filesystem=xdg-run/markworkd` to reach its socket (checked: with that permission a socket created on the host is reachable at the same path inside the sandbox). Remote machines also need `--socket=ssh-auth`, so that keys held by the user's agent (including passphrase-protected ones) work; the GNOME 50 runtime already ships the `ssh` client (`/usr/bin/ssh`). Markwork must not start the daemon through `flatpak-spawn --host`, which would be a sandbox escape.

## 11. Module layout

The Go code lives in its own module so the npm/Vite build is unaffected.

```
markworkd/
  go.mod                         module github.com/EkaPutCom/markwork/markworkd ; go 1.23 ; no requires
  cmd/markworkd/main.go          subcommand dispatch, flag parsing, signal handling
  internal/
    model/        types shared everywhere, JSON tags are the wire format
                  Run, Summary, State, Exit, Reason, Record, Kind, SpawnSpec
    protocol/     Request/Response/Event envelopes, op names, error codes,
                  Encoder/Decoder that frame NDJSON with a max frame size
    config/       paths (XDG, runtime dir), Config struct, Load + Validate, defaults
    store/        on-disk layout: meta.json atomic writes, events.jsonl append,
                  sparse offset index, Read(fromSeq), startup recovery, retention sweep
    runner/       one process: pipes, Setpgid, WaitDelay, LF line splitting,
                  stdin writer with deadline, Stop(grace) escalation. No knowledge of runs or lanes
    supervisor/   the core: registry of runs, state machine, lanes and queue,
                  idle TTL, spawn validation (program/cwd/env), restart recovery,
                  broadcast of "new record" and "state change". No knowledge of sockets
    server/       listener (unix socket or inherited fd), peer-credential check,
                  per-connection session, op handlers, subscriptions, watch
    client/       typed Go client of the protocol; used by the CLI subcommands,
                  the bridge, and integration tests
    bridge/       stdio proxy with the sentinel line
    daemonize/    background start (re-exec with Setsid), flock helper
  testdata/
    fakeagent/    a tiny Go program that speaks a line protocol, can stay idle,
                  ignore SIGTERM, print giant lines, fork a child holding the pipe
    protocol/     transcript files shared with the TypeScript client tests
```

Dependency direction (no cycles): `model` ← `protocol`, `store`, `runner`, `config` ← `supervisor` ← `server` ← `cmd`. `client` depends only on `protocol` and `model`.

Key types (sketch):

```go
package supervisor

type Supervisor struct { /* store, config, runs map, lanes map, mu sync.Mutex */ }

func New(cfg config.Config, st *store.Store, launch runner.Launcher) *Supervisor
func (s *Supervisor) Recover(ctx context.Context) error
func (s *Supervisor) Spawn(spec model.SpawnSpec) (model.Summary, existing bool, err error)
func (s *Supervisor) Write(run, line string) (seq uint64, err error)
func (s *Supervisor) CloseStdin(run string) error
func (s *Supervisor) Stop(run string, grace time.Duration) error
func (s *Supervisor) Get(run string) (model.Summary, error)
func (s *Supervisor) List(f Filter) []model.Summary
func (s *Supervisor) Forget(run string) error

// Subscribe returns the records from fromSeq on. The channel closes after the exit record.
// Reading is paced by the caller; the log, not memory, is the buffer.
func (s *Supervisor) Subscribe(ctx context.Context, run string, fromSeq uint64) (<-chan model.Record, model.Summary, error)
func (s *Supervisor) Watch(ctx context.Context) (snapshot []model.Summary, events <-chan model.Summary)
```

```go
package runner

type Launcher interface {
    Start(p Params) (Process, error)
}
type Process interface {
    Stdout() <-chan Line      // closed when drained
    // stderr is not exposed: Params.Stderr (an io.Writer) receives its raw bytes
    Write(line string, timeout time.Duration) error
    CloseStdin() error
    Signal(sig syscall.Signal) error   // to the process group
    Wait() Exit                        // blocks; returns code/signal
    PID() int
}
```

The `Launcher` interface is the seam for faking the OS: the supervisor tests use it for start failures and otherwise run the real launcher against `testdata/fakeagent`.

Concurrency notes: each run has one mutex guarding its state and sequence counter; a record is appended under that mutex so `seq` is gapless and ordered. New-record notification is a channel that is closed and replaced on each append (broadcast with the standard library only); subscribers wake, read the file up to the committed offset, and wait again. The supervisor mutex only guards the registry and lane bookkeeping and is never held while doing I/O.

## 12. Testing

- Unit tests for each package with the standard `testing` package; `go vet` and `go test -race ./...` must pass.
- `store`: append/read round trips, index seek, crash recovery (truncate a partial line at every byte offset of a sample log), atomic `meta.json`.
- `supervisor` (real processes through `testdata/fakeagent`, a failing `Launcher` for start errors): FIFO lanes, cancel while queued, idempotent spawn, idle TTL with short real durations, log limit, restart recovery producing `lost`, and the rule that the `exited` state is visible as soon as the exit record is.
- `runner` with `testdata/fakeagent`: LF-only splitting, a giant line (truncation), SIGTERM ignored (SIGKILL after grace), a grandchild holding the pipe (finishes within the drain period), group kill.
- `server` + `client`: full sessions over a real socket in a temp dir: subscribe-from-seq gapless, slow subscriber does not stall others, reconnect and resume, `watch` snapshot race, peer-uid rejection, `shutdown` refusing with active runs.
- Conformance transcripts in `testdata/protocol/*.jsonl` (request lines and the expected response/event lines) run by the Go tests and by Markwork's TypeScript client tests, so both sides cannot drift apart.
- Race and soak: a test that runs hundreds of short runs concurrently with random disconnects and checks that no record is lost or duplicated.

## 13. Build and release

`CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" ./cmd/markworkd`, for `linux/amd64` and `linux/arm64`. The result is one static binary, copied to the VPS with `scp`. `markworkd version` and the `hello` response expose the version; Markwork shows a warning when the daemon's major protocol differs.

## 14. Client integration (Markwork side)

Markwork keeps its adapters and `Orchestrator`; only the process layer changes.

| Today (`spawnHarness`) | With markworkd |
| --- | --- |
| `GLib.spawn_async_with_pipes` | `spawn` (with `initial_input`) |
| `HarnessProcess.write(line)` | `write` |
| `HarnessProcess.closeInput()` | `close_stdin` |
| `HarnessProcess.stop()` | `stop` |
| stdout lines to `PiReader.line` | `record` pushes of kind `out` to the reader |
| `exit(status, stderr)` | the `exit` record and `end` event; the stderr tail comes from the `stderr` op |
| in-memory `RunQueue` | lanes in the daemon; the UI mirrors `queue_position` |

On startup Markwork connects to each configured machine, calls `watch`, matches runs to board cards through their `labels`, and for each run resubscribes from the last `seq` it processed (or from 1, which rebuilds the trace and session id because the readers are stateful). A run that ended while Markwork was closed goes through the normal `finish` path, so the card gets its result note and moves to Review. A run that is `lost` is shown as interrupted with the session id so the user can resume it.

The TypeScript side, as built:

| File | Role |
| --- | --- |
| `src/agent/daemon/protocol.ts` | wire types, `parseFrame`, `encodeRequest`, `exitStatus`; pure |
| `src/agent/daemon/client.ts` | `DaemonClient`: requests with replies and timeouts, `subscribe`, `watch`; works over any `Link`; pure apart from timers |
| `src/agent/daemon/connection.ts` | `DaemonConnection`: connects, says hello, reconnects with a growing delay, and keeps `follow()`ers and `watch()`ers going across reconnects |
| `src/agent/daemon/streamlink.ts` | `Link`s over real descriptors: `openSocketLink(path)` and `openCommandLink(argv)` (`sshBridgeArgv(...)` builds `ssh -T host markworkd bridge`) |
| `src/orchestratordaemon.ts` | `daemonSpawner(conn)`: a `Spawner` for the orchestrator whose processes live in the daemon; `adoptRun()` follows a run found again after a restart |

Decisions:

- The descriptors are driven with `GLib.IOChannel` watches, not Gio's async streams: GJS 1.80 can drop an async callback that arrives during garbage collection, which would leave a run unwatched. `spawnHarness` in `orchestrator.ts` made the same choice.
- Handlers for a subscription are registered before the request is sent. The daemon sends the first records right behind the reply, and a promise continuation runs only after the read loop finished handling those lines.
- A follower remembers the last record it delivered and resubscribes from the next one after a reconnect; it also drops any record at or below that number, so a misbehaving daemon cannot make it repeat output.
- `ready()` rejects with `closed` (shut down) or the daemon's own code (`unsupported_proto`) for final failures, and with `connection_closed` or `timeout` for ones that a reconnect fixes. Callers retry only the second kind.
- Writes are at-most-once. A line that was on its way when the link died may or may not have arrived, and sending it again could repeat a prompt, so it is reported through the spawner's `problem` callback instead. Closing and stopping are idempotent and are retried; creating a run is idempotent by run id and is retried.
- `HarnessProcess.detach()`: `Orchestrator.dispose()` calls it, when it exists, instead of `stop()`, so closing the window leaves a daemon run going. A local child process has no `detach` and is stopped as before.
- `Spawner` gets an optional fourth argument, `SpawnMeta` (`lane` = the project, `labels` = agent, project, board file, card text, title), so a run can be recognised after a restart.
- The run is forgotten on the daemon once its result was delivered (`forgetWhenDone`); a run whose owner never saw it end stays until the retention period.

The app wiring, as built:

- **Settings** (`data/com.ekaput.Markwork.gschema.xml`, Preferences → Agents): `harness-machine` (`''` = child of the window, `'local'` = the daemon on this computer, else the name of an SSH machine), `machines` (name → SSH host), `machine-projects` (`machine:project` → folder on that machine) and `daemon-command`. Names and hosts are validated in `agent/daemon/machines.ts`; a host is never allowed to start with `-`, and `sshBridgeArgv` puts `--` before it.
- **`DaemonHub`** (`src/daemonhub.ts`): one `DaemonConnection` per machine, made on first use. This computer uses `markworkd bridge` when the program is installed (the bridge starts the daemon) and otherwise the socket, which a systemd user service listens on; a sandboxed app only has the socket. A connection is dropped when the host or command of its machine changes, and kept otherwise because runs are followed through it.
- **`HarnessController`** picks the spawner by `harness-machine`, resolves the program by name (the daemon finds it), and keeps project folders per machine; for an SSH machine the folder is a typed absolute path and `Orchestrator.localFolders` is false, so the local folder checks are skipped.
- **Following runs again**: while a machine is chosen the controller `watch`es it, and every snapshot (after each connect) is matched against the board cards by the labels the orchestrator put on the run (agent, project, board, card text, title, and the computer's host name, so a run started from another computer is left alone). `Orchestrator.adopt()` follows such a run from its first record. The replay is old news: only the last signal that nothing was sent after is acted on once the replay is over, and a question whose own timeout ran out while Markwork was closed is noted instead of asked. A run that ended meanwhile goes through the normal finish path, so the card gets its note and moves to Review; a `lost` run fails the card with the daemon's reason.
- **Closing**: `confirmClose()` asks stop / keep running / cancel when agents work; `Orchestrator.dispose(stopDetachable)` stops or lets go accordingly. Agents that are children of the window can only be stopped, as before, but are now asked about too.
- **Connection state**: `Home` shows "Agents run on …" with *Connected*, *Connecting…*, *Trying again* or *Cannot connect* and the reason; the user gets a toast once when a machine becomes unreachable and once when it is back.
- **Flatpak**: `--filesystem=xdg-run/markworkd` and `--socket=ssh-auth` in `build-aux/flatpak/com.ekaput.Markwork.json`.

Known limits: only the machine chosen at startup is watched, so runs left on another machine are not found until it is chosen; a queued card (waiting behind another in the same project) is kept by the window, not the daemon, so closing the window does not start it later; a write that was on its way when the link died is reported, not repeated.

## 15. Open questions

- Nothing open for packaging: the unit files and the Flatpak permissions are in section 10. Still to confirm during implementation: the unit files on a real VPS, and that `ssh` inside the sandbox honours the user's `~/.ssh/config` and `ControlMaster` sockets.
- Optional later features: exclusive write leases, pipe hand-over so the daemon itself can be upgraded without ending runs, log compaction.

## 16. Implementation notes

Where the code settled things the draft left open or does differently.

- Layout: the module is `github.com/EkaPutCom/markwork/markworkd` (`go 1.23`, no requires). Packages are as in section 11; tests sit next to the code, and `internal/testutil` builds `testdata/fakeagent` once per test binary. `contrib/systemd/` has the two unit files from section 10.
- `spawn` returns after the process was started (or failed to), so its answer says `running` when the lane was free. `initial_input` is written in the background after that, because an agent may print a lot before it reads stdin.
- The `in` record is appended after the write into the pipe succeeded. An agent that answers immediately can therefore have its `out` record logged a moment before the `in` record that caused it. Readers that follow `out` records only (the pi reader) are not affected.
- A write that times out closes the agent's stdin and reports `write_timeout`: part of a line may already be in the pipe, and continuing would corrupt the stream. Later writes get `stdin_closed`.
- The exit record and the state change to `exited` happen under one lock. A client that has read the exit record (or the `end` event) and then calls `get`, `list` or `shutdown` sees the run as exited. If the daemon dies between writing the exit record and saving `meta.json`, recovery trusts the log: the run ends with the recorded exit instead of `lost`.
- `get` returns the summary's fields directly next to `re` and `ok`. `list` returns `{"runs":[...]}`.
- `program`: when `programs` in the config is not empty it is a strict allowlist; when it is empty the name is looked up in `PATH` and the per-user bin directories. The names must be plain (no `/`).
- Orphans: a run recorded as running at restart is only signalled if the process with the recorded pid still has the recorded start time (from `/proc/<pid>/stat`), so a recycled pid is never signalled. The start time is saved in `meta.json` as `start_ticks`.
- Shutdown: SIGTERM or the `shutdown` op stops running runs in an orderly way and then closes the listener. New spawns are refused with `shutting_down` meanwhile, and queued runs are not promoted.
- `stderr` result: `head_dropped` is true when output before the returned text exists (either cut by `tail_bytes` or dropped by the size bound).
- Verified by hand with the real thing: `pi --mode rpc` driven through the daemon (a `get_state` request answers, closing stdin ends pi with status 0); systemd socket activation with transient user units (the service starts on the first connection, uses systemd's socket, and `systemctl stop` ends a live run as `stopped`).
- The client tests are `tests/unit/daemon.ts` (an in-memory stand-in daemon in `daemon-fake.ts`, with manual timers) and `tests/unit/daemon-live.ts` (builds the Go daemon with `go build` and runs the client against it with a shell script as the agent; skipped with a note when Go is missing). `gjs -m dist/run-tests.js --only-daemon` runs just these.
- Not done in v1, as agreed: lease-based exclusive writers, pipe hand-over between daemons, log compaction.
