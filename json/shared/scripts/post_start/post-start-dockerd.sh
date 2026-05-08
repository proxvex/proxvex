#!/bin/sh
# Start dockerd in the background.
#
# The pre-baked debian-docker base image (oci/debian-docker/Dockerfile)
# ships docker.io + docker-cli but no init system — debian:trixie-slim
# is too minimal for systemd, and OCI-derived LXC rootfs aren't designed
# to run an init anyway. So we launch dockerd directly via nohup.
#
# Idempotent: a second run notices dockerd already on its socket and
# exits 0, so post_start replays after rollback don't double-start.
#
# 330-svc-start-docker-compose.sh polls `docker info` for up to 30
# attempts before giving up, so we don't block here on readiness — just
# ensure dockerd is launched.

set -eu

LOG_FILE="/var/log/dockerd.log"

if docker info >/dev/null 2>&1; then
  echo "dockerd already responsive — skipping start" >&2
  exit 0
fi

if [ ! -x /usr/sbin/dockerd ]; then
  echo "Error: /usr/sbin/dockerd missing — base image is broken" >&2
  exit 1
fi

# Project-level registry mirrors. Both come from project defaults
# (json/shared/templates/create_ct/050-set-project-parameters.json) and
# may be empty.
#
# - docker_registry_mirror: URL like https://docker-registry-mirror.
#   Goes into /etc/docker/daemon.json as `registry-mirrors`. Docker's
#   built-in Docker Hub mirror mechanism — falls back to docker.io
#   automatically if the mirror is unreachable.
#
# - ghcr_registry_mirror: URL like https://zot-mirror. Docker has no
#   per-registry mirror switch for ghcr.io, so we redirect at the host
#   level: hostname is resolved via DNS, the resulting IP is written
#   to /etc/hosts as `<ip> ghcr.io`. The mirror's TLS cert must include
#   `DNS:ghcr.io` in its SAN (proxvex zot-mirror app does this).
DOCKER_REGISTRY_MIRROR="{{ docker_registry_mirror }}"
GHCR_REGISTRY_MIRROR="{{ ghcr_registry_mirror }}"
[ "$DOCKER_REGISTRY_MIRROR" = "NOT_DEFINED" ] && DOCKER_REGISTRY_MIRROR=""
[ "$GHCR_REGISTRY_MIRROR" = "NOT_DEFINED" ] && GHCR_REGISTRY_MIRROR=""

mkdir -p /etc/docker
if [ ! -s /etc/docker/daemon.json ]; then
  if [ -n "$DOCKER_REGISTRY_MIRROR" ]; then
    cat > /etc/docker/daemon.json <<EOF
{
  "storage-driver": "overlay2",
  "userland-proxy": false,
  "registry-mirrors": ["${DOCKER_REGISTRY_MIRROR}"]
}
EOF
    echo "daemon.json: registry-mirrors -> ${DOCKER_REGISTRY_MIRROR}" >&2
  else
    cat > /etc/docker/daemon.json <<'EOF'
{
  "storage-driver": "overlay2",
  "userland-proxy": false
}
EOF
  fi
fi

# /etc/hosts redirect for ghcr.io. Idempotent: the marker line lets
# re-runs detect prior install and skip without double-adding. If the
# hostname can't be resolved (mirror not deployed yet), log a warning
# but don't fail dockerd startup — the daemon still boots, just without
# the redirect.
GHCR_HOSTS_MARKER="# proxvex: ghcr mirror"
if [ -n "$GHCR_REGISTRY_MIRROR" ] && ! grep -q "$GHCR_HOSTS_MARKER" /etc/hosts 2>/dev/null; then
  ghcr_mirror_host=$(echo "$GHCR_REGISTRY_MIRROR" | sed -E 's|^https?://||;s|/.*||;s|:.*||')
  ghcr_mirror_ip=$(getent hosts "$ghcr_mirror_host" 2>/dev/null | awk '{print $1; exit}')
  if [ -n "$ghcr_mirror_ip" ]; then
    echo "${ghcr_mirror_ip} ghcr.io  ${GHCR_HOSTS_MARKER}" >> /etc/hosts
    echo "/etc/hosts: ghcr.io -> ${ghcr_mirror_ip} (${ghcr_mirror_host})" >&2
  else
    echo "WARN: ghcr_registry_mirror=$GHCR_REGISTRY_MIRROR but $ghcr_mirror_host is not resolvable — skipping /etc/hosts redirect" >&2
  fi
fi

# nohup + setsid so dockerd survives the SSH session that launched it.
# stdout/stderr → log file; stdin → /dev/null. PID is reaped by the
# LXC's PID 1.
nohup setsid /usr/sbin/dockerd \
  >> "$LOG_FILE" 2>&1 < /dev/null &

echo "dockerd started (logs at ${LOG_FILE})" >&2
