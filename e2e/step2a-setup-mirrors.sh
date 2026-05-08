#!/bin/bash
# step2a-setup-mirrors.sh - Install Docker + registry mirrors on the nested VM
#
# This script:
# 1. Rolls back to step1 'baseline' snapshot (clean state)
# 2. Repoints apt to a fast EU mirror (mirror.23m.com) so the skopeo
#    install in step 5 is fast. No Docker daemon is installed in the
#    nested VM — apps are LXCs (deployer-managed), not docker-compose
#    services here.
# 3. Verifies the test Docker Hub mirror (docker-mirror-test on ubuntupve,
#    192.168.4.49) is reachable; the proxvex CA was baked into the nested
#    VM trust store at baseline so TLS just works.
# 4. Verifies the ghcr.io mirror (ghcr-mirror on ubuntupve, 192.168.4.48)
#    is reachable.
# 5. Wires registry routing in the nested VM:
#      - dnsmasq adds A-record `docker-mirror-test → 192.168.4.49` and
#        keeps the DNS-redirect `ghcr.io → 192.168.4.48` (Docker Hub
#        registry-mirrors only spiegelt Docker Hub, not ghcr).
#      - skopeo is installed; /etc/containers/registries.conf points
#        docker.io at `${TEST_MIRROR_HOST}` for any pull through skopeo
#        (used by step2b-install-deployer.sh, install-ci.sh, and the
#        deployer's own image pipeline once it's installed in step2b).
# 6. Smoketests:
#      a) curl https://${TEST_MIRROR_HOST}/v2/ via dnsmasq (proves DNS+TLS).
#      b) skopeo inspect docker://docker.io/library/alpine:latest (proves
#         registries.conf routing — alpine is in versions.sh, so it's
#         already in the mirror's cache after reseed).
# 7. Creates the 'mirrors-ready' snapshot so step2b can roll back to a
#    clean environment with the mirror routing already wired.
#
# No images are pulled by this script. The test mirror's cache is filled
# by production/reseed-docker-mirror-test.sh (ZFS replication from the
# prod mirror on pve1) — that's the only place where Docker Hub pulls
# happen, and only when reseed is invoked.
#
# Prerequisites:
#   - production/setup-pve-host.sh <PVE_HOST> must have run so the proxvex CA
#     ends up in the nested VM trust store at baseline creation time.
#   - production/setup-production.sh --step 18 must have completed so the
#     docker-mirror-test LXC at 192.168.4.49 (ubuntupve) is running and
#     reachable from the nested VM. (production/setup-production.sh --step 5
#     on pve1 is no longer required by this script — the prod mirror stays
#     for production workloads but is unused by the test path.)
#   - production/reseed-docker-mirror-test.sh has run at least once so the
#     test mirror has alpine:latest cached for the smoketest.
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

# Source the pve-ops abstraction so qm calls go through PVE_USE_API toggle.
# After Phase A2 step2a has no outer-host SSH at all — qm via API, CA was
# baked into the baseline by step1, mirror checks happen via nested_ssh.
# shellcheck source=lib/pve-ops.sh
. "$SCRIPT_DIR/lib/pve-ops.sh"

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
# v1                       = local dockerhub-mirror + local ghcr-mirror
# v2-prod-mirror           = production mirror for Docker Hub + local ghcr-mirror
# v3-ghcr-on-outer         = production mirror for Docker Hub + ghcr-mirror LXC on
#                            the outer PVE host (no nested ghcr-mirror container,
#                            no `insecure-registries`, valid TLS via proxvex CA)
# v4-registry-mirrors      = test mirror (docker-mirror-test on ubuntupve, 192.168.4.49)
#                            replaces the prod mirror for Docker Hub. Clients use
#                            standard `registry-mirrors` (daemon.json) +
#                            `[[registry.mirror]]` (registries.conf) by hostname
#                            instead of dnsmasq DNS-redirect on docker.io. ghcr.io
#                            keeps its DNS-redirect (Docker registry-mirrors only
#                            spiegelt Docker Hub).
SCHEMA_VERSION="v4-registry-mirrors"

# Step 0: idempotency check — only skip when BOTH versions-hash AND schema match.
# A schema mismatch forces a rebuild even if versions.sh is unchanged, so a
# topology change like the dockerhub-mirror migration is picked up automatically.
if [ "$FORCE" != "true" ]; then
    snap_desc=$(pve_qm_snapshot_description "$TEST_VMID" mirrors-ready || true)
    if echo "$snap_desc" | grep -q "versions-hash=${VERSIONS_HASH}" \
        && echo "$snap_desc" | grep -q "schema=${SCHEMA_VERSION}"; then
        info "mirrors-ready already reflects current versions.sh (hash=${VERSIONS_HASH}, schema=${SCHEMA_VERSION}) — nothing to do"
        exit 0
    fi
fi

# Step 1: Rollback to baseline snapshot (clean state from step1)
info "Rolling back to baseline snapshot for clean mirror setup..."
if ! pve_qm_snapshot_exists "$TEST_VMID" baseline; then
    error "baseline snapshot missing on VM $TEST_VMID — run step1-create-vm.sh first"
fi
pve_qm_shutdown "$TEST_VMID" 30 2>/dev/null || true
for i in $(seq 1 30); do
    pve_qm_is_stopped "$TEST_VMID" && break
    sleep 1
done
# Drop downstream snapshots so rollback to baseline is allowed.
pve_qm_snapshot_delete "$TEST_VMID" deployer-installed
pve_qm_snapshot_delete "$TEST_VMID" mirrors-ready
pve_qm_snapshot_rollback "$TEST_VMID" baseline
pve_qm_start "$TEST_VMID"
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

# Step 3: Repoint apt to a European Debian mirror so the skopeo install
# below is fast — same sed as step1, idempotent, applied here too so VMs
# from older baselines (pre-step1-fix) don't fall back to the slow default
# deb.debian.org. Docker itself is NOT installed in the nested VM anymore:
# the deployer creates LXCs (no docker daemon needed at this layer), and
# pull-through caching is handled by the docker-mirror-test LXC on ubuntupve
# whose cache is bootstrapped via production/reseed-docker-mirror-test.sh
# from the prod mirror — no per-image pulls from Docker Hub during step2a,
# so no rate-limit risk on iteration.
header "Configuring apt mirror on nested VM"
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
success "apt repointed to mirror.23m.com"

# Step 3.5: Verify the test Docker Hub mirror (docker-mirror-test on ubuntupve)
# is reachable from the nested VM. As of schema v4-registry-mirrors the prod
# mirror on pve1 (192.168.4.45) is no longer used by the test path — everything
# for tests sits on a single physical host (ubuntupve). The test mirror at
# 192.168.4.49 presents a TLS cert signed by the proxvex CA (baked into the
# nested VM trust store at baseline creation, step1-create-vm.sh Phase A2).
# Routing 10.99.X.0/24 → 192.168.4.0/24 is handled by POSTROUTING MASQUERADE
# on the outer PVE host (step1-create-vm.sh).
TEST_MIRROR_IP="${TEST_MIRROR_IP:-192.168.4.49}"
TEST_MIRROR_HOST="${TEST_MIRROR_HOST:-docker-mirror-test}"
header "Verifying test Docker Hub mirror (${TEST_MIRROR_HOST} @ ${TEST_MIRROR_IP})"
nested_ssh "curl -sf --connect-timeout 5 \
    --resolve ${TEST_MIRROR_HOST}:443:${TEST_MIRROR_IP} \
    https://${TEST_MIRROR_HOST}/v2/ >/dev/null" \
    || error "Test Docker Hub mirror ${TEST_MIRROR_HOST} (${TEST_MIRROR_IP}) unreachable from nested VM.
    - Deploy it: ./production/setup-production.sh --step 18
      (target host ubuntupve; see APP_HOST_MAP in setup-production.sh).
    - Check the LXC is running:
        ssh root@ubuntupve 'pct list | grep ${TEST_MIRROR_HOST}'
    - Verify routing 10.99.X.0/24 → 192.168.4.0/24 (POSTROUTING MASQUERADE
      on the outer PVE host — see step1-create-vm.sh).
    - Cert SAN must include 'DNS:${TEST_MIRROR_HOST}' (default for
      addon-ssl when ssl_additional_san is left empty)."

# Validate the proxvex CA is in the nested VM trust store (set up at
# baseline). If it's missing the baseline pre-dates Phase A2 — re-run
# step1-create-vm.sh to refresh, or for a one-off patch:
#   ssh root@$PVE_HOST "base64 < $CA_HOST_PATH" | nested_ssh "base64 -d > /usr/local/share/ca-certificates/proxvex-ca.crt && update-ca-certificates"
nested_ssh "[ -f /usr/local/share/ca-certificates/proxvex-ca.crt ]" \
    || error "proxvex CA missing in nested VM trust store. Re-run step1-create-vm.sh or manually patch the baseline."
success "Test mirror reachable; proxvex CA already trusted in nested VM"

# Step 4: Verify the ghcr.io mirror on the outer PVE host is reachable.
# As of schema v3-ghcr-on-outer the ghcr-mirror lives outside the nested VM
# (a proxvex-managed LXC on ubuntupve, deployed by
# production/setup-ghcr-mirror.sh — i.e. setup-production.sh Step 17). It
# has a TLS cert signed by the proxvex CA (already imported into the nested
# VM trust store at baseline). Skopeo + the deployer's pull pipeline use
# this hostname → IP mapping via dnsmasq (configured below).
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

# Step 5: dnsmasq + skopeo registries.conf so the nested VM (and any inner
# LXCs that inherit DNS via DHCP) routes registry traffic through the test
# mirror.
#
# Two complementary mechanisms — each registry uses the one that fits:
#  - Docker Hub: skopeo's [[registry.mirror]] in /etc/containers/registries.conf
#    pointing at `${TEST_MIRROR_HOST}` by hostname — cert SAN matches the
#    hostname (default addon-ssl behaviour; ssl_additional_san is empty in
#    production/docker-mirror-test.json).
#  - ghcr.io: dnsmasq DNS-redirect of `ghcr.io` directly to the ghcr-mirror
#    LXC IP. Cert SAN includes 'DNS:ghcr.io' on that LXC.
#
# Hostname resolution for `${TEST_MIRROR_HOST}` is added to dnsmasq so both
# the nested VM and inner LXCs (point at 10.0.0.1 for DNS) can resolve it.
#
# Note: the nested VM does NOT run a Docker daemon — apps deployed by the
# proxvex deployer are LXCs, not docker-compose services here. The test
# mirror's cache is populated via production/reseed-docker-mirror-test.sh
# from the prod mirror, so no per-image pulls happen during step2a (zero
# Docker Hub rate-limit cost on iteration).
#
# Idempotent replace: BEGIN/END fence lets re-runs or schema migrations
# rewrite the block in place; legacy un-fenced lines from older schemas
# are also stripped.
header "Wiring dnsmasq registry redirects + test-mirror hostname"
nested_ssh "
    cfg=/etc/dnsmasq.d/e2e-nat.conf
    if [ -f \"\$cfg\" ]; then
        # Drop any previous block — fenced and legacy un-fenced lines.
        sed -i '/# === proxvex E2E registry redirects BEGIN ===/,/# === proxvex E2E registry redirects END ===/d' \"\$cfg\"
        sed -i '/^# Registry mirror redirects/d' \"\$cfg\"
        sed -i '/^address=\\/registry-1\\.docker\\.io\\//d' \"\$cfg\"
        sed -i '/^address=\\/index\\.docker\\.io\\//d' \"\$cfg\"
        sed -i '/^address=\\/ghcr\\.io\\//d' \"\$cfg\"
        sed -i '/^address=\\/${TEST_MIRROR_HOST}\\//d' \"\$cfg\"
    fi
    cat >> \"\$cfg\" <<DNS
# === proxvex E2E registry redirects BEGIN ===
# Test Docker Hub mirror (LXC on ubuntupve). Resolved by hostname so the
# daemon.json registry-mirrors + skopeo registries.conf entries below
# match the mirror's TLS cert SAN.
address=/${TEST_MIRROR_HOST}/${TEST_MIRROR_IP}
address=/${TEST_MIRROR_HOST}/::
# ghcr.io -> proxvex-managed mirror on outer PVE host (TLS via proxvex CA).
# Docker registry-mirrors only spiegelt Docker Hub, so ghcr stays on DNS-redirect.
address=/ghcr.io/$GHCR_MIRROR_IP
address=/ghcr.io/::
# === proxvex E2E registry redirects END ===
DNS
    systemctl restart dnsmasq
"
success "dnsmasq configured (${TEST_MIRROR_HOST} -> ${TEST_MIRROR_IP}, ghcr.io -> $GHCR_MIRROR_IP)"

# Step 5c: install skopeo + write /etc/containers/registries.conf so that
# skopeo (used by step2b-install-deployer.sh, install-ci.sh, and the
# end-of-script smoketest) routes docker.io pulls through the same mirror.
# Skopeo doesn't read /etc/docker/daemon.json — it has its own conf format.
header "Installing skopeo + writing /etc/containers/registries.conf"
nested_ssh "
    set -e
    if ! command -v skopeo >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y -qq skopeo >&2
    fi
    mkdir -p /etc/containers
    cat > /etc/containers/registries.conf <<REG
unqualified-search-registries = ['docker.io']

[[registry]]
location = 'docker.io'

[[registry.mirror]]
location = '${TEST_MIRROR_HOST}'
REG
"
success "skopeo + /etc/containers/registries.conf wired (docker.io -> ${TEST_MIRROR_HOST})"

# Step 6: Smoketests — three orthogonal checks that the test mirror is wired
# up correctly. No per-image pulls; the mirror's cache is filled by the
# reseed script (production/reseed-docker-mirror-test.sh) so we don't pay
# Docker Hub rate-limit for these probes either.
#
# 1. Direct TLS handshake against the mirror (already done in Step 3.5 above
#    via --resolve, so we just probe via dnsmasq this time — proves DNS works).
# 2. Skopeo inspect of an Image already in the prod mirror cache (alpine:latest
#    is part of versions.sh and was reseeded). Proves registries.conf routes
#    docker.io to ${TEST_MIRROR_HOST}.
# 3. Skopeo inspect of an Image NOT necessarily in cache — pull-through still
#    works (mirror fetches from upstream, caches, returns). Optional; skip
#    if it costs a Docker Hub pull. Comment out to enable.
header "Smoketest: mirror reachability via dnsmasq"
nested_ssh "curl -sf --connect-timeout 5 https://${TEST_MIRROR_HOST}/v2/ >/dev/null" \
    || error "https://${TEST_MIRROR_HOST}/v2/ unreachable via dnsmasq.
    - Check the dnsmasq A-record: ssh -p $PORT_PVE_SSH root@$PVE_HOST 'getent hosts ${TEST_MIRROR_HOST}'
    - Verify the dnsmasq block was rewritten: grep ${TEST_MIRROR_HOST} /etc/dnsmasq.d/e2e-nat.conf"
success "Test mirror reachable via dnsmasq (TLS validated, hostname resolved)"

header "Smoketest: skopeo inspect via test mirror"
nested_ssh "skopeo inspect docker://docker.io/library/alpine:latest >/dev/null" \
    || error "skopeo inspect docker://docker.io/library/alpine:latest failed.
    - Inspect /etc/containers/registries.conf in the nested VM.
    - Check ${TEST_MIRROR_HOST} resolves: nslookup ${TEST_MIRROR_HOST}
    - Check the mirror has the image (cache):
        ssh root@ubuntupve 'pct exec \$(pct list | awk \"\\\$NF==\\\"${TEST_MIRROR_HOST}\\\"{print \\\$1}\") -- ls /var/lib/registry/docker/registry/v2/repositories/library/alpine 2>/dev/null'
      If empty, run: ./production/reseed-docker-mirror-test.sh"
success "Skopeo routes docker.io through ${TEST_MIRROR_HOST} (cache hit)"

# Step 7: Snapshot — VM must be stopped for a clean snapshot.
header "Creating 'mirrors-ready' snapshot"
info "Stopping nested VM $TEST_VMID..."
pve_qm_shutdown "$TEST_VMID" 60
for i in $(seq 1 60); do
    pve_qm_is_stopped "$TEST_VMID" && break
    sleep 1
done
pve_qm_is_stopped "$TEST_VMID" \
    || error "VM $TEST_VMID did not shut down cleanly — cannot create reliable snapshot"

pve_qm_snapshot_delete "$TEST_VMID" mirrors-ready
pve_qm_snapshot_create "$TEST_VMID" mirrors-ready "Nested VM with skopeo + registries.conf + dnsmasq pointing at docker-mirror-test/ghcr-mirror; versions-hash=${VERSIONS_HASH}; schema=${SCHEMA_VERSION}"
success "Snapshot 'mirrors-ready' created (versions-hash=${VERSIONS_HASH}, schema=${SCHEMA_VERSION})"

pve_qm_start "$TEST_VMID"

TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Step 2a complete in ${TOTAL_TIME}${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Next: ./step2b-install-deployer.sh $E2E_INSTANCE"
