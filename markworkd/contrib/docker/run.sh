#!/bin/sh
# Builds the fake VPS and starts it on 127.0.0.1:2222 with your public key. Run from anywhere.
#   contrib/docker/run.sh [start|stop|logs]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
module=$(cd "$here/../.." && pwd)
engine=${ENGINE:-$(command -v docker || command -v podman)}
key=${KEY:-$HOME/.ssh/id_ed25519.pub}
name=markwork-vps
case "${1:-start}" in
  start)
    [ -f "$key" ] || { echo "no public key at $key (set KEY=...)" >&2; exit 1; }
    "$engine" build -f "$here/Dockerfile" -t markwork-vps "$module"
    "$engine" rm -f "$name" >/dev/null 2>&1 || true
    "$engine" run -d --name "$name" -p 127.0.0.1:2222:22 -v "$key:/authorized_keys:ro" markwork-vps
    cat <<CONF

Add this to ~/.ssh/config (the host name is what you type in Markwork's "Add Machine"):

Host markwork-vps
    HostName 127.0.0.1
    Port 2222
    User tester
    IdentityFile ${key%.pub}
    StrictHostKeyChecking accept-new
    UserKnownHostsFile ~/.ssh/known_hosts.markwork-vps

Check it works without a password prompt, then in Markwork: Preferences → Agents → Add Machine…
  ssh -o BatchMode=yes markwork-vps markworkd status || ssh -o BatchMode=yes markwork-vps 'markworkd start && markworkd status'
  project folder to give a card on that machine: /home/tester/projects/shop
CONF
    ;;
  stop) "$engine" rm -f "$name" ;;
  logs) "$engine" logs -f "$name" ;;
  *) echo "usage: $0 [start|stop|logs]" >&2; exit 2 ;;
esac
