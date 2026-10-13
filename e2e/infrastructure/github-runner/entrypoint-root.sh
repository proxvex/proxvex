#!/bin/bash
# Stage 1 of the runner entrypoint — runs as root inside the LXC (PID 1).
# Handles tasks that genuinely need root, then exec gosu's into `runner`
# for the actual GitHub Actions runner registration + run.sh.
#
# Required env (passed via lxc.environment):
#   REPO_URL       GitHub repo URL (https://github.com/owner/repo)
#   ACCESS_TOKEN   GitHub PAT for the registration-token call
#   RUNNER_NAME    Display name for this runner
#   LABELS         Comma-separated labels (self-hosted,linux,x64,ubuntupve)
#
# Optional env:
#   RUNNER_SECRETS_DIR  Mount point of the host secrets bind-mount (default
#                       /var/lib/gh-runner-secrets). Files we look for:
#                         nested_vm_id_ed25519  → ~runner/.ssh/id_ed25519_nested
#                         pve_api_token         → ~runner/.config/proxvex/pve-api-token
#                         pve_root_ca.pem       → ~runner/.config/proxvex/pve-root-ca.pem
#   PVE_HOST            PVE node hostname (default: ubuntupve), exported to runner
#   PVE_USE_API         "1" enables the API-token path in pve-ops.sh and
#                       snapshot-manager.mts (default: "1" — Phase A1+A2)

set -e

# --- DHCP -----------------------------------------------------------
# LXC with lxc.init.cmd bypasses systemd, so dhclient may need a manual nudge.
NET_IF=$(ip -o link show 2>/dev/null | awk -F': ' '!/lo|bonding/{print $2; exit}')
if [ -n "$NET_IF" ] && ! ip addr show "$NET_IF" 2>/dev/null | grep -q 'inet '; then
    echo "Requesting DHCP lease for $NET_IF..."
    ip link set "$NET_IF" up 2>/dev/null || true
    dhclient -1 -4 "$NET_IF" 2>/dev/null || true
fi

echo "Waiting for network..."
for i in $(seq 1 15); do
    if curl -sf --max-time 2 https://api.github.com >/dev/null 2>&1; then
        echo "Network ready"
        break
    fi
    sleep 1
done

# --- dockerd (root-only) --------------------------------------------
# Start dockerd, then CHECK THAT IT ANSWERS — same shape as
# json/shared/scripts/post_start/post-start-dockerd.sh (template 307).
#
# The socket file existing is not proof of a working daemon: on a cold host
# boot with many containers starting at once, dockerd's embedded containerd can
# take longer than dockerd's internal wait, and dockerd exits with
#   failed to start containerd: timeout waiting for containerd to start
# (ubuntupve, 2026-10-02). The old block then logged a WARN and handed over to
# the runner anyway, which registered with GitHub and accepted jobs it could
# not run. So: poll `docker info`, retry once (the cause is contention, not a
# broken daemon), and refuse to start the runner if Docker never comes up.
DOCKERD_LOG=/var/log/dockerd.log

# Stale pid/sock files from a cloned or restored rootfs, or from a dead
# attempt, make dockerd refuse to start ("process with PID N is still
# running") or time out on its embedded containerd. Only called once we know
# no dockerd is answering, so anything left here is stale.
clear_dockerd_state() {
    rm -f /var/run/docker.pid /var/run/docker.sock
    rm -f /run/docker/containerd/containerd.pid \
          /run/docker/containerd/containerd.sock \
          /run/docker/containerd/containerd.sock.ttrpc \
          /run/docker/containerd/containerd-debug.sock
}

start_dockerd() {
    nohup dockerd --host=unix:///var/run/docker.sock >>"$DOCKERD_LOG" 2>&1 </dev/null &
    echo "dockerd started (logs at $DOCKERD_LOG)"
}

wait_for_dockerd() {
    waited=0
    while [ "$waited" -lt "$1" ]; do
        docker info >/dev/null 2>&1 && return 0
        sleep 2
        waited=$((waited + 2))
    done
    return 1
}

if command -v dockerd >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        echo "dockerd already responsive"
    else
        echo "Starting Docker daemon..."
        clear_dockerd_state
        start_dockerd
        if wait_for_dockerd 60; then
            echo "Docker daemon ready"
        else
            echo "WARN: dockerd did not become responsive within 60s — retrying once"
            tail -n 5 "$DOCKERD_LOG" || true
            pkill -x dockerd 2>/dev/null || true
            pkill -x containerd 2>/dev/null || true
            sleep 2
            clear_dockerd_state
            start_dockerd
            if wait_for_dockerd 60; then
                echo "Docker daemon ready after retry"
            else
                # Exiting PID 1 stops the container. An offline runner is
                # visible in GitHub; a runner without Docker silently fails
                # every job that builds an image.
                echo "ERROR: dockerd still not responsive after retry — not starting the runner"
                tail -n 20 "$DOCKERD_LOG" || true
                exit 1
            fi
        fi
    fi
    # runner is in the docker group (Dockerfile usermod -aG); ensure the
    # socket is group-writable so post-drop docker calls work.
    chgrp docker /var/run/docker.sock 2>/dev/null || true
    chmod 660 /var/run/docker.sock 2>/dev/null || true
fi

# --- secrets materialisation ---------------------------------------
SECRETS_DIR="${RUNNER_SECRETS_DIR:-/var/lib/gh-runner-secrets}"
RUNNER_HOME=$(getent passwd runner | cut -d: -f6)
RUNNER_HOME="${RUNNER_HOME:-/home/runner}"

install -d -o runner -g runner -m 700 "$RUNNER_HOME/.ssh"
install -d -o runner -g runner -m 700 "$RUNNER_HOME/.config"
install -d -o runner -g runner -m 700 "$RUNNER_HOME/.config/proxvex"

if [ -f "$SECRETS_DIR/nested_vm_id_ed25519" ]; then
    install -o runner -g runner -m 600 \
        "$SECRETS_DIR/nested_vm_id_ed25519" \
        "$RUNNER_HOME/.ssh/id_ed25519_nested"
    cat > "$RUNNER_HOME/.ssh/config" <<'SSHCFG'
Host *
    IdentityFile ~/.ssh/id_ed25519_nested
    IdentitiesOnly no
SSHCFG
    chown runner:runner "$RUNNER_HOME/.ssh/config"
    chmod 600 "$RUNNER_HOME/.ssh/config"
    echo "Nested-VM SSH key staged for runner"
else
    echo "WARN: $SECRETS_DIR/nested_vm_id_ed25519 missing — nested-VM SSH will fail"
fi

if [ -f "$SECRETS_DIR/pve_api_token" ]; then
    install -o runner -g runner -m 600 \
        "$SECRETS_DIR/pve_api_token" \
        "$RUNNER_HOME/.config/proxvex/pve-api-token"
    echo "PVE API token staged"
fi
if [ -f "$SECRETS_DIR/pve_root_ca.pem" ]; then
    install -o runner -g runner -m 644 \
        "$SECRETS_DIR/pve_root_ca.pem" \
        "$RUNNER_HOME/.config/proxvex/pve-root-ca.pem"
    echo "PVE root CA staged"
fi

# --- drop privs and continue ---------------------------------------
echo "Dropping privileges to runner ($(id -u runner):$(id -g runner))"
exec gosu runner /bin/bash /entrypoint-runner.sh
