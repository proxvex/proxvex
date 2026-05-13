#!/bin/bash
# setup-test-project.sh — Sync the in-repo `livetest-local/shared/` tree into
# the test deployer (Hub LXC at VMID 300 in the nested VM) at
# `/config/shared/`.
#
# Source of truth: $PROJECT_ROOT/livetest-local/shared/ (committed in the
# repo, edited by the developer). This is the same directory the local
# Spoke reads as its `--local` override — so the Hub and the Spoke see
# identical project-wide template defaults
# (e.g. `create_ct/050-set-project-parameters.json` with
# `docker_registry_mirror=https://docker-mirror-test`, alpine_mirror, ...)
# and tests run the same whether dispatched against the Spoke or directly
# against the Hub LXC.
#
# Called by:
#   - step2b-install-deployer.sh, after the Hub LXC is up and before the
#     deployer-installed snapshot is taken — so the snapshot already
#     contains the defaults.
#   - start-livetest-deployer.sh, before the Spoke boots — refreshes the
#     Hub whenever livetest-local/shared/ was edited locally.
#
# Usage:
#   ./e2e/setup-test-project.sh [instance]   # green | yellow | github-action
#
# Idempotent. Wipes /config/shared/ on the Hub before re-extracting so
# files that disappear from livetest-local also disappear on the Hub.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"
load_config "${1:-}"

# shellcheck source=lib/nested-ssh.sh
. "$SCRIPT_DIR/lib/nested-ssh.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info()    { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

DEPLOYER_HOSTNAME="${DEPLOYER_HOSTNAME:-proxvex}"
SHARED_SRC="$PROJECT_ROOT/livetest-local/shared"

if [ ! -d "$SHARED_SRC" ]; then
    error "$SHARED_SRC not found — nothing to sync"
fi

# Locate the deployer LXC inside the nested VM. config.json's
# defaults.deployerVmid is the canonical pin (300), but we resolve by
# hostname too as a sanity check — guards against a re-renumbered Hub.
info "Locating deployer LXC '${DEPLOYER_HOSTNAME}' inside nested VM..."
deployer_vmid=$(nested_ssh "pct list 2>/dev/null | awk -v h='${DEPLOYER_HOSTNAME}' 'NR>1 && \$2==\"running\" && \$NF==h{print \$1; exit}'" \
    | tr -d '[:space:]')
if [ -z "$deployer_vmid" ]; then
    error "no running container '${DEPLOYER_HOSTNAME}' in nested VM. Run step2b-install-deployer.sh first."
fi
if [ -n "${DEPLOYER_VMID:-}" ] && [ "$deployer_vmid" != "$DEPLOYER_VMID" ]; then
    info "deployerVmid=${DEPLOYER_VMID} in config but actual VMID is ${deployer_vmid} — using actual"
fi
success "Deployer VMID: ${deployer_vmid}"

# Mirror livetest-local/shared/ into the Hub's /config/shared/ via tar |
# pct exec ... | tar so the whole subtree transfers in one shot. The
# Hub-side rm -rf + extract keeps the destination an exact mirror of the
# source (files removed locally disappear on the Hub too).
info "Syncing livetest-local/shared/ → Hub LXC ${deployer_vmid} /config/shared/"
# Suppress macOS resource-fork sidecar files (._*) that bsdtar would otherwise
# pack as pax extended headers — these materialise on the Linux extract side
# as zero-content "._<filename>" files, which the deployer then tries to load
# as JSON templates and crashes.
#   - COPYFILE_DISABLE=1 stops bsdtar from embedding the metadata at create
#   - --exclude='._*' belt-and-braces in case the env var doesn't kick in
# Without this, every run on a Mac risks killing the Hub deployer at startup.
COPYFILE_DISABLE=1 tar -C "$PROJECT_ROOT/livetest-local" --exclude='._*' -czf - shared \
    | nested_ssh "pct exec ${deployer_vmid} -- sh -c 'rm -rf /config/shared && mkdir -p /config && tar -xzf - -C /config && find /config/shared -name \"._*\" -delete && chown -R \$(stat -c %u:%g /config) /config/shared'" \
    || error "Failed to sync livetest-local/shared/ into Hub LXC ${deployer_vmid}"
success "Hub /config/shared synced from livetest-local/shared/"

# Trigger a deployer reload so any new/changed templates land in
# PersistenceManager without a container restart. The Hub API is reachable
# via the port-forward on $PVE_HOST:$PORT_DEPLOYER (HTTP) or
# :$PORT_DEPLOYER_HTTPS. Non-fatal — defaults pick up at next restart if
# the API isn't ready yet.
info "Reloading deployer (Hub) via port-forward..."
reload_code=$(curl -sk --max-time 10 -X POST \
    "https://${PVE_HOST}:${PORT_DEPLOYER_HTTPS}/api/reload" \
    -o /tmp/test-reload.json -w '%{http_code}' 2>/dev/null || echo "000")
if [ "$reload_code" != "200" ]; then
    reload_code=$(curl -s --max-time 10 -X POST \
        "http://${PVE_HOST}:${PORT_DEPLOYER}/api/reload" \
        -o /tmp/test-reload.json -w '%{http_code}' 2>/dev/null || echo "000")
fi
if [ "$reload_code" = "200" ]; then
    success "Deployer reloaded — defaults active for next install/reconfigure"
else
    info "Deployer /api/reload returned HTTP ${reload_code}; defaults will pick up at the next deployer restart"
fi
