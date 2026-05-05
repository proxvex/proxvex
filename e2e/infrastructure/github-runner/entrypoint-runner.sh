#!/bin/bash
# Stage 2 of the runner entrypoint — runs as the unprivileged `runner` user.
# Registers the GitHub Actions runner and exec's run.sh.

set -e

cd /home/runner

# --- PVE API config (Phase A1) -------------------------------------
# When the operator has staged /var/lib/gh-runner-secrets/pve_api_token, the
# runner ships qm operations through the REST API instead of SSH. The file
# format is shell-sourceable: PVE_API_TOKEN_ID=…, PVE_API_TOKEN_SECRET=… .
if [ -f /home/runner/.config/proxvex/pve-api-token ]; then
    set -a
    # shellcheck disable=SC1091
    . /home/runner/.config/proxvex/pve-api-token
    set +a
    : "${PVE_USE_API:=1}"
    : "${PVE_API_CA:=/home/runner/.config/proxvex/pve-root-ca.pem}"
    export PVE_USE_API PVE_API_CA
fi

# Default PVE host — workflow can override via env if needed.
export PVE_HOST="${PVE_HOST:-ubuntupve}"

# --- GitHub runner registration ------------------------------------
if [ -z "$REPO_URL" ] || [ -z "$ACCESS_TOKEN" ]; then
    echo "ERROR: REPO_URL and ACCESS_TOKEN must be set" >&2
    exit 1
fi

RUNNER_NAME="${RUNNER_NAME:-$(hostname)}"
LABELS="${LABELS:-self-hosted,linux,x64}"
RUNNER_WORKDIR="${RUNNER_WORKDIR:-/tmp/runner-work}"

mkdir -p "$RUNNER_WORKDIR"

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
./config.sh \
    --url "$REPO_URL" \
    --token "$REG_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$LABELS" \
    --work "$RUNNER_WORKDIR" \
    --unattended \
    --replace

cleanup() {
    echo "Removing runner registration..."
    ./config.sh remove --token "$REG_TOKEN" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec ./run.sh
