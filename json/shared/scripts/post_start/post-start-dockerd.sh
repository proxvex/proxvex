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

mkdir -p /etc/docker
if [ ! -s /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "storage-driver": "overlay2",
  "userland-proxy": false
}
EOF
fi

# nohup + setsid so dockerd survives the SSH session that launched it.
# stdout/stderr → log file; stdin → /dev/null. PID is reaped by the
# LXC's PID 1.
nohup setsid /usr/sbin/dockerd \
  >> "$LOG_FILE" 2>&1 < /dev/null &

echo "dockerd started (logs at ${LOG_FILE})" >&2
