#!/bin/bash
# step2a-setup-mirrors.sh - Install Docker + registry mirrors on the nested VM
#
# This script:
# 1. Rolls back to step1 'baseline' snapshot (clean state)
# 2. Installs Docker inside the nested VM
# 3. Starts Docker Hub + ghcr.io pull-through mirrors (10.0.0.1, 10.0.0.2)
# 4. Pre-pulls all images referenced by json/shared/scripts/library/versions.sh
#    through the mirrors to warm the cache (this is the expensive part)
# 5. Wires up dnsmasq so LXC containers resolve registry hostnames to the mirrors
# 6. Creates the 'mirrors-ready' snapshot so step2b can roll back to a clean
#    environment with pre-filled mirrors (no rate-limit risk on re-runs)
#
# Idempotency:
#   The 'mirrors-ready' snapshot description carries a short hash of
#   json/shared/scripts/library/versions.sh. If that hash already matches the
#   current file, the script exits immediately without rollback or re-pull.
#   Pass --force to bypass the check and rebuild from baseline.
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

# Step 0: idempotency check — if a mirrors-ready snapshot already exists and
# its description carries the current versions.sh hash, nothing to do.
if [ "$FORCE" != "true" ]; then
    if pve_ssh "qm listsnapshot $TEST_VMID 2>/dev/null" | grep -E 'mirrors-ready[[:space:]]' | grep -q "versions-hash=${VERSIONS_HASH}"; then
        info "mirrors-ready already reflects current versions.sh (hash=${VERSIONS_HASH}) — nothing to do"
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
[ "$SSH_READY" = "true" ] || error "Cannot connect to $NESTED_IP via SSH after 60s"
success "SSH connection verified"

# Step 3: Install Docker on the nested VM (runtime for the mirror containers)
header "Installing Docker on nested VM"
nested_ssh "command -v docker >/dev/null 2>&1 || {
    apt-get update -qq && apt-get install -y -qq docker.io >&2
}"
success "Docker available on nested VM"

# Pre-pull the registry image itself (this hits Docker Hub directly, before
# dnsmasq redirects are in place so there is no chicken-and-egg problem)
nested_ssh "docker image inspect distribution/distribution:3.0.0 >/dev/null 2>&1 || \
    docker pull distribution/distribution:3.0.0 >&2"
success "Mirror image available"

# Step 4: Start Docker Hub + ghcr.io mirrors (bound to 10.0.0.1 / 10.0.0.2)
header "Starting registry mirrors"

# ghcr.io mirror needs its own IP on vmbr1 (Docker Hub uses 10.0.0.1, the NAT gateway).
# Persist via a systemd oneshot unit so the IP survives VM reboots / snapshot
# rollbacks (without it the ghcr-mirror container fails to re-bind :443/:80
# after a reboot and every ghcr.io pull breaks with "no route to host").
# Using systemd rather than /etc/network/interfaces.d/ because ifupdown2 on
# Proxmox rejects colon-aliased interface names (vmbr1:ghcr).
nested_ssh "cat > /etc/systemd/system/vmbr1-ghcr-alias.service <<'EOF'
[Unit]
Description=Secondary IP 10.0.0.2 on vmbr1 for ghcr.io pull-through mirror
After=networking.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ip addr add 10.0.0.2/24 dev vmbr1
ExecStartPost=/bin/docker start ghcr-mirror
ExecStop=/sbin/ip addr del 10.0.0.2/24 dev vmbr1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vmbr1-ghcr-alias.service
"
nested_ssh "ip addr show vmbr1 | grep -q '10.0.0.2/' || ip addr add 10.0.0.2/24 dev vmbr1"

nested_ssh "docker ps -q -f name='^dockerhub-mirror$' | grep -q . || {
    docker rm -f dockerhub-mirror 2>/dev/null || true
    docker run -d --name dockerhub-mirror --restart unless-stopped \
        --dns 8.8.8.8 --dns 8.8.4.4 \
        -p 10.0.0.1:443:5000 \
        -p 10.0.0.1:80:5000 \
        -v dockerhub-mirror-data:/var/lib/registry \
        -e REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io \
        distribution/distribution:3.0.0 >&2
}"
success "Docker Hub mirror running on 10.0.0.1:80+443"

nested_ssh "docker ps -q -f name='^ghcr-mirror$' | grep -q . || {
    docker rm -f ghcr-mirror 2>/dev/null || true
    docker run -d --name ghcr-mirror --restart unless-stopped \
        --dns 8.8.8.8 --dns 8.8.4.4 \
        -p 10.0.0.2:443:5000 \
        -p 10.0.0.2:80:5000 \
        -v ghcr-mirror-data:/var/lib/registry \
        -e REGISTRY_PROXY_REMOTEURL=https://ghcr.io \
        distribution/distribution:3.0.0 >&2
}"
success "ghcr.io mirror running on 10.0.0.2:80+443"

# Docker daemon: route Docker Hub pulls through the mirror and trust the
# plain-HTTP mirror endpoints (they proxy HTTPS upstream internally).
nested_ssh "cat > /etc/docker/daemon.json <<'DJSON'
{
  \"registry-mirrors\": [\"http://10.0.0.1:80\"],
  \"insecure-registries\": [\"10.0.0.1:80\", \"10.0.0.1:443\", \"10.0.0.2:80\", \"10.0.0.2:443\"]
}
DJSON
    systemctl restart docker >&2 2>/dev/null || true"

info "Waiting for mirrors to be healthy..."
for mirror in "10.0.0.1:80" "10.0.0.2:80"; do
    for i in $(seq 1 30); do
        nested_ssh "curl -s http://$mirror/v2/ >/dev/null 2>&1" && break
        sleep 1
    done
done
success "Mirrors healthy"

# Step 5: Pre-pull images through the mirrors (the expensive part; ~15 min).
# Must run BEFORE adding dnsmasq address= entries, otherwise the Docker daemon
# resolves registry-1.docker.io to 10.0.0.1 on fallback and loops.
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
        if echo "$image" | grep -q "ghcr.io"; then
            mirror_path="${image#ghcr.io/}"
            nested_ssh "docker pull 10.0.0.2:80/${mirror_path}:${tag}" < /dev/null 2>&1 \
                || echo "    Warning: $full failed"
        else
            nested_ssh "docker pull '$full'" < /dev/null 2>&1 \
                || echo "    Warning: $full failed"
        fi
    done
    success "Image pre-pull complete"
else
    info "versions.sh not found, skipping pre-pull"
fi

# Step 6: dnsmasq redirects so LXC containers resolve registry hostnames to
# the mirror IPs. A+AAAA entries both point at the mirror; without blocking
# AAAA, Go's net-resolver would prefer the real IPv6 CDN and bypass the
# plain-HTTP mirror on :443.
header "Wiring dnsmasq registry redirects"
nested_ssh "
    if ! grep -q 'address=/registry-1.docker.io/' /etc/dnsmasq.d/e2e-nat.conf 2>/dev/null; then
        cat >> /etc/dnsmasq.d/e2e-nat.conf <<'DNS'
# Registry mirror redirects (for LXC containers)
address=/registry-1.docker.io/10.0.0.1
address=/index.docker.io/10.0.0.1
address=/ghcr.io/10.0.0.2
# Block IPv6 for these hosts so skopeo/Go cannot bypass the mirror over AAAA
address=/registry-1.docker.io/::
address=/index.docker.io/::
address=/ghcr.io/::
DNS
        systemctl restart dnsmasq
    fi
"
success "dnsmasq registry redirects configured"

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
pve_ssh "qm snapshot $TEST_VMID mirrors-ready --description 'Nested VM with Docker + filled registry mirrors; versions-hash=${VERSIONS_HASH}'"
success "Snapshot 'mirrors-ready' created (versions-hash=${VERSIONS_HASH})"

pve_ssh "qm start $TEST_VMID"

TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Step 2a complete in ${TOTAL_TIME}${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Next: ./step2b-install-deployer.sh $E2E_INSTANCE"
