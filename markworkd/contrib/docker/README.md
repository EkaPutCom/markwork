# A fake VPS in Docker

Tries the whole remote path without a server: Markwork → `ssh` → `markworkd bridge` → the daemon → an agent. The
container has sshd, markworkd, and a fake `pi` that speaks pi's RPC mode (no API key; it "works" for 60 seconds, so
there is time to close Markwork in the middle of a run).

```bash
cd markworkd
contrib/docker/run.sh            # builds, starts on 127.0.0.1:2222, prints the ~/.ssh/config block to add
```

`ENGINE=podman` and `KEY=~/.ssh/other.pub` override the container engine and the public key that is let in.

## What to try

1. Add the printed block to `~/.ssh/config` and check `ssh -o BatchMode=yes markwork-vps markworkd status`. That is
   exactly what Markwork runs, so if it asks for a password or a host key here, it fails in Markwork too.
2. Markwork: **Preferences → Agents → Add Machine…**, name `docker`, host `markwork-vps`; then *Run agents* → `docker`.
3. On a board, give a card `[agent:: pi]` and choose *Work on it with pi*. The folder is asked as a typed path:
   `/home/tester/projects/shop`. The card moves to In Progress and the log shows the fake agent.
4. While it works, **close Markwork** and choose *Keep Running and Close*. Open it again: the run is found, the log is
   replayed, and after the 60 seconds the card moves to Review with its note.
5. Cut the link: `docker pause markwork-vps`, wait, `docker unpause markwork-vps`. Home says *Trying again* while the
   machine does not answer; the run is unaffected.
6. Stop the daemon under the run: `docker exec markwork-vps pkill -u tester markworkd`. The run ends as *lost* and the card
   fails with "the daemon restarted while the run was active".

`contrib/docker/run.sh stop` removes the container; `logs` follows sshd.

## On a real VPS

markworkd is started by the first `markworkd bridge`, inside the ssh session but in a session of its own, so it survives
the session ending. If your distribution kills a user's processes at logout (`KillUserProcesses=yes` in logind), enable
lingering and use the systemd user units in `contrib/systemd/` instead: `loginctl enable-linger <user>`.
