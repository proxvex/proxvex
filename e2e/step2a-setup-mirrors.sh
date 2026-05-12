#!/bin/bash
# step2a-setup-mirrors.sh — wire registry mirrors into the nested VM.
#
# No software is installed by this script. Skopeo ships with PVE 9.1+, the
# proxvex CA is baked into the nested VM trust store at baseline, and the
# nested VM does not run a Docker daemon (deployer apps are LXCs, not
# docker-compose services). The script just rewires DNS + skopeo's
# registries.conf to route registry traffic through the test mirrors.
#
# This script:
# 1. Rolls back to step1 'baseline' snapshot (clean state)
# 2. Verifies the test Docker Hub mirror (docker-mirror-test on ubuntupve,
#    192.168.4.49) is reachable; the proxvex CA was baked into the nested
#    VM trust store at baseline so TLS just works.
# 3. Verifies the zot-mirror (project-zot/zot-based, ghcr.io upstream;
#    ubuntupve, 192.168.4.50) is reachable.
# 4. Wires registry routing in the nested VM:
#      - dnsmasq adds A-records `docker-mirror-test → 192.168.4.49` and
#        `zot-mirror → 192.168.4.50`, plus DNS-redirect `ghcr.io →
#        192.168.4.50` (Docker has no per-registry mirror switch for
#        ghcr.io, so DNS-redirect handles it transparently).
#      - /etc/containers/registries.conf points docker.io at
#        `${TEST_MIRROR_HOST}` for any pull through skopeo (used by
#        step2b-install-deployer.sh, install-ci.sh, and the deployer's
#        own image pipeline once it's installed in step2b). Skopeo itself
#        ships with Proxmox VE 9.1+ as a pve-manager dependency — no
#        install needed.
# 5. Smoketests:
#      a) curl https://${TEST_MIRROR_HOST}/v2/ via dnsmasq (proves DNS+TLS).
#      b) skopeo inspect docker://docker.io/library/alpine:latest (proves
#         registries.conf routing). On a cold mirror this triggers ONE
#         pull-through to Docker Hub for alpine — well within the 100/6h
#         anonymous limit. On a warm mirror it's a cache hit.
#      c) curl https://ghcr.io/v2/ — DNS-redirect lands at zot-mirror,
#         cert SAN includes DNS:ghcr.io, validates cleanly.
# 6. Creates the 'mirrors-ready' snapshot so step2b can roll back to a
#    clean environment with the mirror routing already wired.
#
# No bulk pulls by this script. ~30 distinct images live in versions.sh;
# each gets cached in the mirror on first request (single Docker-Hub pull
# per tag, then permanent cache hits). That's well below 100/6h and
# happens organically over the first test runs.
#
# OPTIONAL: production/reseed-docker-mirror-test.sh fills the mirror's
# cache via ZFS replication from the prod mirror on pve1 — useful when
# iterating on docker-mirror-test with --force-docker-mirror-test (each
# destroy purges the cache volume), or for paranoid avoidance of any
# Docker-Hub traffic. Steady-state operation does NOT need it.
#
# Prerequisites:
#   - production/setup-pve-host.sh <PVE_HOST> must have run so the proxvex CA
#     ends up in the nested VM trust store at baseline creation time.
#   - production/setup-production.sh --step 18 must have completed so the
#     docker-mirror-test LXC at 192.168.4.49 (ubuntupve) is running and
#     reachable from the nested VM.
#   - production/setup-production.sh --step 19 must have completed so the
#     zot-mirror LXC at 192.168.4.50 (ubuntupve) is running and reachable.
#   - (production/setup-production.sh --step 5/17 on pve1 is no longer
#     required by this script — the prod mirror stays for production
#     workloads but is unused by the test path.)
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

# nested_ssh / nested_scp_to / nested_scp_from come from lib/nested-ssh.sh.
# They use a per-instance pinned ed25519 host key (config.json.hostKey ↔
# first-boot.sh.template) with StrictHostKeyChecking=yes — no more
# "Permanently added ..." warnings, real MITM protection.
# shellcheck source=lib/nested-ssh.sh
. "$SCRIPT_DIR/lib/nested-ssh.sh"

# Source the pve-ops abstraction so qm calls go through PVE_USE_API toggle.
# After Phase A2 step2a has no outer-host SSH at all — qm via API, CA was
# baked into the baseline by step1, mirror checks happen via nested_ssh.
# shellcheck source=lib/pve-ops.sh
. "$SCRIPT_DIR/lib/pve-ops.sh"

header "Step 2a: Wire registry mirrors on nested VM"
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
# v5-zot-mirror            = ghcr.io served by project-zot/zot-based mirror at
#                            192.168.4.50 (proxvex-app `zot-mirror`, deploy via
#                            setup-production.sh --step 19). dnsmasq points
#                            `ghcr.io` AND `zot-mirror` at .50. The older
#                            distribution-based ghcr-registry-mirror at .48 is
#                            no longer in the redirect path (LXC may still
#                            exist but is unused by the test path).
SCHEMA_VERSION="v5-zot-mirror"

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

# Step 3: Verify the test Docker Hub mirror (docker-mirror-test on ubuntupve)
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

# Step 4: Verify the zot-mirror (ghcr.io pull-through) is reachable.
# As of schema v5-zot-mirror the test path uses the project-zot/zot-based
# mirror (deployed by setup-production.sh --step 19) at 192.168.4.50 instead
# of the older distribution-based ghcr-registry-mirror at 192.168.4.48. Cert
# SAN already includes DNS:ghcr.io,DNS:registry-1.docker.io,DNS:index.docker.io
# so Phase B (Docker Hub upstream via the same zot LXC) needs no cert reissue.
ZOT_MIRROR_IP="${ZOT_MIRROR_IP:-192.168.4.50}"
ZOT_MIRROR_HOST="${ZOT_MIRROR_HOST:-zot-mirror}"
# STEP2A_SKIP_ZOT_MIRROR=1 bypasses the zot-mirror health checks so the
# mirrors-ready snapshot can still be created even when zot-mirror is broken.
# ghcr.io pulls will fail at install-time for any consumer that needs them,
# but the snapshot itself is created and step2b can proceed.
if [ "${STEP2A_SKIP_ZOT_MIRROR:-}" = "1" ]; then
    info "STEP2A_SKIP_ZOT_MIRROR=1 — skipping zot-mirror reachability check"
else
    header "Verifying zot-mirror (${ZOT_MIRROR_HOST} @ ${ZOT_MIRROR_IP})"
    for i in $(seq 1 10); do
        nested_ssh "curl -sf --connect-timeout 5 \
            --resolve ${ZOT_MIRROR_HOST}:443:${ZOT_MIRROR_IP} \
            https://${ZOT_MIRROR_HOST}/v2/ >/dev/null 2>&1" && break
        sleep 1
    done
    nested_ssh "curl -sf --connect-timeout 5 \
        --resolve ${ZOT_MIRROR_HOST}:443:${ZOT_MIRROR_IP} \
        https://${ZOT_MIRROR_HOST}/v2/ >/dev/null 2>&1" \
        || error "${ZOT_MIRROR_HOST} (${ZOT_MIRROR_IP}) unreachable from nested VM.
        - Deploy it: ./production/setup-production.sh --step 19
          (target host ubuntupve; see APP_HOST_MAP in setup-production.sh).
        - Check the LXC is running:
            ssh root@ubuntupve 'pct list | grep ${ZOT_MIRROR_HOST}'
        - Verify routing 10.99.X.0/24 → 192.168.4.0/24 (POSTROUTING MASQUERADE
          on the outer PVE host — see step1-create-vm.sh).
        - Or rerun with STEP2A_SKIP_ZOT_MIRROR=1 to create the snapshot anyway."
    success "zot-mirror reachable at ${ZOT_MIRROR_IP} (TLS via proxvex CA)"
fi

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
# mirror caches each image on first request (cache miss → upstream fetch →
# stored, then cache hits forever). Optional ZFS reseed from the prod
# mirror (production/reseed-docker-mirror-test.sh) skips the first-pull
# burst — useful when iterating with --force-docker-mirror-test.
#
# Idempotent replace: BEGIN/END fence lets re-runs or schema migrations
# rewrite the block in place; legacy un-fenced lines from older schemas
# are also stripped.
header "Wiring dnsmasq registry redirects + mirror hostnames"
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
        sed -i '/^address=\\/${ZOT_MIRROR_HOST}\\//d' \"\$cfg\"
    fi
    cat >> \"\$cfg\" <<DNS
# === proxvex E2E registry redirects BEGIN ===
# Test Docker Hub mirror (distribution/distribution on ubuntupve).
# Resolved by hostname so skopeo's registries.conf entry + the docker
# daemon's registry-mirrors entry inside docker-compose-style LXCs match
# the mirror's TLS cert SAN.
address=/${TEST_MIRROR_HOST}/${TEST_MIRROR_IP}
address=/${TEST_MIRROR_HOST}/::
# Zot mirror (project-zot/zot on ubuntupve, ghcr.io pull-through). Resolved
# by hostname for clients that address it directly (ghcr_registry_mirror
# project param + post-start-dockerd's /etc/hosts redirect).
address=/${ZOT_MIRROR_HOST}/${ZOT_MIRROR_IP}
address=/${ZOT_MIRROR_HOST}/::
# ghcr.io -> zot-mirror IP. Docker has no per-registry mirror switch for
# ghcr.io, so the DNS-redirect handles transparent routing for any client
# that hasn't been explicitly told about ghcr_registry_mirror. Cert SAN
# on the zot LXC includes DNS:ghcr.io, so TLS validates cleanly.
address=/ghcr.io/${ZOT_MIRROR_IP}
address=/ghcr.io/::
# docker.io -> production Docker Hub mirror (pve1.cluster). Test mirrors
# on ubuntupve hold only ghcr.io upstream; for docker.io pulls in livetest
# (e.g. traefik:v3.6) we redirect to the production-side mirror at
# 192.168.4.45 which proxies registry-1.docker.io. Previously baked at
# runner-startup time (live-test-runner.mts), which lost the entries on
# every \`qm rollback\` to mirrors-ready/deployer-installed — symptom was
# \`unexpected EOF\` on traefik pull during zitadel install/reconfigure.
# Baking here means future rollbacks preserve the DNS-redirect.
address=/registry-1.docker.io/192.168.4.45
address=/registry-1.docker.io/::
address=/index.docker.io/192.168.4.45
address=/index.docker.io/::
# docker-registry-mirror hostname → forwarder. The forwarder address
# comes from the per-instance e2e/config.json registryMirror.dnsForwarder
# (router IP in the green nested-VM network) so containers inside the
# nested PVE resolve docker-registry-mirror.* via the outer router.
server=/docker-registry-mirror/192.168.4.1
# === proxvex E2E registry redirects END ===
DNS
    systemctl restart dnsmasq
"
success "dnsmasq configured (${TEST_MIRROR_HOST} -> ${TEST_MIRROR_IP}, ${ZOT_MIRROR_HOST} -> ${ZOT_MIRROR_IP}, ghcr.io -> ${ZOT_MIRROR_IP})"

# Step 5b: write /etc/containers/registries.conf so skopeo routes
# docker.io pulls through the test mirror. Skopeo itself ships with
# Proxmox VE 9.1+ as a dependency of pve-manager (pct uses it for OCI
# image operations) — no install needed, just verify it's on PATH and
# fail loudly if the baseline somehow lacks it.
header "Writing /etc/containers/registries.conf"
nested_ssh "command -v skopeo >/dev/null 2>&1" \
    || error "skopeo not found on nested VM — expected to be present in
    Proxmox VE 9.1+ (pulled in via pve-manager). Verify the baseline:
        ssh -p $PORT_PVE_SSH root@$PVE_HOST 'pveversion && dpkg -l skopeo'"
nested_ssh "
    set -e
    mkdir -p /etc/containers
    cat > /etc/containers/registries.conf <<REG
unqualified-search-registries = ['docker.io']

[[registry]]
location = 'docker.io'

# containers-image canonical-hostname rule: a mirror location without
# a dot AND without a :port is interpreted as a path component on
# docker.io (\"rewriting reference: repository name must be canonical\").
# Pin :443 explicitly so '${TEST_MIRROR_HOST}' is parsed as a hostname.
# TLS handshake still validates the cert SAN against the bare hostname.
[[registry.mirror]]
location = '${TEST_MIRROR_HOST}:443'
REG
"
success "/etc/containers/registries.conf wired (docker.io -> ${TEST_MIRROR_HOST})"

# Step 6: Smoketests — two orthogonal checks that the mirror routing
# is wired up correctly.
#
# 1. curl https://${TEST_MIRROR_HOST}/v2/ via dnsmasq (proves DNS+TLS;
#    a Step 3.5 probe earlier in this script used --resolve to bypass DNS).
# 2. skopeo inspect docker://docker.io/library/alpine:latest (proves
#    registries.conf routing). Alpine is in versions.sh, so on a warm
#    mirror this is a cache hit. On a cold mirror this triggers exactly
#    one Docker Hub pull-through (the mirror fetches alpine, caches it,
#    answers) — well below the 100/6h anonymous limit.
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
    - Probe the mirror directly:
        curl -sf https://${TEST_MIRROR_HOST}/v2/library/alpine/manifests/latest \\
          -H 'Accept: application/vnd.oci.image.index.v1+json'
    - Last resort if the mirror's pull-through to Docker Hub is broken
      (e.g. credentials expired, upstream rate-limited): seed the cache
      from the prod mirror via ./production/reseed-docker-mirror-test.sh"
success "Skopeo routes docker.io through ${TEST_MIRROR_HOST}"

# Step 6c: ghcr.io smoketest via the dnsmasq-redirect path. ghcr.io
# resolves to ${ZOT_MIRROR_IP}, the mirror serves /v2/ at that IP with
# a cert SAN matching DNS:ghcr.io, so curl validates cleanly. On a cold
# zot cache this triggers exactly one ghcr.io pull-through to populate
# the index — ghcr.io is anonymous-friendly, no rate-limit concern.
if [ "${STEP2A_SKIP_ZOT_MIRROR:-}" = "1" ]; then
    info "STEP2A_SKIP_ZOT_MIRROR=1 — skipping ghcr.io smoketest"
else
    header "Smoketest: ghcr.io via zot-mirror"
    nested_ssh "curl -sf --connect-timeout 5 https://ghcr.io/v2/ >/dev/null" \
        || error "https://ghcr.io/v2/ unreachable via dnsmasq → ${ZOT_MIRROR_HOST}.
        - Verify dnsmasq redirects ghcr.io: nested_ssh 'grep ghcr.io /etc/dnsmasq.d/e2e-nat.conf'
        - Verify ${ZOT_MIRROR_HOST} resolves: nested_ssh 'getent hosts ${ZOT_MIRROR_HOST}'
        - Probe directly:
            curl -sf --resolve ${ZOT_MIRROR_HOST}:443:${ZOT_MIRROR_IP} \\
              https://${ZOT_MIRROR_HOST}/v2/
        - Or rerun with STEP2A_SKIP_ZOT_MIRROR=1 to create the snapshot anyway."
    success "ghcr.io routes through ${ZOT_MIRROR_HOST}"
fi

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
pve_qm_snapshot_create "$TEST_VMID" mirrors-ready "Nested VM with skopeo + registries.conf + dnsmasq pointing at docker-mirror-test/zot-mirror; versions-hash=${VERSIONS_HASH}; schema=${SCHEMA_VERSION}"
success "Snapshot 'mirrors-ready' created (versions-hash=${VERSIONS_HASH}, schema=${SCHEMA_VERSION})"

pve_qm_start "$TEST_VMID"

TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Step 2a complete in ${TOTAL_TIME}${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Next: ./step2b-install-deployer.sh $E2E_INSTANCE"
