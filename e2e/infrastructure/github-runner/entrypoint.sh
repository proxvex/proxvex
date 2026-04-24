#!/bin/bash

# Required environment variables:
#   REPO_URL       - GitHub repository URL (e.g. https://github.com/owner/repo)
#   ACCESS_TOKEN   - GitHub PAT with Actions read/write permission
#   RUNNER_NAME    - Display name for this runner
#   LABELS         - Comma-separated labels (e.g. self-hosted,linux,x64,pve1)
#
# Optional:
#   RUNNER_SECRETS_DIR  - Mount point of the host-side secrets volume
#                         (default: /var/lib/gh-runner-secrets). If the file
#                         <dir>/nested_vm_id_ed25519 exists, it is installed
#                         as the outbound SSH identity for the nested-VM hop.

# Runs as root (Dockerfile sets USER root) — needed for DHCP in LXC containers
export RUNNER_ALLOW_RUNASROOT=1

cd /home/runner

# LXC with lxc.init.cmd bypasses the normal init system, so no DHCP client runs.
# Find the first real network interface (skip lo and bonding_masters).
NET_IF=$(ip -o link show 2>/dev/null | awk -F': ' '!/lo|bonding/{print $2; exit}')
if [ -n "$NET_IF" ] && ! ip addr show "$NET_IF" 2>/dev/null | grep -q 'inet '; then
    echo "Requesting DHCP lease for $NET_IF..."
    ip link set "$NET_IF" up 2>/dev/null || true
    dhclient -1 -4 "$NET_IF" 2>/dev/null || true
fi

# Wait for external connectivity
echo "Waiting for network..."
for i in $(seq 1 15); do
    if curl -sf --max-time 2 https://api.github.com >/dev/null 2>&1; then
        echo "Network ready"
        break
    fi
    sleep 1
done

if [ -z "$REPO_URL" ] || [ -z "$ACCESS_TOKEN" ]; then
    echo "ERROR: REPO_URL and ACCESS_TOKEN must be set" >&2
    exit 1
fi

# Set up SSH private key for connecting to test-worker
if [ -n "$SSH_PRIVATE_KEY" ]; then
    mkdir -p /home/runner/.ssh
    echo "$SSH_PRIVATE_KEY" > /home/runner/.ssh/id_ed25519
    chmod 600 /home/runner/.ssh/id_ed25519
    echo "SSH private key installed"
fi

# Pick up the nested-VM identity from the secrets mount if provided. The key
# lives on the host so it can be rotated without touching the image. Runs on
# every container start: edit the file on the host, pct restart the LXC.
SECRETS_DIR="${RUNNER_SECRETS_DIR:-/var/lib/gh-runner-secrets}"
if [ -f "$SECRETS_DIR/nested_vm_id_ed25519" ]; then
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    install -m 600 "$SECRETS_DIR/nested_vm_id_ed25519" /root/.ssh/id_ed25519_nested
    # Make SSH offer BOTH keys (install-ci.sh-generated + nested-VM key) so
    # runner -> ubuntupve uses the first, runner -> nested-VM uses the second.
    # SSH tries them in order until one is accepted.
    cat >> /root/.ssh/config <<'SSHCFG'
Host *
    IdentityFile ~/.ssh/id_ed25519
    IdentityFile ~/.ssh/id_ed25519_nested
    IdentitiesOnly no
SSHCFG
    chmod 600 /root/.ssh/config
    echo "Nested-VM SSH key installed from $SECRETS_DIR"
else
    echo "No nested-VM SSH key found at $SECRETS_DIR/nested_vm_id_ed25519 — runner -> nested-VM will fail"
fi

RUNNER_NAME="${RUNNER_NAME:-$(hostname)}"
LABELS="${LABELS:-self-hosted,linux,x64}"
RUNNER_WORKDIR="${RUNNER_WORKDIR:-/tmp/runner-work}"

mkdir -p "$RUNNER_WORKDIR"

# Get registration token from GitHub API
echo "Requesting registration token for $REPO_URL..."
API_URL=$(echo "$REPO_URL" | sed 's|https://github.com/|https://api.github.com/repos/|')
REG_TOKEN=$(curl -s -X POST \
    -H "Authorization: token $ACCESS_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "$API_URL/actions/runners/registration-token" \
    | jq -r '.token')

if [ -z "$REG_TOKEN" ] || [ "$REG_TOKEN" = "null" ]; then
    echo "ERROR: Failed to get registration token" >&2
    exit 1
fi

echo "Configuring runner '$RUNNER_NAME' with labels: $LABELS"

# Configure runner (--replace to handle re-registration)
./config.sh \
    --url "$REPO_URL" \
    --token "$REG_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$LABELS" \
    --work "$RUNNER_WORKDIR" \
    --unattended \
    --replace

# Cleanup on exit: remove runner registration
cleanup() {
    echo "Removing runner registration..."
    ./config.sh remove --token "$REG_TOKEN" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start runner
exec ./run.sh
