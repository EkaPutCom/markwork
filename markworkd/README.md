# markworkd

A small supervisor daemon for the agent processes that Markwork orchestrates, so a run keeps going when the Markwork
window is closed (or the SSH link to a VPS drops) and Markwork can reconnect and replay everything it missed.
Go, standard library only. The design and the wire protocol are in [docs/design/markworkd.md](../docs/design/markworkd.md).

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
markworkd stop         # refused while runs are active; --force stops them in an orderly way
```

Markwork gives each card of a Git project its own worktree, next to the project in `../.markwork-worktrees/`, and runs
`git` through the daemon to make and read it. So a root should be the folder that holds your projects (as above), not a
project itself, and `git` must be allowed: it is found in `PATH` when `programs` is empty, and must be listed when it is
not, e.g. `"programs": {"pi": "/home/you/.local/bin/pi", "git": "/usr/bin/git"}`.

For a VPS, install the binary there and let the client run `ssh -T host markworkd bridge`.
See section 10 of the design document for the systemd units and the PATH caveat (`agent_env`).
