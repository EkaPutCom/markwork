# markworkd

A small supervisor daemon for the agent processes that Markwork orchestrates, so a run keeps going when the Markwork
window is closed (or the SSH link to a VPS drops) and Markwork can reconnect and replay everything it missed.
Go, standard library only. Each agent runs under a small helper of its own (a *shim*), so the agents also survive the daemon being restarted or crashing; the next daemon takes them over (design section 17, `"shims": false` turns it off). The design and the wire protocol are in [docs/design/markworkd.md](../docs/design/markworkd.md).

## Build and test

```bash
cd markworkd
go build ./cmd/markworkd                 # one static binary; CGO_ENABLED=0 for a fully static build
go vet ./... && go test -race ./...
```

The tests start real processes (`testdata/fakeagent`, built on demand) and need nothing else.

## Run

Create `~/.config/markworkd/config.json`; without `roots` every spawn is refused:

```json
{ "roots": ["/home/you/projects"] }
```

```bash
markworkd start        # background daemon (or use contrib/systemd/ for socket activation)
markworkd status
markworkd list
markworkd logs <run> --follow
markworkd stop         # refused while runs are active; --force stops them in an orderly way,
                       # --detach leaves them going under their shims (for an upgrade)
```

Markwork gives each card of a Git project its own worktree, next to the project in `../.markwork-worktrees/`, and runs
`git` through the daemon to make and read it. So a root should be the folder that holds your projects (as above), not a
project itself, and `git` must be allowed: it is found in `PATH` when `programs` is empty, and must be listed when it is
not, e.g. `"programs": {"pi": "/home/you/.local/bin/pi", "git": "/usr/bin/git"}`.

For a VPS, install the binary there and let the client run `ssh -T host markworkd bridge`.
See section 10 of the design document for the systemd units and the PATH caveat (`agent_env`).

## Built-in agent-folder worker

The application includes `dist-electron/folder-worker.js`, a headless entry for
agent-folder chats. The daemon still moves JSONL lines without interpreting chat
or applying document proposals. It starts one worker turn per `folder-agent:<root>`
lane; approval waits for the application and its existing preflight.

Generate an explicit launcher after building the app:

```sh
node scripts/agent-worker-launcher.mjs /tmp/markwork-agent
```

Configure your daemon's `programs` map with `"markwork-agent": "/tmp/markwork-agent"`
and allow the absolute agent folder in `roots`. Use a persistent launcher path
for normal use. Restart/reload the daemon using its normal configuration workflow.
The launcher uses Electron's bundled Node via `ELECTRON_RUN_AS_NODE`; system Node
is not required at runtime. For an unpacked installation, pass the absolute
Markwork executable and `resources/app.asar/dist-electron/folder-worker.js` as the
second and third launcher arguments. Installed-package launch remains to be
validated; do not enable background capability based only on those paths existing.

The worker's `--check` reports protocol version 1, marker validity, and whether a
credential is available, never its value. Set up the daemon user's existing
credential source or environment deliberately; no credential goes in agent.json,
spawn labels, initial input, or recorded commands. A key available only in the
Electron vault cannot be used by this worker. The app falls back to local mode
when its bounded compatibility/credential probe fails.

`tests/electron/agent-worker.mjs` uses a temporary real daemon, fake model, and
throwaway credential to test disconnect/replay, pending approval, and command
deduplication. The latest scenario and complete npm test suite pass; packaged launch,
multiple-window races, and extended daemon/shim recovery still need validation. No Go protocol changes are required.
