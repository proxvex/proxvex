#!/bin/bash
# start-livetest-deployer.sh — Start the local proxvex backend in Spoke mode
# for live integration tests against the green/yellow instance.
#
# Architecture:
#   The proxvex-LXC (VMID 300) running inside the nested PVE VM is the Hub
#   (default mode — no env vars). The local backend on the developer host
#   runs as the Spoke by setting HUB_URL=http://${PVE_HOST}:${PORT_DEPLOYER},
#   pulling its project settings from the Hub on every start. This keeps
#   stack-passwords and secrets atomically consistent with whatever state
#   the nested VM holds (especially after qm rollback).
#
# What this script does:
#   1. Loads e2e/config.sh for the chosen instance
#   2. Kills any deployer already listening on the local DEPLOYER_PORT
#   3. Ensures the proxvex-LXC (Hub) inside the nested VM is running
#   4. Waits for the Hub HTTP API to respond
#   5. Starts the local backend in the background with HUB_URL set,
#      and DEPLOYER_PORT pointing at the local-instance port
#   6. Waits for the local backend to respond on its port
#
# Usage:
#   ./e2e/start-livetest-deployer.sh <instance>     # green | yellow
#
# Environment override:
#   DEPLOYER_PORT  — overrides the local backend port (default from config.json)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.json"

# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

INSTANCE_ARG=""
REFRESH_HUB=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --refresh-hub) REFRESH_HUB=true; shift ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *) [ -z "$INSTANCE_ARG" ] && INSTANCE_ARG="$1"; shift ;;
  esac
done
[ -z "$INSTANCE_ARG" ] && { echo "Usage: $0 [--refresh-hub] <instance>" >&2; exit 2; }

load_config "$INSTANCE_ARG"
# After load_config the following are exported:
#   PVE_HOST, PORT_PVE_SSH, PORT_DEPLOYER, PORT_DEPLOYER_HTTPS,
#   DEPLOYER_URL, DEPLOYER_VMID, E2E_INSTANCE, …

# Local backend port: pulled from the same place the live-test runner reads it.
# `${DEPLOYER_PORT:-...}` template in config.json: extract the literal default.
if [ -z "${DEPLOYER_PORT:-}" ]; then
  DEPLOYER_PORT=$(jq -r ".instances.\"$E2E_INSTANCE\".deployerPort" "$CONFIG_FILE" \
    | sed -E 's/.*\$\{DEPLOYER_PORT:-([0-9]+)\}.*/\1/' \
    | sed -E 's/^([0-9]+)$/\1/' )
fi
if [ -z "$DEPLOYER_PORT" ] || ! [[ "$DEPLOYER_PORT" =~ ^[0-9]+$ ]]; then
  echo "[ERR] Could not determine local DEPLOYER_PORT for instance $E2E_INSTANCE" >&2
  exit 1
fi
export DEPLOYER_PORT

HUB_URL="$DEPLOYER_URL"   # http://$PVE_HOST:$PORT_DEPLOYER, port-forwarded to proxvex-LXC

info() { echo "[INFO $(date +%H:%M:%S)] $*" >&2; }
ok()   { echo "[OK   $(date +%H:%M:%S)] $*" >&2; }
err()  { echo "[ERR  $(date +%H:%M:%S)] $*" >&2; exit 1; }

info "Instance:   $E2E_INSTANCE"
info "Hub URL:    $HUB_URL  (proxvex-LXC $DEPLOYER_VMID inside nested VM)"
info "Local port: $DEPLOYER_PORT"

# 1. Kill old deployer if listening
if lsof -i ":$DEPLOYER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PID=$(lsof -ti ":$DEPLOYER_PORT" -sTCP:LISTEN)
  info "Killing existing deployer on :$DEPLOYER_PORT (PID=$PID)"
  kill "$PID" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    lsof -i ":$DEPLOYER_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
fi

# 2. Ensure proxvex-LXC (Hub) is running inside nested VM
info "Ensuring Hub (proxvex-LXC $DEPLOYER_VMID) is running"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes -o ConnectTimeout=10 \
    -p "$PORT_PVE_SSH" "root@$PVE_HOST" \
    "pct status $DEPLOYER_VMID 2>/dev/null | grep -q running || pct start $DEPLOYER_VMID" \
  || err "Failed to start proxvex-LXC $DEPLOYER_VMID inside nested VM"

# 2b. (--refresh-hub) Push current workspace json/ + backend/dist into the
#     Hub-LXC so the Hub-side templates and backend code match what the user
#     has on disk. Without this, the Hub keeps the json/dist baked into the
#     deployer-installed snapshot from step2b, which gets stale across
#     livetest iterations.
if [ "$REFRESH_HUB" = "true" ]; then
  command -v docker >/dev/null || err "docker not found on local host (required for build)"
  command -v skopeo >/dev/null || err "skopeo not found on local host (install via brew/apt)"
  command -v pnpm   >/dev/null || err "pnpm not found on local host"

  info "Building proxvex Docker image (linux/amd64) for ${E2E_INSTANCE}"
  ( cd "$PROJECT_ROOT" && pnpm run build >&2 ) || err "pnpm build failed"
  rm -f "$PROJECT_ROOT/docker"/proxvex*.tgz
  TARBALL_RAW=$(cd "$PROJECT_ROOT" && npm pack --pack-destination docker/ 2>&1 | grep -o 'proxvex-.*\.tgz' | tail -n1)
  [ -n "$TARBALL_RAW" ] || err "npm pack did not produce a tarball"
  mv "$PROJECT_ROOT/docker/$TARBALL_RAW" "$PROJECT_ROOT/docker/proxvex.tgz"
  DOCKER_TAG="proxvex:local-${E2E_INSTANCE}"
  ( cd "$PROJECT_ROOT" && docker build --platform linux/amd64 -t "$DOCKER_TAG" -f docker/Dockerfile.npm-pack . >&2 ) \
    || err "docker build failed"
  OCI_TARBALL="$PROJECT_ROOT/docker/proxvex-${E2E_INSTANCE}-local.oci.tar"
  rm -f "$OCI_TARBALL"
  skopeo copy "docker-daemon:${DOCKER_TAG}" "oci-archive:${OCI_TARBALL}:latest" >&2 \
    || err "skopeo copy failed"

  REMOTE_TARBALL="/tmp/proxvex-${E2E_INSTANCE}-redeploy.oci.tar"
  REMOTE_INSTALLER="/tmp/install-proxvex-${E2E_INSTANCE}.sh"
  info "Uploading OCI tarball + installer to ${PVE_HOST}:${PORT_PVE_SSH}"
  scp -o StrictHostKeyChecking=no -P "$PORT_PVE_SSH" \
      "$OCI_TARBALL" "root@$PVE_HOST:$REMOTE_TARBALL" \
    || err "scp of OCI tarball failed"
  scp -o StrictHostKeyChecking=no -P "$PORT_PVE_SSH" \
      "$PROJECT_ROOT/install-proxvex.sh" "root@$PVE_HOST:$REMOTE_INSTALLER" \
    || err "scp of install-proxvex.sh failed"

  info "Redeploying proxvex-LXC $DEPLOYER_VMID via install-proxvex.sh --tarball"
  ssh -o StrictHostKeyChecking=no -p "$PORT_PVE_SSH" "root@$PVE_HOST" \
      "chmod +x $REMOTE_INSTALLER && $REMOTE_INSTALLER --tarball $REMOTE_TARBALL --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY --nameserver $DEPLOYER_GATEWAY --deployer-url $DEPLOYER_URL && rm -f $REMOTE_TARBALL $REMOTE_INSTALLER" \
    || err "install-proxvex.sh --tarball failed inside nested VM"

  ok "Hub redeployed; proxvex-LXC $DEPLOYER_VMID running with fresh image"
fi

# 3. Wait for Hub API to respond (proxvex-LXC just booted)
info "Waiting for Hub API at $HUB_URL"
HUB_READY=false
for i in $(seq 1 60); do
  if curl -sf --connect-timeout 2 "$HUB_URL/api/applications" >/dev/null 2>&1; then
    HUB_READY=true
    break
  fi
  sleep 2
done
$HUB_READY || err "Hub at $HUB_URL not reachable after 120s"
ok "Hub responsive at $HUB_URL"

# 4. Start local backend as Spoke
mkdir -p "$PROJECT_ROOT/.livetest-data"
LOG_FILE="/tmp/livetest-deployer-${E2E_INSTANCE}.log"
info "Starting local backend (Spoke) with HUB_URL=$HUB_URL on :$DEPLOYER_PORT"
info "Log: $LOG_FILE"

cd "$PROJECT_ROOT/backend"
HUB_URL="$HUB_URL" DEPLOYER_PORT="$DEPLOYER_PORT" \
  nohup node dist/proxvex.mjs \
  --local ../livetest-local \
  --storageContextFilePath ../.livetest-data/storagecontext.json \
  --secretsFilePath ../.livetest-data/secret.txt \
  > "$LOG_FILE" 2>&1 &

DEPLOYER_PID=$!
info "Local backend PID=$DEPLOYER_PID"

# 5. Wait for local backend to respond
info "Waiting for local backend at http://localhost:$DEPLOYER_PORT"
for i in $(seq 1 30); do
  if curl -sf --connect-timeout 2 "http://localhost:$DEPLOYER_PORT/api/applications" >/dev/null 2>&1; then
    ok "Local backend (Spoke) responsive at http://localhost:$DEPLOYER_PORT"
    exit 0
  fi
  if ! kill -0 "$DEPLOYER_PID" 2>/dev/null; then
    echo "[ERR] Local backend process died. Last 30 log lines:" >&2
    tail -30 "$LOG_FILE" >&2
    exit 1
  fi
  sleep 2
done
err "Local backend did not respond within 60s — check $LOG_FILE"
