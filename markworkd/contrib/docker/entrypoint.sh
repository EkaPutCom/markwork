#!/bin/sh
# Installs the public key mounted at /authorized_keys for the user "tester", then runs sshd in the foreground.
set -eu
install -d -m 0700 -o tester -g tester /home/tester/.ssh
if [ -f /authorized_keys ]; then
    install -m 0600 -o tester -g tester /authorized_keys /home/tester/.ssh/authorized_keys
else
    echo "no public key: mount one with -v \$HOME/.ssh/id_ed25519.pub:/authorized_keys:ro" >&2
    exit 1
fi
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
