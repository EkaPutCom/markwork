# A stand-in for a VPS: sshd, markworkd, and a fake "pi" that speaks pi's RPC mode, so the whole path
# (Markwork → ssh → markworkd bridge → daemon → agent) can be tried without a server or an API key.
#
#   docker build -f contrib/docker/Dockerfile -t markwork-vps .      (run from markworkd/)

FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/markworkd ./cmd/markworkd

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd --create-home --shell /bin/bash tester \
 && passwd -l tester
COPY --from=build /out/markworkd /usr/local/bin/markworkd
COPY contrib/docker/fake-pi.sh /usr/local/bin/pi
COPY contrib/docker/entrypoint.sh /entrypoint.sh
RUN chmod 0755 /usr/local/bin/pi /entrypoint.sh \
 && install -d -o tester -g tester /home/tester/projects/shop /home/tester/.config/markworkd \
 && printf '{"roots":["/home/tester/projects"],"programs":{"pi":"/usr/local/bin/pi"},"default_idle_ttl_sec":86400}\n' > /home/tester/.config/markworkd/config.json \
 && chown tester:tester /home/tester/.config/markworkd/config.json
# Key logins only, for the one user.
RUN printf 'PasswordAuthentication no\nPermitRootLogin no\nAllowUsers tester\n' > /etc/ssh/sshd_config.d/markwork.conf
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
