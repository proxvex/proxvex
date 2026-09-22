#!/bin/bash
# >>> proxvex-cwd-guard (auto-generated) — repo-root cwd + absolute $0, any caller cwd
case "$0" in
  /*) _pvx_self="$0" ;;
  *)  _pvx_self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/$(basename "$0")" || { echo "FATAL cwd-guard: cannot resolve $0" >&2; exit 2; } ;;
esac
_pvx_rr="$(cd "$(dirname "$_pvx_self")/.." 2>/dev/null && pwd)" || { echo "FATAL cwd-guard: cannot resolve repo root from $0" >&2; exit 2; }
{ [ -f "$_pvx_rr/package.json" ] && [ -d "$_pvx_rr/e2e" ] && [ -d "$_pvx_rr/production" ]; } || { echo "FATAL cwd-guard: invalid repo root '$_pvx_rr' (from '$0')" >&2; exit 2; }
if [ "$0" != "$_pvx_self" ]; then cd "$_pvx_rr" && exec "$_pvx_self" "$@"; fi
cd "$_pvx_rr" || { echo "FATAL cwd-guard: cannot cd to '$_pvx_rr'" >&2; exit 2; }
unset _pvx_self _pvx_rr
# <<< proxvex-cwd-guard
# step2b-install-deployer.sh - Install proxvex into the nested VM
#
# Prerequisites:
#   - step1-create-vm.sh has run ('baseline' snapshot exists)
#   - step2a-setup-mirrors.sh has run ('mirrors-ready' snapshot exists)
#     The 'mirrors-ready' snapshot is required — this script does NOT rebuild
#     the mirrors if it is missing, because re-pulling all images hits Docker
#     Hub rate limits on repeated runs.
#
# This script:
# 1. Verifies 'mirrors-ready' exists and rolls back to it
# 2. Builds the proxvex Docker image locally (node:24-slim based)
# 3. Converts the local Docker image to an OCI-archive tarball via skopeo
# 4. Uploads the tarball to /tmp/ on the nested VM
# 5. Runs install-proxvex.sh --tarball to stage it into the template cache
#    and create the deployer LXC
# 6. Wires up port forwarding on the nested VM
# 7. Creates the 'deployer-installed' snapshot for livetests to roll back to
#
# Usage:
#   ./step2b-install-deployer.sh [instance] [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

VERBOSE=false
INSTANCE_ARG=""
for arg in "$@"; do
    case "$arg" in
        --verbose|-v) VERBOSE=true ;;
        -*) ;;
        *) [ -z "$INSTANCE_ARG" ] && INSTANCE_ARG="$arg" ;;
    esac
done

load_config "$INSTANCE_ARG"
NESTED_IP="$NESTED_STATIC_IP"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_START=$(date +%s)
STEP_START=$SCRIPT_START

elapsed() { echo "$(( $(date +%s) - SCRIPT_START ))s"; }
step_elapsed() {
    local now=$(date +%s)
    local step=$((now - STEP_START))
    STEP_START=$now
    echo "${step}s"
}

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1 ${CYAN}($(step_elapsed))${NC}"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }
header() {
    STEP_START=$(date +%s)
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
}

# nested_ssh / nested_scp_to / nested_scp_from come from lib/nested-ssh.sh.
# shellcheck source=lib/nested-ssh.sh
. "$SCRIPT_DIR/lib/nested-ssh.sh"

# Source the pve-ops abstraction so qm calls go through PVE_USE_API toggle.
# After Phase A2 step2b has no outer-host SSH at all — qm via API, scp
# directly into the nested VM through the port-forwarded SSH.
# shellcheck source=lib/pve-ops.sh
. "$SCRIPT_DIR/lib/pve-ops.sh"

header "Step 2b: Install proxvex"
echo "Instance:      $E2E_INSTANCE"
echo "Connection:    $PVE_HOST:$PORT_PVE_SSH -> $NESTED_IP:22"
echo "Deployer VMID: $DEPLOYER_VMID"
echo "Deployer URL:  $DEPLOYER_URL"
echo ""

# Per-instance identifiers so two step2b runs for different instances can
# coexist on the same dev machine and the same outer PVE host.
# The OCI tarball is staged into the nested VM at the canonical path used
# by build-proxvex-oci-image.sh; the Docker image tag follows the same
# pattern (encoded inside the helper).
TMP_OCI_NAME="proxvex-${E2E_INSTANCE}-redeploy.oci.tar"
TMP_INSTALL_NAME="install-proxvex-${E2E_INSTANCE}.sh"
TMP_SCRIPTS_NAME="proxvex-scripts-${E2E_INSTANCE}.tar.gz"
LOCAL_SCRIPTS_TARBALL="/tmp/${TMP_SCRIPTS_NAME}"

# Step 1: Verify 'mirrors-ready' snapshot exists (hard requirement — see header).
if ! pve_qm_snapshot_exists "$TEST_VMID" mirrors-ready; then
    error "'mirrors-ready' snapshot missing on VM $TEST_VMID — run ./step2a-setup-mirrors.sh $E2E_INSTANCE first"
fi

# Rollback to mirrors-ready for a clean, mirror-populated environment.
info "Rolling back to 'mirrors-ready' snapshot..."
pve_qm_shutdown "$TEST_VMID" 30 2>/dev/null || true
for i in $(seq 1 30); do
    pve_qm_is_stopped "$TEST_VMID" && break
    sleep 1
done
# Drop any existing deployer-installed snapshot — rollback requires it be absent.
pve_qm_snapshot_delete "$TEST_VMID" deployer-installed
pve_qm_snapshot_rollback "$TEST_VMID" mirrors-ready
pve_qm_start "$TEST_VMID"
success "Rolled back to 'mirrors-ready'"

# Step 2: Wait for SSH
info "Waiting for SSH connection to nested VM..."
SSH_READY=false
for i in $(seq 1 60); do
    if nested_ssh "echo ok" &>/dev/null; then SSH_READY=true; break; fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for SSH... %ds" "$i"
    sleep 1
done
echo ""
[ "$SSH_READY" = "true" ] || error "Cannot connect to nested VM via $PVE_HOST:$PORT_PVE_SSH after 60s"
success "SSH connection verified"

# Step 3: Build proxvex OCI image locally and stage into the nested VM cache.
# Shared helper handles pnpm build / npm pack / docker build / docker save /
# skopeo copy / scp / cache aliasing. Output is the path of the tarball on
# the nested VM, ready to hand to install-proxvex.sh --tarball.
header "Building local proxvex OCI image"
REMOTE_TARBALL="$("$SCRIPT_DIR/build-proxvex-oci-image.sh" "$E2E_INSTANCE")" \
    || error "build-proxvex-oci-image.sh failed"
[ -n "$REMOTE_TARBALL" ] || error "build helper produced no tarball path"
success "Tarball staged at $REMOTE_TARBALL on nested VM"

# Step 6: Copy local install-proxvex.sh + shared scripts directly to the
# nested VM (install-proxvex.sh's LOCAL_SCRIPT_PATH bypasses GitHub so the
# local fix under test is what runs).
LOCAL_SCRIPT_PATH="/tmp/proxvex-scripts-${E2E_INSTANCE}"
header "Copying install script + shared scripts to nested VM"
nested_scp_to "$PROJECT_ROOT/install-proxvex.sh" "/tmp/${TMP_INSTALL_NAME}" \
    || error "Failed to copy install-proxvex.sh to nested VM"

tar -czf "$LOCAL_SCRIPTS_TARBALL" -C "$PROJECT_ROOT" json/shared/scripts \
    || error "Failed to create scripts tarball"
nested_scp_to "$LOCAL_SCRIPTS_TARBALL" "/tmp/${TMP_SCRIPTS_NAME}" \
    || error "Failed to copy scripts tarball to nested VM"
nested_ssh "mkdir -p $LOCAL_SCRIPT_PATH && tar -xzf /tmp/${TMP_SCRIPTS_NAME} -C $LOCAL_SCRIPT_PATH" \
    || error "Failed to extract shared scripts on nested VM"
rm -f "$LOCAL_SCRIPTS_TARBALL"
success "install-proxvex.sh + shared scripts in place"

# Step 7: Run install-proxvex.sh with the local OCI template
header "Running install-proxvex.sh --tarball"
nested_ssh "chmod +x /tmp/${TMP_INSTALL_NAME} && \
    OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH \
    /tmp/${TMP_INSTALL_NAME} \
        --tarball $REMOTE_TARBALL \
        --vm-id $DEPLOYER_VMID \
        --bridge $DEPLOYER_BRIDGE \
        --static-ip $DEPLOYER_STATIC_IP \
        --gateway $DEPLOYER_GATEWAY \
        --nameserver $DEPLOYER_GATEWAY \
        --deployer-url $DEPLOYER_URL" \
    || error "install-proxvex.sh failed"
success "install-proxvex.sh completed"

# Step 8: Port forwarding on nested VM → deployer container
DEPLOYER_IP="${DEPLOYER_STATIC_IP%/*}"
header "Configuring port forwarding on nested VM"
nested_ssh "
  iptables -t nat -D PREROUTING -p tcp --dport 3080 -j DNAT --to-destination $DEPLOYER_IP:3080 2>/dev/null || true
  iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3080 -j ACCEPT 2>/dev/null || true
  iptables -t nat -D PREROUTING -p tcp --dport 3443 -j DNAT --to-destination $DEPLOYER_IP:3443 2>/dev/null || true
  iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3443 -j ACCEPT 2>/dev/null || true
  iptables -t nat -A PREROUTING -p tcp --dport 3080 -j DNAT --to-destination $DEPLOYER_IP:3080
  iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3080 -j ACCEPT
  iptables -t nat -A PREROUTING -p tcp --dport 3443 -j DNAT --to-destination $DEPLOYER_IP:3443
  iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3443 -j ACCEPT
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4
"
success "Nested VM :3080 → $DEPLOYER_IP:3080, :3443 → $DEPLOYER_IP:3443 (persisted)"

# Make the deployer hostname resolvable from sibling LXC containers.
# The deployer generates its base URL as http://$(hostname):3080 which becomes
# http://proxvex:3080 — other LXCs use this URL to fetch the CA cert (via
# `Trust Deployer CA`). Without a DNS entry, those containers get
# "Could not download CA certificate". Add it to dnsmasq and reload.
nested_ssh "
  cfg=/etc/dnsmasq.d/proxvex-deployer.conf
  {
    # Sibling LXCs use 'http://proxvex:3080' as deployer URL.
    # Use host-record (not address=) so the entry beats DHCP-derived
    # hostname leases from previous test containers — `address=/proxvex/…`
    # gets shadowed by stale DHCP leases for any container that briefly
    # ran with hostname 'proxvex'.
    echo 'host-record=proxvex,$DEPLOYER_IP'
    # 'docker-registry-mirror' is what registry-mirror-common.sh's mirror_detect
    # looks for. Point it at the PRODUCTION mirror (192.168.4.45) — its TLS
    # cert is signed by the proxvex CA, which step2a placed in the nested-VM
    # trust store and template 108 forwards into every test LXC.
    echo 'host-record=docker-registry-mirror,192.168.4.45'
  } > \$cfg
  # Full restart — SIGHUP/reload doesn't always pick up new files under
  # /etc/dnsmasq.d/ on this Proxmox install.
  systemctl restart dnsmasq 2>/dev/null || true
"
success "dnsmasq: proxvex → $DEPLOYER_IP"

# Step 9: Verify API before snapshotting
info "Verifying deployer API..."
api_ok=false
for i in $(seq 1 60); do
    if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    if nested_ssh "curl -sk --connect-timeout 1 https://$DEPLOYER_IP:3443/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" "$i"
    sleep 1
done
echo ""
[ "$api_ok" = "true" ] || error "Deployer API not reachable after 60s"
success "Deployer API is responding"

# Step 9b: Write project-level defaults BEFORE snapshotting so they survive
# every `qm rollback deployer-installed`. Without this, post-start-dockerd.sh
# composes /etc/docker/daemon.json without registry-mirrors, dockerd resolves
# registry-1.docker.io via dnsmasq → production mirror → HTTP/2 framing bug
# → 0-byte body on layer GET → `unexpected EOF` on every docker pull.
header "Writing project defaults into deployer (for snapshot)"
"$SCRIPT_DIR/setup-test-project.sh" "$E2E_INSTANCE" \
    || error "setup-test-project.sh failed — project defaults missing in snapshot"

# Step 9c: Pre-warm the OCI image cache so a `livetest --all` run does NOT trigger
# ~4 concurrent skopeo extractions on the 4-core/8GB nested VM. That resource
# spike (fresh multi-GB image downloads under concurrency) is what pushed deploys
# past the 600s CLI timeout and produced a spurious "mass break" (see memory:
# livetest-mass-break-is-environmental). Fetching serially here — then baking the
# tarballs into the deployer-installed snapshot below — means every rollback
# starts with a warm cache and each deploy's host-get-oci-image.py hits the cache.
# proxvex is deliberately excluded (see e2e/prewarm-images.lst) so proxvex/*
# scenarios keep exercising the skopeo download+extract branch.
header "Pre-warming OCI image cache (for snapshot)"
PREWARM_LST="$SCRIPT_DIR/prewarm-images.lst"
if [ -f "$PREWARM_LST" ]; then
    # host-get-oci-image.py declares `library: oci_version_lib.py`; libraries are
    # prepended before execution, so build the runnable file the same way and ship
    # it once. The {{ oci_image }} etc. placeholders are substituted per image on
    # the nested VM (skopeo's own {{json .}} template is left intact).
    PREWARM_PY="/tmp/prewarm-oci-${E2E_INSTANCE}.py"
    cat "$PROJECT_ROOT/json/shared/scripts/library/oci_version_lib.py" \
        "$PROJECT_ROOT/json/shared/scripts/image/host-get-oci-image.py" > "$PREWARM_PY" \
        || error "Failed to assemble pre-warm script"
    nested_scp_to "$PREWARM_PY" "/tmp/prewarm-oci.py" \
        || error "Failed to copy pre-warm script to nested VM"
    rm -f "$PREWARM_PY"
    prewarm_ok=0; prewarm_miss=0
    # Read the list on FD 3 — nested_ssh (ssh) reads FD 0, so a plain
    # `done < file` would let the first ssh slurp the rest of the list and the
    # loop would run exactly once.
    while IFS= read -r ref <&3; do
        case "$ref" in ''|\#*) continue ;; esac
        if nested_ssh "sed -e 's|{{ oci_image }}|$ref|g' -e 's|{{ storage }}|local|g' -e 's|{{ platform }}||g' -e 's|{{ registry_username }}||g' -e 's|{{ registry_password }}||g' -e 's|{{ application_id }}||g' -e 's|{{ target_versions }}||g' /tmp/prewarm-oci.py > /tmp/prewarm-run.py && python3 /tmp/prewarm-run.py >/dev/null 2>&1"; then
            prewarm_ok=$((prewarm_ok + 1)); info "  cached: $ref"
        else
            # Non-fatal: a miss just means that image is fetched by skopeo at
            # deploy time (graceful — and keeps the skopeo branch a little warmer).
            prewarm_miss=$((prewarm_miss + 1)); info "  MISS (skopeo at deploy): $ref"
        fi
    done 3< "$PREWARM_LST"
    success "Pre-warm complete: $prewarm_ok cached, $prewarm_miss missed"
else
    info "No $PREWARM_LST — skipping OCI cache pre-warm"
fi

# Step 10: Snapshot — clean shutdown, then qm snapshot deployer-installed
header "Creating 'deployer-installed' snapshot"
info "Stopping nested VM $TEST_VMID..."
pve_qm_shutdown "$TEST_VMID" 60
for i in $(seq 1 60); do
    pve_qm_is_stopped "$TEST_VMID" && break
    sleep 1
done
pve_qm_is_stopped "$TEST_VMID" \
    || error "VM $TEST_VMID did not shut down cleanly — cannot create reliable snapshot"

pve_qm_snapshot_delete "$TEST_VMID" deployer-installed
pve_qm_snapshot_create "$TEST_VMID" deployer-installed "Nested VM with proxvex installed (step2b)"
success "Snapshot 'deployer-installed' created"

pve_qm_start "$TEST_VMID"
info "Waiting for deployer API after restart..."
api_ok=false
for i in $(seq 1 60); do
    if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    if nested_ssh "curl -sk --connect-timeout 1 https://$DEPLOYER_IP:3443/ 2>/dev/null" | grep -q "doctype"; then
        api_ok=true; break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" "$i"
    sleep 1
done
echo ""
[ "$api_ok" = "true" ] || error "Deployer API not reachable after VM restart"
success "Deployer API is ready"

# Step 11: Pre-install slow dependencies (currently: playwright/default and
# its transitive zitadel/default + postgres/default).
#
# Why here, after the deployer-installed snapshot:
#   - playwright/default pulls mcr.microsoft.com/playwright:v1.57.0-noble
#     (~1.5GB). No local registry mirror for mcr.microsoft.com exists, so
#     the pull goes over the double-NAT to Microsoft's CDN — easily 5+ min.
#   - During `/livetest --all` the runner kills any sub-step that produces
#     no stdout for 120s; the skopeo download is silent until each blob
#     boundary, so a single ~1GB layer triggers a kill mid-extract.
#   - step2b runs as a plain shell script with no watchdog, so the pull
#     and full install completes here.
#   - live-test-runner.mts creates dep-<app>-<variant> qm snapshots on
#     successful install. Subsequent `/livetest --all` runs roll back to
#     those snapshots instead of re-installing — fast and watchdog-safe.
#
# We patch e2e/config.json to nested-deployer mode (drop deployerHost +
# deployerPort) so the runner targets the in-VM Hub, not a local Spoke
# (no Spoke is running here), and restore on exit.
header "Pre-installing slow-dep container (playwright/default + transitive deps)"
PRE_INSTALL_BAK="$(mktemp -t step2b-cfg.XXXXXX)"
cp "$CONFIG_FILE" "$PRE_INSTALL_BAK"
trap 'cp "$PRE_INSTALL_BAK" "$CONFIG_FILE"; rm -f "$PRE_INSTALL_BAK"' EXIT INT TERM
jq --arg i "$E2E_INSTANCE" \
    'del(.instances[$i].deployerHost) | del(.instances[$i].deployerPort)' \
    "$PRE_INSTALL_BAK" > "$CONFIG_FILE"

(cd "$PROJECT_ROOT" && npx tsx backend/tests/livetests/src/live-test-runner.mts "$E2E_INSTANCE" playwright/default) \
    || error "Pre-install of playwright/default failed — see livetest-results/ for diagnostics"

cp "$PRE_INSTALL_BAK" "$CONFIG_FILE"
rm -f "$PRE_INSTALL_BAK"
trap - EXIT INT TERM
success "playwright/default + deps pre-installed (dep-*-default qm snapshots present)"

TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Step 2b complete in ${TOTAL_TIME}${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Instance:        $E2E_INSTANCE"
echo "Deployer HTTP:   $DEPLOYER_URL"
echo "Deployer HTTPS:  $DEPLOYER_HTTPS_URL"
echo "Deployer VMID:   $DEPLOYER_VMID"
echo ""
echo "Quick redeploy (same mirrors): ./step2b-install-deployer.sh $E2E_INSTANCE"
