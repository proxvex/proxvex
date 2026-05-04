#!/bin/bash
# step2a-setup-mirrors.sh - Install Docker + registry mirrors on the nested VM
#
# This script:
# 1. Rolls back to step1 'baseline' snapshot (clean state)
# 2. Installs Docker inside the nested VM
# 3. Pushes the proxvex CA from the PVE host into the nested VM trust store
#    so TLS to the production Docker Hub mirror (192.168.4.45) validates
# 4. Tears down any obsolete local dockerhub-mirror container, then starts
#    only the local ghcr.io pull-through mirror (10.0.0.2). Docker Hub pulls
#    are routed via DNS to the production mirror at 192.168.4.45.
# 5. Pre-pulls all images referenced by json/shared/scripts/library/versions.sh
#    transparently through the mirrors (Docker Hub via the production cache,
#    ghcr.io via the local cache)
# 6. Wires up dnsmasq so LXC containers resolve registry hostnames to the
#    correct mirrors (registry-1.docker.io/index.docker.io -> 192.168.4.45;
#    ghcr.io -> 10.0.0.2)
# 7. Creates the 'mirrors-ready' snapshot so step2b can roll back to a clean
#    environment with pre-filled / cached mirrors
#
# Prerequisites:
#   - production/setup-pve-host.sh <PVE_HOST> must have run on the PVE host so
#     /usr/local/share/ca-certificates/proxvex-ca.crt is in place.
#   - production/setup-production.sh --step 5 must have completed so the
#     docker-registry-mirror LXC at 192.168.4.45 is running and reachable from
#     the nested VM.
#
# Idempotency:
#   The 'mirrors-ready' snapshot description carries a short hash of
#   json/shared/scripts/library/versions.sh AND a schema tag. If both match the
#   current state, the script exits immediately without rollback or re-pull.
#   Pass --force to bypass the check and rebuild from baseline. The schema tag
#   is bumped on breaking topology changes (e.g. switching to the production
#   Docker Hub mirror) so old snapshots get invalidated automatically.
#
# Usage:
#   ./step2a-setup-mirrors.sh [instance] [--force]
#
# Run this once per environment (per instance). step2b requires the
# 'mirrors-ready' snapshot and aborts if it is missing.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

INSTANCE_ARG=""
FORCE=false
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=true ;;
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

nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
}
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

header "Step 2a: Install Docker + registry mirrors on nested VM"
echo "Instance:   $E2E_INSTANCE"
echo "Connection: $PVE_HOST:$PORT_PVE_SSH -> $NESTED_IP:22"
echo "Test VMID:  $TEST_VMID"

# Compute a short hash of versions.sh — stored in the mirrors-ready snapshot
# description so repeated runs can detect "nothing changed" and exit fast.
VERSIONS_FILE="$PROJECT_ROOT/json/shared/scripts/library/versions.sh"
if [ -f "$VERSIONS_FILE" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
        VERSIONS_HASH=$(sha256sum "$VERSIONS_FILE" | cut -c1-16)
    else
        VERSIONS_HASH=$(shasum -a 256 "$VERSIONS_FILE" | cut -c1-16)
    fi
else
    VERSIONS_HASH="none"
fi
echo "versions.sh: $VERSIONS_HASH"
echo ""

# Schema tag for the mirrors-ready snapshot. Bump when changing topology in a
# way that requires a forced rebuild (e.g. switching the Docker Hub source).
# v1               = local dockerhub-mirror + local ghcr-mirror
# v2-prod-mirror   = production mirror for Docker Hub + local ghcr-mirror
# v3-ghcr-on-outer = production mirror for Docker Hub + ghcr-mirror LXC on
#                    the outer PVE host (no nested ghcr-mirror container,
#                    no `insecure-registries`, valid TLS via proxvex CA)
SCHEMA_VERSION="v3-ghcr-on-outer"

# Step 0: idempotency check — only skip when BOTH versions-hash AND schema match.
# A schema mismatch forces a rebuild even if versions.sh is unchanged, so a
# topology change like the dockerhub-mirror migration is picked up automatically.
if [ "$FORCE" != "true" ]; then
    snap_desc=$(pve_ssh "qm listsnapshot $TEST_VMID 2>/dev/null" | grep -E 'mirrors-ready[[:space:]]' || true)
    if echo "$snap_desc" | grep -q "versions-hash=${VERSIONS_HASH}" \
        && echo "$snap_desc" | grep -q "schema=${SCHEMA_VERSION}"; then
        info "mirrors-ready already reflects current versions.sh (hash=${VERSIONS_HASH}, schema=${SCHEMA_VERSION}) — nothing to do"
        exit 0
    fi
fi

# Step 1: Rollback to baseline snapshot (clean state from step1)
info "Rolling back to baseline snapshot for clean mirror setup..."
if ! pve_ssh "qm listsnapshot $TEST_VMID 2>/dev/null | grep -q baseline"; then
    error "baseline snapshot missing on VM $TEST_VMID — run step1-create-vm.sh first"
fi
pve_ssh "qm shutdown $TEST_VMID --timeout 30" 2>/dev/null || true
for i in $(seq 1 30); do
    pve_ssh "qm status $TEST_VMID 2>/dev/null" | grep -q stopped && break
    sleep 1
done
# Drop downstream snapshots so rollback to baseline is allowed.
pve_ssh "qm delsnapshot $TEST_VMID deployer-installed 2>/dev/null || true"
pve_ssh "qm delsnapshot $TEST_VMID mirrors-ready 2>/dev/null || true"
pve_ssh "qm rollback $TEST_VMID baseline"
pve_ssh "qm start $TEST_VMID"
success "Rolled back to baseline"

# Step 2: Wait for SSH
info "Waiting for SSH connection to nested VM..."
SSH_READY=false
for i in $(seq 1 60); do
    if nested_ssh "echo ok" &>/dev/null; then
        SSH_READY=true; break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for SSH... %ds" "$i"
    sleep 1
done
echo ""
[ "$SSH_READY" = "true" ] || error "Cannot connect to nested VM via $PVE_HOST:$PORT_PVE_SSH after 60s"
success "SSH connection verified"

# Step 2.5: Pre-flight — check that step1 actually finished. step1 installs
# dnsmasq + writes /etc/dnsmasq.d/e2e-nat.conf in its Step 10d. If those are
# missing, the dnsmasq-redirect block below would silently produce a half-
# broken VM. Fail fast with a clear hint instead.
header "Verifying step1 prerequisites"
missing=$(nested_ssh '
    out=""
    systemctl list-unit-files dnsmasq.service 2>/dev/null | grep -q "^dnsmasq.service" || out="$out dnsmasq.service"
    [ -d /etc/dnsmasq.d ] || out="$out /etc/dnsmasq.d"
    [ -f /etc/dnsmasq.d/e2e-nat.conf ] || out="$out /etc/dnsmasq.d/e2e-nat.conf"
    printf "%s" "$out" | sed "s/^ //"
') || error "Pre-flight check failed (could not query nested VM)."
if [ -n "$missing" ]; then
    error "step1 did not finish provisioning the nested VM — missing: $missing
    Run ./e2e/step1-create-vm.sh $E2E_INSTANCE first (or re-run if it aborted partway)."
fi
success "step1 prerequisites OK (dnsmasq installed + e2e-nat.conf present)"

# Step 3: Install Docker on the nested VM (runtime for the mirror containers).
# Repoint apt to a European Debian mirror first — same sed as step1, but
# idempotent and applied here too so VMs created before the step1 fix (or
# from older snapshots) don't suffer through the slow default deb.debian.org
# during `apt-get install docker.io`. No-op when already pointing at
# mirror.23m.com.
header "Installing Docker on nested VM"
nested_ssh '
    if [ -f /etc/apt/sources.list.d/debian.sources ] && \
       grep -q "URIs:[[:space:]]*http://deb.debian.org/debian" /etc/apt/sources.list.d/debian.sources; then
        sed -i "s|URIs: http://deb.debian.org/debian|URIs: http://mirror.23m.com/debian|g" /etc/apt/sources.list.d/debian.sources
        echo "  Switched debian.sources -> mirror.23m.com" >&2
    fi
    if [ -s /etc/apt/sources.list ] && grep -q "deb.debian.org" /etc/apt/sources.list; then
        sed -i "s|deb.debian.org|mirror.23m.com|g" /etc/apt/sources.list
        echo "  Switched sources.list -> mirror.23m.com" >&2
    fi
'
nested_ssh "command -v docker >/dev/null 2>&1 || {
    set -e
    # Drain background apt-daily / unattended-upgrades that may still hold
    # the lock — fail loud after 120s rather than collide silently.
    for i in \$(seq 1 120); do
        pgrep -f 'apt-get|dpkg|unattended-upgrade|apt.systemd.daily' >/dev/null || break
        sleep 1
    done
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 update -qq >&2
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y -qq docker.io >&2
}"
success "Docker available on nested VM"

# Pre-pull the registry image itself (used for the local ghcr-mirror, and as
# a small first-pull warm-up before any dnsmasq redirect is in place)
nested_ssh "docker image inspect distribution/distribution:3.0.0 >/dev/null 2>&1 || \
    docker pull distribution/distribution:3.0.0 >&2"
success "Mirror image available"

# Step 3.5: Verify production Docker Hub mirror reachability from the nested
# VM and push the proxvex CA into the nested VM's trust store. The production
# mirror at 192.168.4.45 presents a TLS cert signed by the proxvex CA with
# SANs registry-1.docker.io / index.docker.io, so we need both: routing (the
# pre-flight curl) and trust (the CA install).
header "Verifying production Docker Hub mirror + installing proxvex CA"
PROD_MIRROR_IP="192.168.4.45"
nested_ssh "curl -ksf --connect-timeout 5 https://$PROD_MIRROR_IP/v2/ >/dev/null" \
    || error "Production Docker Hub mirror at $PROD_MIRROR_IP unreachable from nested VM.
    - Check pve1.cluster's docker-registry-mirror LXC is running:
        ssh root@pve1.cluster 'pct list | grep docker-registry-mirror'
    - Verify routing from nested VM to 192.168.4.0/24 (POSTROUTING MASQUERADE
      on PVE host should cover this — see step1-create-vm.sh).
    - production/setup-production.sh --step 5 must have completed."

CA_HOST_PATH="/usr/local/share/ca-certificates/proxvex-ca.crt"
pve_ssh "[ -f $CA_HOST_PATH ]" \
    || error "proxvex CA missing on PVE host at $CA_HOST_PATH.
    Run production/setup-pve-host.sh \$PVE_HOST first."
CA_B64=$(pve_ssh "base64 < $CA_HOST_PATH | tr -d '\n'")
[ -n "$CA_B64" ] || error "proxvex CA on PVE host is empty"

# Idempotent install: only run update-ca-certificates if the cert content
# changed. Same pattern as production/setup-pve-host.sh:103-117.
nested_ssh "
    CA_TARGET=/usr/local/share/ca-certificates/proxvex-ca.crt
    TMP=\$(mktemp)
    printf '%s' '$CA_B64' | base64 -d > \"\$TMP\"
    if [ -f \"\$CA_TARGET\" ] && cmp -s \"\$TMP\" \"\$CA_TARGET\"; then
        rm -f \"\$TMP\"
        echo '  CA unchanged'
    else
        mkdir -p /usr/local/share/ca-certificates
        mv \"\$TMP\" \"\$CA_TARGET\"
        update-ca-certificates >/dev/null 2>&1
        echo '  CA installed and trust store updated'
    fi
"
success "Production mirror reachable; proxvex CA in nested VM trust store"

# Step 4: Verify the ghcr.io mirror on the outer PVE host is reachable.
# As of schema v3-ghcr-on-outer the ghcr-mirror lives outside the nested VM
# (a proxvex-managed LXC on ubuntupve, deployed by
# production/setup-ghcr-mirror.sh — i.e. setup-production.sh Step 17). It
# has a TLS cert signed by the proxvex CA (already imported above), so the
# nested VM's docker daemon can talk to it via plain HTTPS — no
# `insecure-registries` hack, no per-LXC daemon.json.
header "Verifying outer ghcr.io mirror"
GHCR_MIRROR_IP="${GHCR_MIRROR_IP:-192.168.4.48}"
for i in $(seq 1 10); do
    nested_ssh "curl -sf --resolve ghcr.io:443:$GHCR_MIRROR_IP \
        https://ghcr.io/v2/ >/dev/null 2>&1" && break
    sleep 1
done
nested_ssh "curl -sf --resolve ghcr.io:443:$GHCR_MIRROR_IP \
    https://ghcr.io/v2/ >/dev/null 2>&1" \
    || error "ghcr.io mirror at $GHCR_MIRROR_IP unreachable from nested VM.
    - Run ./production/setup-production.sh --step 17 on pve1 (or
      ./production/setup-ghcr-mirror.sh standalone) to deploy the
      ghcr-registry-mirror LXC.
    - Verify routing from nested VM to 192.168.4.0/24 (POSTROUTING MASQUERADE
      on PVE host should cover this — see step1-create-vm.sh).
    - Check the LXC's TLS cert SAN includes 'DNS:ghcr.io'."
success "Outer ghcr.io mirror reachable at $GHCR_MIRROR_IP (TLS via proxvex CA)"

# Tear down any leftovers from the older v2-prod-mirror schema (local
# ghcr-mirror container on 10.0.0.2, vmbr1 alias service, dockerhub-mirror).
# Idempotent — silently no-ops on a clean nested VM.
header "Cleaning up legacy local mirrors (v2-prod-mirror leftovers)"
nested_ssh "
    set -e
    if docker ps -aq -f name='^ghcr-mirror\$' | grep -q .; then
        docker rm -f ghcr-mirror >/dev/null 2>&1 || true
        echo '  Removed local ghcr-mirror container (now lives on outer PVE host)'
    fi
    docker volume rm ghcr-mirror-data 2>/dev/null && \
        echo '  Removed obsolete ghcr-mirror-data volume' || true

    if docker ps -aq -f name='^dockerhub-mirror\$' | grep -q .; then
        docker rm -f dockerhub-mirror >/dev/null 2>&1 || true
        echo '  Removed obsolete dockerhub-mirror container'
    fi
    docker volume rm dockerhub-mirror-data 2>/dev/null && \
        echo '  Removed obsolete dockerhub-mirror-data volume' || true

    if systemctl list-unit-files vmbr1-ghcr-alias.service 2>/dev/null | grep -q vmbr1-ghcr-alias; then
        systemctl disable --now vmbr1-ghcr-alias.service 2>/dev/null || true
        rm -f /etc/systemd/system/vmbr1-ghcr-alias.service
        systemctl daemon-reload
        echo '  Removed vmbr1-ghcr-alias.service'
    fi
    ip addr show vmbr1 2>/dev/null | grep -q '10.0.0.2/' && \
        ip addr del 10.0.0.2/24 dev vmbr1 2>/dev/null && \
        echo '  Removed 10.0.0.2/24 alias from vmbr1' || true

    # daemon.json: drop the insecure-registries entry (no longer needed —
    # outer mirror has valid proxvex-CA TLS). Empty file or absence is fine.
    if [ -f /etc/docker/daemon.json ] \
       && grep -q 'insecure-registries' /etc/docker/daemon.json 2>/dev/null; then
        rm -f /etc/docker/daemon.json
        systemctl restart docker >/dev/null 2>&1 || true
        for i in \$(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
        echo '  Removed daemon.json (insecure-registries no longer needed)'
    fi
"
success "Legacy local mirrors cleaned up"

info "Waiting for mirrors to be healthy..."
# Production Docker Hub mirror via TLS-correct hostname (--resolve sidesteps
# dnsmasq, which is not yet writing the redirect at this point in the script).
for i in $(seq 1 10); do
    nested_ssh "curl -sf --resolve registry-1.docker.io:443:$PROD_MIRROR_IP \
        https://registry-1.docker.io/v2/ >/dev/null 2>&1" && break
    sleep 1
done
success "Mirrors healthy (ghcr.io @ $GHCR_MIRROR_IP, Docker Hub @ $PROD_MIRROR_IP)"

# Step 5: dnsmasq redirects so LXC containers AND the nested-VM Docker daemon
# resolve registry hostnames to the right mirror.
#  - registry-1.docker.io / index.docker.io -> 192.168.4.45 (production mirror,
#    TLS via proxvex CA already in trust store)
#  - ghcr.io                                -> $GHCR_MIRROR_IP (proxvex-managed
#    LXC on outer PVE host, TLS via proxvex CA)
# Block AAAA for these hosts so Go's net-resolver cannot bypass via IPv6.
#
# Idempotent replace: a BEGIN/END fence lets re-runs (or schema migrations)
# rewrite the block in place, instead of leaving stale 10.0.0.2 lines behind.
header "Wiring dnsmasq registry redirects"
nested_ssh "
    cfg=/etc/dnsmasq.d/e2e-nat.conf
    if [ -f \"\$cfg\" ]; then
        # Drop any previous block — both fenced and legacy un-fenced lines.
        sed -i '/# === proxvex E2E registry redirects BEGIN ===/,/# === proxvex E2E registry redirects END ===/d' \"\$cfg\"
        sed -i '/^# Registry mirror redirects/d' \"\$cfg\"
        sed -i '/^address=\\/registry-1\\.docker\\.io\\//d' \"\$cfg\"
        sed -i '/^address=\\/index\\.docker\\.io\\//d' \"\$cfg\"
        sed -i '/^address=\\/ghcr\\.io\\//d' \"\$cfg\"
    fi
    cat >> \"\$cfg\" <<DNS
# === proxvex E2E registry redirects BEGIN ===
# Docker Hub -> production mirror (TLS validated via proxvex CA)
address=/registry-1.docker.io/$PROD_MIRROR_IP
address=/index.docker.io/$PROD_MIRROR_IP
# ghcr.io -> proxvex-managed mirror on outer PVE host (TLS via proxvex CA)
address=/ghcr.io/$GHCR_MIRROR_IP
# Block IPv6 so Go's net-resolver cannot bypass the redirect via AAAA
address=/registry-1.docker.io/::
address=/index.docker.io/::
address=/ghcr.io/::
# === proxvex E2E registry redirects END ===
DNS
    systemctl restart dnsmasq
"
success "dnsmasq registry redirects configured (Docker Hub -> $PROD_MIRROR_IP, ghcr.io -> $GHCR_MIRROR_IP)"

# Step 6: Pre-pull images through the mirrors (the expensive part; ~15 min on
# a first cold run, near-instant on warm cache). Pulls go transparently via
# dnsmasq: Docker Hub through $PROD_MIRROR_IP, ghcr.io through $GHCR_MIRROR_IP.
# Both mirrors present TLS certs signed by the proxvex CA (already in the
# nested VM's trust store), so docker pull validates without any per-image
# special-casing. The first time a tag is pulled in the whole fleet, the
# upstream mirror fetches it once — every subsequent pull (any instance) is
# a hit.
header "Pre-pulling images through mirrors"
VERSIONS_FILE="$PROJECT_ROOT/json/shared/scripts/library/versions.sh"
if [ -f "$VERSIONS_FILE" ]; then
    . "$VERSIONS_FILE"
    grep '_TAG=.*#' "$VERSIONS_FILE" | while IFS= read -r line; do
        var=$(echo "$line" | sed 's/=.*//')
        image=$(echo "$line" | sed 's/.*# *//')
        tag=$(eval echo "\$$var")
        [ -z "$tag" ] && continue
        full="${image}:${tag}"
        info "  Pulling $full ..."
        # dnsmasq + proxvex-CA TLS cover both registries — no per-host branch.
        nested_ssh "docker pull '$full'" < /dev/null 2>&1 \
            || echo "    Warning: $full failed"
    done
    success "Image pre-pull complete"
else
    info "versions.sh not found, skipping pre-pull"
fi

# Step 7: Snapshot — VM must be stopped for a clean snapshot.
header "Creating 'mirrors-ready' snapshot"
info "Stopping nested VM $TEST_VMID..."
pve_ssh "qm shutdown $TEST_VMID --timeout 60"
for i in $(seq 1 60); do
    pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null && break
    sleep 1
done
pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null \
    || error "VM $TEST_VMID did not shut down cleanly — cannot create reliable snapshot"

pve_ssh "qm delsnapshot $TEST_VMID mirrors-ready 2>/dev/null || true"
pve_ssh "qm snapshot $TEST_VMID mirrors-ready --description 'Nested VM with Docker + production-mirror trust + ghcr.io mirror; versions-hash=${VERSIONS_HASH}; schema=${SCHEMA_VERSION}'"
success "Snapshot 'mirrors-ready' created (versions-hash=${VERSIONS_HASH}, schema=${SCHEMA_VERSION})"

pve_ssh "qm start $TEST_VMID"

TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Step 2a complete in ${TOTAL_TIME}${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Next: ./step2b-install-deployer.sh $E2E_INSTANCE"
