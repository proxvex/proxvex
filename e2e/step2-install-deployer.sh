#!/bin/bash
# step2-install-deployer.sh - Installs oci-lxc-deployer for E2E testing
#
# This script:
# 1. Rolls back to step1 baseline snapshot (clean state)
# 2. Installs oci-lxc-deployer at DEPLOYER_VMID (HTTP only, no HTTPS)
# 3. Deploys local package build to the container
# 4. Sets up registry mirrors for image caching
#
# Usage:
#   ./step2-install-deployer.sh [instance]                        # Full install
#   ./step2-install-deployer.sh [instance] --update-only          # Fast update (~15s)
#   ./step2-install-deployer.sh [instance] --verbose              # Full install with verbose CLI output
#
# For a fresh start, re-run step1 + step2 (~3 min total)

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load shared configuration
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

# Parse arguments
UPDATE_ONLY=false
VERBOSE=false
INSTANCE_ARG=""
for arg in "$@"; do
    case "$arg" in
        --update-only) UPDATE_ONLY=true ;;
        --verbose|-v) VERBOSE=true ;;
        -*) ;; # Skip other flags
        *) [ -z "$INSTANCE_ARG" ] && INSTANCE_ARG="$arg" ;; # First non-flag is instance
    esac
done

# Load config for the specified instance
load_config "$INSTANCE_ARG"

# Set nested VM IP from config
NESTED_IP="$NESTED_STATIC_IP"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Timing
SCRIPT_START=$(date +%s)
STEP_START=$SCRIPT_START

elapsed() {
    local now=$(date +%s)
    local total=$((now - SCRIPT_START))
    echo "${total}s"
}

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

# SSH wrapper for nested VM (via PVE host port forwarding)
nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
}

# SSH wrapper for PVE host directly (for VM management: qm commands)
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

# Deploy local package tarball to a container
# Requires: TARBALL on nested VM at /tmp/$TARBALL, DEPLOYER_STATIC_IP and DEPLOYER_GATEWAY set
deploy_to_container() {
    local target_vmid="$1"
    local deployer_ip="${DEPLOYER_STATIC_IP%/*}"

    # Wait for container to be running
    for i in $(seq 1 30); do
        if nested_ssh "pct status $target_vmid 2>/dev/null" | grep -q "running"; then
            break
        fi
        sleep 2
    done

    # Push tarball to container (retry if LXC lock not yet released after reboot)
    info "Pushing $TARBALL to container $target_vmid..."
    local push_ok=false
    for attempt in $(seq 1 5); do
        if nested_ssh "pct push $target_vmid /tmp/$TARBALL /tmp/$TARBALL" 2>/dev/null; then
            push_ok=true
            break
        fi
        info "Lock busy, retrying in 5s... (attempt $attempt/5)"
        sleep 5
    done
    if [ "$push_ok" != "true" ]; then
        error "Failed to push tarball to container (lock timeout)"
    fi
    success "Package pushed to container $target_vmid"

    # Activate and verify network (may need manual activation after reboot)
    info "Verifying container network..."
    nested_ssh "pct exec $target_vmid -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
    local net_ok=false
    for i in $(seq 1 5); do
        if nested_ssh "pct exec $target_vmid -- ping -c 1 -W 2 1.1.1.1" &>/dev/null; then
            net_ok=true
            break
        fi
        sleep 3
    done
    if [ "$net_ok" != "true" ]; then
        error "Container has no network - cannot install packages"
    fi
    success "Network verified"

    # Install package
    info "Installing package in container $target_vmid..."
    nested_ssh "pct exec $target_vmid -- sh -c '
        cd /tmp && \
        rm -rf package && \
        tar -xzf $TARBALL && \
        cd package && \
        npm install --omit=dev --no-audit --no-fund --ignore-scripts 2>/dev/null && \
        rm -rf /usr/local/lib/node_modules/oci-lxc-deployer && \
        mkdir -p /usr/local/lib/node_modules && \
        mv /tmp/package /usr/local/lib/node_modules/oci-lxc-deployer && \
        ln -sf /usr/local/lib/node_modules/oci-lxc-deployer/backend/dist/oci-lxc-deployer.mjs /usr/local/bin/oci-lxc-deployer && \
        ln -sf /usr/local/lib/node_modules/oci-lxc-deployer/cli/dist/cli/src/oci-lxc-cli.mjs /usr/local/bin/oci-lxc-cli
    '" || error "Failed to install package"
    success "Package installed in container $target_vmid"

    # Apply examples overrides (e.g., package mirror defaults for faster installs)
    nested_ssh "pct exec $target_vmid -- sh -c 'cp -r /usr/local/lib/node_modules/oci-lxc-deployer/examples/shared/* /usr/local/lib/node_modules/oci-lxc-deployer/json/shared/ 2>/dev/null || true'"

    # Restart container to reload updated code
    info "Restarting container $target_vmid..."
    nested_ssh "pct stop $target_vmid && sleep 1 && pct start $target_vmid" || error "Failed to restart container"
    sleep 2
    nested_ssh "pct exec $target_vmid -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
    success "Container $target_vmid restarted"

    # Wait for API (try both HTTP and HTTPS - after SSL reconfigure, HTTP redirects to HTTPS)
    info "Waiting for API to restart..."
    local api_ok=false
    for i in $(seq 1 60); do
        if nested_ssh "curl -s --connect-timeout 1 http://$deployer_ip:3080/ 2>/dev/null" | grep -q "doctype"; then
            api_ok=true
            break
        fi
        if nested_ssh "curl -sk --connect-timeout 1 https://$deployer_ip:3443/ 2>/dev/null" | grep -q "doctype"; then
            api_ok=true
            break
        fi
        printf "\r${YELLOW}[INFO]${NC} Waiting for API restart... %ds" "$i"
        sleep 1
    done
    echo ""
    if [ "$api_ok" != "true" ]; then
        error "API failed to restart within 60 seconds"
    fi
    success "API healthy in container $target_vmid"
}

header "Step 2: Install oci-lxc-deployer"
echo "Instance: $E2E_INSTANCE"
echo "Connection: $PVE_HOST:$PORT_PVE_SSH -> $NESTED_IP:22"
echo "Owner: $OWNER"
echo "OCI Owner: $OCI_OWNER"
echo "Deployer VMID: $DEPLOYER_VMID"
echo "Deployer URL: $DEPLOYER_URL"
echo ""

# HTTPS is not used for livetests, so install directly at DEPLOYER_VMID (no temp container needed)

# Step 1: Rollback to baseline snapshot for full installs (clean state)
if [ "$UPDATE_ONLY" != "true" ]; then
    info "Rolling back to baseline snapshot for clean install..."
    if pve_ssh "qm listsnapshot $TEST_VMID" 2>/dev/null | grep -q "baseline"; then
        pve_ssh "qm shutdown $TEST_VMID --timeout 30" 2>/dev/null || true
        for i in $(seq 1 30); do
            pve_ssh "qm status $TEST_VMID 2>/dev/null" | grep -q stopped && break
            sleep 1
        done
        # Delete deployer-installed snapshot if it exists (rollback requires most recent)
        pve_ssh "qm delsnapshot $TEST_VMID deployer-installed 2>/dev/null || true"
        pve_ssh "qm rollback $TEST_VMID baseline"
        pve_ssh "qm start $TEST_VMID"
        success "Rolled back to baseline snapshot"
    else
        info "No baseline snapshot found — continuing without rollback"
    fi
fi

# Step 2: Wait for SSH connection (VM might still be booting after snapshot restore)
info "Waiting for SSH connection to nested VM..."
SSH_READY=false
for i in $(seq 1 60); do
    if nested_ssh "echo 'SSH OK'" &>/dev/null; then
        SSH_READY=true
        break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for SSH... %ds" "$i"
    sleep 1
done
echo ""

if [ "$SSH_READY" != "true" ]; then
    error "Cannot connect to $NESTED_IP via SSH after 60s. Is the nested VM running?"
fi
success "SSH connection verified"

# Step 3: Check if deployer already exists
if nested_ssh "pct status $DEPLOYER_VMID" &>/dev/null; then
    info "Deployer container $DEPLOYER_VMID already exists"
    DEPLOYER_STATUS=$(nested_ssh "pct status $DEPLOYER_VMID" | awk '/status:/ {print $2}')
    if [ "$DEPLOYER_STATUS" = "running" ]; then
        success "Deployer container is running"

        # Check if API is responding
        DEPLOYER_IP=$(nested_ssh "pct exec $DEPLOYER_VMID -- hostname -I 2>/dev/null" | awk '{print $1}')
        if [ -n "$DEPLOYER_IP" ]; then
            if nested_ssh "curl -s http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype" || \
               nested_ssh "curl -sk https://$DEPLOYER_IP:3443/ 2>/dev/null" | grep -q "doctype"; then
                # Detect protocol
                if nested_ssh "curl -sk --connect-timeout 1 https://$DEPLOYER_IP:3443/ 2>/dev/null" | grep -q "doctype"; then
                    DEPLOYER_PROTO="https://$DEPLOYER_IP:3443"
                else
                    DEPLOYER_PROTO="http://$DEPLOYER_IP:3080"
                fi
                success "API is healthy at $DEPLOYER_PROTO"

                if [ "$UPDATE_ONLY" = "true" ]; then
                    info "--update-only: Skipping to local package deployment..."
                else
                    echo ""
                    echo "Deployer already installed and running!"
                    echo "API URL: $DEPLOYER_PROTO"
                    echo ""
                    echo "To deploy updated code: ./step2-install-deployer.sh --update-only"
                    exit 0
                fi
            fi
        fi
    fi
fi

# Step 3: Clean up existing container and install oci-lxc-deployer (skip if --update-only)
if [ "$UPDATE_ONLY" != "true" ]; then
    header "Installing oci-lxc-deployer"

    # No cleanup needed — baseline snapshot rollback provides clean state

# Local script path on nested VM
LOCAL_SCRIPT_PATH="/tmp/oci-lxc-deployer-scripts"

# Copy local install script and shared scripts to nested VM for testing
LOCAL_INSTALL_SCRIPT="$PROJECT_ROOT/install-oci-lxc-deployer.sh"
LOCAL_SHARED_SCRIPTS="$PROJECT_ROOT/json/shared/scripts"
if [ -f "$LOCAL_INSTALL_SCRIPT" ] && [ -d "$LOCAL_SHARED_SCRIPTS" ]; then
    info "Copying local install script to nested VM..."
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$LOCAL_INSTALL_SCRIPT" "root@$PVE_HOST:/tmp/install-oci-lxc-deployer.sh" || error "Failed to copy install script to PVE host"
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "root@$PVE_HOST" "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/install-oci-lxc-deployer.sh root@$NESTED_IP:/tmp/" || error "Failed to copy install script to nested VM"
    success "Local install script copied"

    info "Copying local shared scripts to nested VM..."
    # Create tarball of only json/shared/scripts (what install script needs)
    tar -czf /tmp/oci-lxc-deployer-scripts.tar.gz -C "$PROJECT_ROOT" json/shared/scripts || error "Failed to create scripts tarball"
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/oci-lxc-deployer-scripts.tar.gz "root@$PVE_HOST:/tmp/" || error "Failed to copy scripts tarball to PVE host"
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "root@$PVE_HOST" "scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null /tmp/oci-lxc-deployer-scripts.tar.gz root@$NESTED_IP:/tmp/" || error "Failed to copy scripts tarball to nested VM"
    # Extract on nested VM
    nested_ssh "mkdir -p $LOCAL_SCRIPT_PATH && tar -xzf /tmp/oci-lxc-deployer-scripts.tar.gz -C $LOCAL_SCRIPT_PATH" || error "Failed to extract scripts on nested VM"
    rm -f /tmp/oci-lxc-deployer-scripts.tar.gz
    success "Local shared scripts copied to $LOCAL_SCRIPT_PATH"

    info "Running installation script with OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH..."
    # Run local script with custom parameters and local scripts path
    nested_ssh "chmod +x /tmp/install-oci-lxc-deployer.sh && \
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH /tmp/install-oci-lxc-deployer.sh --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY --nameserver $DEPLOYER_GATEWAY --deployer-url $DEPLOYER_URL" || error "Installation script failed"
else
    info "Running installation script from GitHub with OWNER=$OWNER OCI_OWNER=$OCI_OWNER..."
    # Fallback: Download and run from GitHub
    nested_ssh "curl -sSL https://raw.githubusercontent.com/$OWNER/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | \
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER bash -s -- --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY --nameserver $DEPLOYER_GATEWAY --deployer-url $DEPLOYER_URL" || error "Installation script from GitHub failed"
fi

success "Installation script completed"

# Container is running, API is responding, /etc/hosts and SSH are set up by install script

fi # end of full install block (skipped with --update-only)

# Ensure DEPLOYER_IP is set (needed for port forwarding and package deployment)
DEPLOYER_IP="${DEPLOYER_STATIC_IP%/*}"

# In --update-only mode, ensure container network is up (might be down after restart)
if [ "$UPDATE_ONLY" = "true" ]; then
    info "Ensuring container network is up..."
    nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
    if nested_ssh "pct exec $DEPLOYER_VMID -- ping -c 1 1.1.1.1" &>/dev/null; then
        success "Container network is up"
    else
        error "Container network failed - cannot reach internet"
    fi

    # Add /etc/hosts entries for nested VM (required for SSH from deployer)
    info "Ensuring /etc/hosts entries for nested VM..."
    NESTED_HOSTNAME=$(nested_ssh "hostname -f 2>/dev/null || hostname")
    # Build hosts entry: always include nested hostname (with and without .local)
    HOSTS_ENTRY="$DEPLOYER_GATEWAY $NESTED_HOSTNAME ${NESTED_HOSTNAME}.local"
    # Add PVE_HOST if set and different from nested hostname
    if [ -n "$PVE_HOST" ] && [ "$PVE_HOST" != "$NESTED_HOSTNAME" ] && [ "$PVE_HOST" != "${NESTED_HOSTNAME}.local" ]; then
        HOSTS_ENTRY="$HOSTS_ENTRY $PVE_HOST"
    fi
    # Only add if not already present
    nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'grep -q \"${NESTED_HOSTNAME}.local\" /etc/hosts || echo \"$HOSTS_ENTRY\" >> /etc/hosts'"
    success "Ensured hosts entry: $HOSTS_ENTRY"
fi

# Step 5b: Set up port forwarding on nested VM to deployer container
# Note: nested VM receives traffic on port 3080/3443 (from PVE host PORT_DEPLOYER/PORT_DEPLOYER_HTTPS)
# and forwards it to the deployer container at $DEPLOYER_IP:3080/3443
header "Setting up Port Forwarding on Nested VM"
info "Configuring port forwarding to deployer container at $DEPLOYER_IP..."

# Configure port forwarding in single SSH call
nested_ssh "
  # Remove existing rules (idempotency for re-runs)
  iptables -t nat -D PREROUTING -p tcp --dport 3080 -j DNAT --to-destination $DEPLOYER_IP:3080 2>/dev/null || true
  iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3080 -j ACCEPT 2>/dev/null || true
  iptables -t nat -D PREROUTING -p tcp --dport 3443 -j DNAT --to-destination $DEPLOYER_IP:3443 2>/dev/null || true
  iptables -D FORWARD -p tcp -d $DEPLOYER_IP --dport 3443 -j ACCEPT 2>/dev/null || true
  # Add forwarding rules
  iptables -t nat -A PREROUTING -p tcp --dport 3080 -j DNAT --to-destination $DEPLOYER_IP:3080
  iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3080 -j ACCEPT
  iptables -t nat -A PREROUTING -p tcp --dport 3443 -j DNAT --to-destination $DEPLOYER_IP:3443
  iptables -A FORWARD -p tcp -d $DEPLOYER_IP --dport 3443 -j ACCEPT
  # Persist iptables rules so they survive reboot/snapshot-rollback
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4
"
success "Nested VM :3080 -> $DEPLOYER_IP:3080 (HTTP, persisted)"
success "Nested VM :3443 -> $DEPLOYER_IP:3443 (HTTPS, persisted)"

# Build and deploy local package
if [ -f "$PROJECT_ROOT/package.json" ] && grep -q '"name": "oci-lxc-deployer"' "$PROJECT_ROOT/package.json"; then
    header "Building Local Package"
    cd "$PROJECT_ROOT"

    info "Building local oci-lxc-deployer package..."
    pnpm run build || error "Failed to build package"

    TARBALL=$(pnpm pack 2>&1 | grep -o 'oci-lxc-deployer-.*\.tgz')

    if [ -z "$TARBALL" ] || [ ! -f "$PROJECT_ROOT/$TARBALL" ]; then
        error "Failed to create package tarball"
    fi
    success "Created $TARBALL"

    # Copy tarball to nested VM (once; reused for each deploy)
    info "Copying $TARBALL to nested VM..."
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P "$PORT_PVE_SSH" "$PROJECT_ROOT/$TARBALL" "root@$PVE_HOST:/tmp/" || error "Failed to copy tarball to nested VM"
    success "Package copied to nested VM"

    if [ "$UPDATE_ONLY" != "true" ]; then
        # Deploy local package to the deployer container
        header "Deploy Local Package to Container ($DEPLOYER_VMID)"
        deploy_to_container "$DEPLOYER_VMID"

        # Wait for deployer API
        DEPLOYER_API="http://${DEPLOYER_IP}:3080"
        info "Waiting for deployer API at ${DEPLOYER_API}..."
        for i in $(seq 1 30); do
            if nested_ssh "curl -sf ${DEPLOYER_API}/api/applications" &>/dev/null; then
                break
            fi
            sleep 2
        done
        if nested_ssh "curl -sf ${DEPLOYER_API}/api/applications" &>/dev/null; then
            success "Deployer ready (HTTP)"
        else
            error "Deployer API not ready after 60s"
        fi

        # Full install already deployed the package above
    else
        # --update-only: Deploy directly to DEPLOYER_VMID
        header "Deploying Local Package"
        deploy_to_container "$DEPLOYER_VMID"
    fi

    # Cleanup tarball
    rm -f "$PROJECT_ROOT/$TARBALL"
    nested_ssh "rm -f /tmp/$TARBALL"
fi

# Step 6: Set up local registry mirrors (Docker Hub + ghcr.io)
# Two pull-through caches on the nested VM so LXC containers can pull images
# locally instead of going through double-NAT to the internet.
if [ "$UPDATE_ONLY" != "true" ]; then
    header "Setting up registry mirrors"

    # Install Docker on the nested VM (for running the mirror containers)
    nested_ssh "command -v docker >/dev/null 2>&1 || {
        apt-get update -qq && apt-get install -y -qq docker.io >&2
    }"
    success "Docker available on nested VM"

    # Pre-pull the mirror image directly (hosts redirects already cleaned above)
    nested_ssh "docker image inspect distribution/distribution:3.0.0 >/dev/null 2>&1 || \
        docker pull distribution/distribution:3.0.0 >&2"
    success "Mirror image available"

    # Add secondary IP for ghcr.io mirror (Docker Hub uses 10.0.0.1)
    nested_ssh "ip addr show vmbr1 | grep -q '10.0.0.2/' || ip addr add 10.0.0.2/24 dev vmbr1"

    # Start Docker Hub mirror (bound to 10.0.0.1 on ports 80+443)
    # Port 443: skopeo and Docker HTTPS attempts hit here
    # Port 80: Docker HTTP fallback (insecure-registries) hits here
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

    # Start ghcr.io mirror (bound to 10.0.0.2 on ports 80+443)
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

    # Configure Docker daemon: use mirror for Docker Hub pulls (registry-mirrors).
    # Insecure-registries for direct mirror access by IP.
    # NOTE: dnsmasq address= records are added AFTER pre-pull to avoid the Docker
    # daemon resolving registry-1.docker.io to the mirror IP on fallback.
    nested_ssh "cat > /etc/docker/daemon.json <<'DJSON'
{
  \"registry-mirrors\": [\"http://10.0.0.1:80\"],
  \"insecure-registries\": [\"10.0.0.1:80\", \"10.0.0.1:443\", \"10.0.0.2:80\", \"10.0.0.2:443\"]
}
DJSON
    systemctl restart docker >&2 2>/dev/null || true"

    # Wait for mirrors to be healthy after docker restart
    info "Waiting for mirrors to be healthy..."
    for mirror in "10.0.0.1:80" "10.0.0.2:80"; do
        for i in $(seq 1 30); do
            nested_ssh "curl -s http://$mirror/v2/ >/dev/null 2>&1" && break
            sleep 1
        done
    done
    success "Mirrors healthy"

    # Pre-pull images through the mirrors (warms mirror cache).
    # Docker Hub images use registry-mirrors automatically.
    # ghcr.io images: pull through mirror directly by IP (no registry-mirrors support).
    info "Pre-pulling images through mirrors (warming cache)..."
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
                # ghcr.io: pull through mirror directly by address
                mirror_path="${image#ghcr.io/}"
                nested_ssh "docker pull 10.0.0.2:80/${mirror_path}:${tag}" < /dev/null 2>&1 || echo "    Warning: $full failed"
            else
                # Docker Hub: registry-mirrors handles the routing automatically
                nested_ssh "docker pull '$full'" < /dev/null 2>&1 || echo "    Warning: $full failed"
            fi
        done
        success "Image pre-pull complete"
    else
        info "versions.sh not found, skipping pre-pull"
    fi

    # NOW add dnsmasq address= records for LXC containers (after pre-pull).
    # LXC containers resolve registry hostnames via dnsmasq → mirror IPs.
    # Added after pre-pull so Docker daemon doesn't hit mirror on fallback.
    nested_ssh "
        if ! grep -q 'address=/registry-1.docker.io/' /etc/dnsmasq.d/e2e-nat.conf 2>/dev/null; then
            cat >> /etc/dnsmasq.d/e2e-nat.conf <<'DNS'
# Registry mirror redirects (for LXC containers)
address=/registry-1.docker.io/10.0.0.1
address=/index.docker.io/10.0.0.1
address=/ghcr.io/10.0.0.2
DNS
            systemctl restart dnsmasq
        fi
    "
    success "dnsmasq registry redirects configured"
fi

# Step 7: Create snapshot with deployer installed (VM must be stopped for clean snapshot)
if [ "$UPDATE_ONLY" != "true" ]; then
    header "Creating Snapshot"
    info "Stopping nested VM $TEST_VMID for clean snapshot..."
    pve_ssh "qm shutdown $TEST_VMID --timeout 60"
    for i in $(seq 1 60); do
        pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null && break
        sleep 1
    done
    pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null \
        || error "VM $TEST_VMID did not shut down cleanly — cannot create reliable snapshot"
    pve_ssh "qm delsnapshot $TEST_VMID deployer-installed 2>/dev/null || true"
    pve_ssh "qm snapshot $TEST_VMID deployer-installed --description 'Nested VM with oci-lxc-deployer after step2'"
    success "Snapshot 'deployer-installed' created"
    pve_ssh "qm start $TEST_VMID"
    info "Waiting for deployer API after VM restart..."
    api_ready=false
    for i in $(seq 1 60); do
        if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
            api_ready=true; break
        fi
        if nested_ssh "curl -sk --connect-timeout 1 https://$DEPLOYER_IP:3443/ 2>/dev/null" | grep -q "doctype"; then
            api_ready=true; break
        fi
        printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" "$i"
        sleep 1
    done
    echo ""
    if [ "$api_ready" = "true" ]; then
        success "Deployer API is ready"
    else
        error "Deployer API not reachable after 60s"
    fi
fi

# Summary
TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
if [ "$UPDATE_ONLY" = "true" ]; then
    echo -e "${GREEN}  Code deployed in ${TOTAL_TIME}${NC}"
else
    echo -e "${GREEN}  Step 2 Complete in ${TOTAL_TIME}${NC}"
fi
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Instance: $E2E_INSTANCE"
echo "Deployer HTTP:  $DEPLOYER_URL"
echo "Deployer HTTPS: $DEPLOYER_HTTPS_URL"
echo "Deployer VMID:  $DEPLOYER_VMID"
echo ""
if [ "$UPDATE_ONLY" != "true" ]; then
    echo "Quick update: ./step2-install-deployer.sh $E2E_INSTANCE --update-only"
fi
