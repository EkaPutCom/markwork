#!/usr/bin/env bash
# A throwaway Forgejo in a Podman (or Docker) container for the live tests of the collaboration feature, and the commands to
# run them. Nothing is installed on this computer besides the image, and nothing leaves it: the server listens on 127.0.0.1 only.
#
#   scripts/forgejo.sh up          start a fresh Forgejo, make the two users and their tokens, seed the repository, write .env.forgejo
#   scripts/forgejo.sh test [what] up (if needed), build, and run: read | write | all (default)
#   scripts/forgejo.sh status      is it running, and what does it hold
#   scripts/forgejo.sh logs        follow the server log
#   scripts/forgejo.sh down        remove the container and its data
#   scripts/forgejo.sh reset       down, then up
#
# The tokens go to .env.forgejo (mode 600, ignored by git), never to your .env. ENGINE=docker, PORT=3001, IMAGE=… override.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
engine=${ENGINE:-$(command -v podman || command -v docker || true)}
port=${PORT:-3000}
image=${IMAGE:-codeberg.org/forgejo/forgejo:11}
name=markwork-forgejo
url=http://127.0.0.1:$port
envfile=$root/.env.forgejo
owner=eka

die() { echo "forgejo.sh: $*" >&2; exit 1; }
[ -n "$engine" ] || die "neither podman nor docker is installed"
cmd=${1:-help}

running() { "$engine" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; }
healthy() { curl -fsS --max-time 3 "$url/api/healthz" >/dev/null 2>&1; }

up() {
    if running && [ -f "$envfile" ] && healthy; then echo "already running at $url (scripts/forgejo.sh reset starts over)"; return; fi
    "$engine" rm -f -v "$name" >/dev/null 2>&1 || true
    echo "starting $image on $url …"
    "$engine" run -d --name "$name" -p "127.0.0.1:$port:3000" \
        -e FORGEJO__security__INSTALL_LOCK=true \
        -e FORGEJO__database__DB_TYPE=sqlite3 \
        -e FORGEJO__server__DOMAIN=127.0.0.1 \
        -e FORGEJO__server__ROOT_URL="$url/" \
        -e FORGEJO__server__HTTP_PORT=3000 \
        -e FORGEJO__server__DISABLE_SSH=true \
        -e FORGEJO__server__OFFLINE_MODE=true \
        -e FORGEJO__service__DISABLE_REGISTRATION=true \
        -e FORGEJO__mailer__ENABLED=false \
        -e FORGEJO__actions__ENABLED=false \
        -e FORGEJO__repository__DEFAULT_BRANCH=main \
        -e FORGEJO__log__LEVEL=Warn \
        "$image" >/dev/null
    for _ in $(seq 1 90); do healthy && break; sleep 1; done
    healthy || { "$engine" logs --tail 30 "$name" >&2; die "the server did not come up in 90 seconds"; }

    # The first user can only be made with the server's own command; the rest goes through its API.
    local password; password=$(openssl rand -base64 18 | tr -d '/+=')
    "$engine" exec --user git "$name" forgejo admin user create --username "$owner" --password "$password" \
        --email "$owner@example.invalid" --admin --must-change-password=false >/dev/null
    echo "seeding …"
    local result; result=$(python3 "$root/scripts/forgejo-seed.py" "$url" "$owner" "$password")
    local owner_token contributor_token repo
    owner_token=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["owner_token"])' <<<"$result")
    contributor_token=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["contributor_token"])' <<<"$result")
    repo=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["repo"])' <<<"$result")
    umask 077
    cat >"$envfile" <<ENV
# Written by scripts/forgejo.sh: a throwaway Forgejo at $url. The tokens are worthless once it is removed.
FORGEJO_URL=$url
FORGEJO_REPO=$repo
FORGEJO_TOKEN=$owner_token
FORGEJO_CONTRIBUTOR_TOKEN=$contributor_token
ENV
    echo "ready: $url/$repo   (tokens in $envfile)"
}

down() { "$engine" rm -f -v "$name" >/dev/null 2>&1 && echo "removed $name" || echo "$name was not there"; rm -f "$envfile"; }

status() {
    if running; then
        healthy && echo "running, answering at $url" || echo "running, but not answering yet"
        [ -f "$envfile" ] && echo "tokens: $envfile" || echo "no $envfile: run scripts/forgejo.sh up"
        if [ -f "$envfile" ]; then
            # shellcheck disable=SC1090
            . "$envfile"
            curl -fsS -H "Authorization: token $FORGEJO_TOKEN" "$url/api/v1/repos/$FORGEJO_REPO/pulls?state=open" 2>/dev/null \
                | python3 -c 'import json,sys; [print("  #%s %s (mergeable: %s)" % (p["number"], p["title"], p["mergeable"])) for p in json.load(sys.stdin)]' || true
        fi
    else
        echo "not running"
    fi
}

# The live tests read their server and tokens from the environment. Sourcing .env.forgejo here, and calling node directly,
# keeps the user's own .env (which the npm scripts source, and which may have these keys empty) out of it.
runtests() {
    local what=${1:-all}
    case "$what" in read|write|all) ;; *) die "test what? read | write | all" ;; esac
    up
    cd "$root"
    npx vite build -c vite.node.config.ts >/dev/null
    set -a; . "$envfile"; set +a
    local failed=0
    if [ "$what" = read ] || [ "$what" = all ]; then
        echo; echo "== forge layer, read-only =="; node dist-node/live-forge.js || failed=1
    fi
    if [ "$what" = write ] || [ "$what" = all ]; then
        echo; echo "== forge layer, writing (comment, fork, AGit, merge, conflict) =="; node dist-node/live-forge.js --write || failed=1
    fi
    echo; [ "$failed" = 0 ] && echo "all live Forgejo tests passed" || echo "some live Forgejo tests FAILED"
    return "$failed"
}

case "$cmd" in
    up) up ;;
    down) down ;;
    reset) down; up ;;
    status) status ;;
    logs) exec "$engine" logs -f "$name" ;;
    test) runtests "${2:-all}" ;;
    *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; [ "$cmd" = help ] || exit 2 ;;
esac
