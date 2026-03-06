#!/bin/bash
# step2-install-deployer.sh - Installs oci-lxc-deployer for E2E testing
#
# This script:
# 1. Connects to the nested Proxmox VM
# 2. Installs oci-lxc-deployer with custom OWNER settings
# 3. Waits for the API to be ready
# 4. Deploys the local package
#
# Usage:
#   ./step2-install-deployer.sh [instance]              # Full install
#   ./step2-install-deployer.sh [instance] --update-only  # Fast update (~15s)
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
INSTANCE_ARG=""
for arg in "$@"; do
    case "$arg" in
        --update-only) UPDATE_ONLY=true ;;
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

header "Step 2: Install oci-lxc-deployer"
echo "Instance: $E2E_INSTANCE"
echo "Connection: $PVE_HOST:$PORT_PVE_SSH -> $NESTED_IP:22"
echo "Owner: $OWNER"
echo "OCI Owner: $OCI_OWNER"
echo "Deployer VMID: $DEPLOYER_VMID"
echo "Deployer URL: $DEPLOYER_URL"
echo ""

# Step 1: Wait for SSH connection (VM might still be booting after snapshot restore)
info "Waiting for SSH connection to nested VM..."
SSH_READY=false
for i in $(seq 1 30); do
    if nested_ssh "echo 'SSH OK'" &>/dev/null; then
        SSH_READY=true
        break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for SSH... %ds" "$i"
    sleep 1
done
echo ""

if [ "$SSH_READY" != "true" ]; then
    error "Cannot connect to $NESTED_IP via SSH after 30s. Is the nested VM running?"
fi
success "SSH connection verified"

# Step 2: Check if deployer already exists
if nested_ssh "pct status $DEPLOYER_VMID" &>/dev/null; then
    info "Deployer container $DEPLOYER_VMID already exists"
    DEPLOYER_STATUS=$(nested_ssh "pct status $DEPLOYER_VMID" | awk '/status:/ {print $2}')
    if [ "$DEPLOYER_STATUS" = "running" ]; then
        success "Deployer container is running"

        # Check if API is responding
        DEPLOYER_IP=$(nested_ssh "pct exec $DEPLOYER_VMID -- hostname -I 2>/dev/null" | awk '{print $1}')
        if [ -n "$DEPLOYER_IP" ]; then
            if nested_ssh "curl -s http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
                success "API is healthy at $DEPLOYER_IP:3080"

                if [ "$UPDATE_ONLY" = "true" ]; then
                    info "--update-only: Skipping to local package deployment..."
                else
                    echo ""
                    echo "Deployer already installed and running!"
                    echo "API URL: http://$DEPLOYER_IP:3080"
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

    # Clean up existing container if present
    if nested_ssh "pct status $DEPLOYER_VMID" &>/dev/null; then
        info "Removing existing container $DEPLOYER_VMID (force)..."
        nested_ssh "pct stop $DEPLOYER_VMID --skiplock 2>/dev/null || true; sleep 1; pct unlock $DEPLOYER_VMID 2>/dev/null || true; pct destroy $DEPLOYER_VMID --force --purge 2>/dev/null || true"
        success "Existing container removed"
    fi

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
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER LOCAL_SCRIPT_PATH=$LOCAL_SCRIPT_PATH /tmp/install-oci-lxc-deployer.sh --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY --deployer-url $DEPLOYER_URL" || error "Installation script failed"
else
    info "Running installation script from GitHub with OWNER=$OWNER OCI_OWNER=$OCI_OWNER..."
    # Fallback: Download and run from GitHub
    nested_ssh "curl -sSL https://raw.githubusercontent.com/$OWNER/oci-lxc-deployer/main/install-oci-lxc-deployer.sh | \
        OWNER=$OWNER OCI_OWNER=$OCI_OWNER bash -s -- --vm-id $DEPLOYER_VMID --bridge $DEPLOYER_BRIDGE --static-ip $DEPLOYER_STATIC_IP --gateway $DEPLOYER_GATEWAY --deployer-url $DEPLOYER_URL" || error "Installation script from GitHub failed"
fi

success "Installation script completed"

# Step 4: Wait for container to be running (max 30s)
info "Waiting for deployer container to start..."
CONTAINER_STARTED=false
for i in $(seq 1 30); do
    if nested_ssh "pct status $DEPLOYER_VMID 2>/dev/null" | grep -q "running"; then
        success "Deployer container is running"
        CONTAINER_STARTED=true
        break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for container... %ds" "$i"
    sleep 1
done
echo ""
if [ "$CONTAINER_STARTED" != "true" ]; then
    error "Container $DEPLOYER_VMID failed to start within 30 seconds"
fi

# Step 4b: Manually bring up container network interfaces
# Alpine containers with static IP sometimes don't auto-activate the interfaces
info "Activating container network interfaces..."
nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
sleep 1

# Verify network is up
if nested_ssh "pct exec $DEPLOYER_VMID -- ping -c 1 $DEPLOYER_GATEWAY" &>/dev/null; then
    success "Container network is up (gateway reachable)"
else
    info "Warning: Gateway not reachable, network may have issues"
fi

# Step 4c: Add /etc/hosts entries for nested VM (required for SSH from deployer)
# The nested VM (PVE host for deployer) is reachable via the gateway in the NAT network
info "Adding /etc/hosts entries for nested VM..."
NESTED_HOSTNAME=$(nested_ssh "hostname")
# Build hosts entry: always include nested hostname (with and without .local)
HOSTS_ENTRY="$DEPLOYER_GATEWAY $NESTED_HOSTNAME ${NESTED_HOSTNAME}.local"
# Add PVE_HOST if set and different from nested hostname
if [ -n "$PVE_HOST" ] && [ "$PVE_HOST" != "$NESTED_HOSTNAME" ] && [ "$PVE_HOST" != "${NESTED_HOSTNAME}.local" ]; then
    HOSTS_ENTRY="$HOSTS_ENTRY $PVE_HOST"
fi
nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'echo \"$HOSTS_ENTRY\" >> /etc/hosts'"
success "Added hosts entry: $HOSTS_ENTRY"

# Step 5: Use static IP and wait for API
# Extract IP without CIDR suffix
DEPLOYER_IP="${DEPLOYER_STATIC_IP%/*}"
info "Deployer static IP: $DEPLOYER_IP"
info "Waiting for API to be ready (max 30s)..."
sleep 1  # Brief pause for container init

API_READY=false
for i in $(seq 1 30); do
    if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
        success "API is healthy at $DEPLOYER_IP:3080"
        API_READY=true
        break
    fi
    printf "\r${YELLOW}[INFO]${NC} Waiting for API... %ds" "$i"
    sleep 1
done
echo ""
if [ "$API_READY" != "true" ]; then
    error "API failed to respond within 30 seconds at $DEPLOYER_IP:3080"
fi

# Step 5a: Generate CA certificate and set domain suffix for SSL addon
info "Querying VE context from deployer API..."
VE_HOST=$(nested_ssh "curl -s http://$DEPLOYER_IP:3080/api/sshconfigs" | jq -r '.sshs[0].host // empty')
if [ -n "$VE_HOST" ]; then
    VE_CONTEXT="ve_${VE_HOST}"
    info "VE context: $VE_CONTEXT (host: $VE_HOST)"

    info "Generating CA certificate..."
    CA_RESULT=$(nested_ssh "curl -s -X POST http://$DEPLOYER_IP:3080/api/$VE_CONTEXT/ve/certificates/ca/generate")
    if echo "$CA_RESULT" | jq -e '.success' &>/dev/null; then
        success "CA certificate generated"
    else
        info "CA generation: $(echo "$CA_RESULT" | jq -r '.error // .message // "already exists or failed"')"
    fi

    info "Setting domain suffix to .e2e.local..."
    SUFFIX_RESULT=$(nested_ssh "curl -s -X POST -H 'Content-Type: application/json' -d '{\"domain_suffix\":\".e2e.local\"}' http://$DEPLOYER_IP:3080/api/$VE_CONTEXT/ve/certificates/domain-suffix")
    if echo "$SUFFIX_RESULT" | jq -e '.success' &>/dev/null; then
        success "Domain suffix set to .e2e.local"
    else
        info "Domain suffix: $(echo "$SUFFIX_RESULT" | jq -r '.error // "failed"')"
    fi
else
    info "Warning: No SSH config found, skipping CA generation and domain suffix setup"
fi

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
    NESTED_HOSTNAME=$(nested_ssh "hostname")
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

# Step 5c: Build and deploy local package (if LOCAL_PACKAGE is set or we're in the project directory)
if [ -f "$PROJECT_ROOT/package.json" ] && grep -q '"name": "oci-lxc-deployer"' "$PROJECT_ROOT/package.json"; then
    header "Deploying Local Package"
    cd "$PROJECT_ROOT"

    info "Building local oci-lxc-deployer package..."
    pnpm run build || error "Failed to build package"

    TARBALL=$(pnpm pack 2>&1 | grep -o 'oci-lxc-deployer-.*\.tgz')

    if [ -z "$TARBALL" ] || [ ! -f "$PROJECT_ROOT/$TARBALL" ]; then
        error "Failed to create package tarball"
    fi
    success "Created $TARBALL"

    # Copy tarball to nested VM first, then push to container
    info "Copying $TARBALL to nested VM..."
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -P "$PORT_PVE_SSH" "$PROJECT_ROOT/$TARBALL" "root@$PVE_HOST:/tmp/" || error "Failed to copy tarball to nested VM"
    success "Package copied to nested VM"

    # Push tarball from nested VM to deployer container using pct push
    info "Pushing $TARBALL to deployer container..."
    nested_ssh "pct push $DEPLOYER_VMID /tmp/$TARBALL /tmp/$TARBALL" || error "Failed to push tarball to container"
    success "Package pushed to container"

    # Verify network before package install
    info "Verifying container network..."
    if ! nested_ssh "pct exec $DEPLOYER_VMID -- ping -c 1 -W 2 1.1.1.1" &>/dev/null; then
        error "Container has no network - cannot install packages"
    fi
    success "Network verified"

    # Install package: extract, install prod deps, link globally
    # This approach is more reliable than npm install -g from tarball
    info "Installing package (production dependencies only)..."
    nested_ssh "pct exec $DEPLOYER_VMID -- sh -c '
        cd /tmp && \
        rm -rf package && \
        tar -xzf $TARBALL && \
        cd package && \
        npm install --omit=dev --no-audit --no-fund --ignore-scripts 2>/dev/null && \
        rm -rf /usr/local/lib/node_modules/oci-lxc-deployer && \
        mkdir -p /usr/local/lib/node_modules && \
        mv /tmp/package /usr/local/lib/node_modules/oci-lxc-deployer && \
        ln -sf /usr/local/lib/node_modules/oci-lxc-deployer/backend/dist/oci-lxc-deployer.mjs /usr/local/bin/oci-lxc-deployer
    '" || error "Failed to install package"
    success "Package installed"

    # Restart container to reload the updated code (PID 1 is oci-lxc-deployer)
    info "Restarting container..."
    nested_ssh "pct stop $DEPLOYER_VMID && sleep 1 && pct start $DEPLOYER_VMID" || error "Failed to restart container"
    sleep 2
    # Re-activate network after restart
    nested_ssh "pct exec $DEPLOYER_VMID -- sh -c 'ip link set lo up; ip link set eth0 up; ip addr add $DEPLOYER_STATIC_IP dev eth0 2>/dev/null; ip route add default via $DEPLOYER_GATEWAY 2>/dev/null' || true"
    success "Container restarted"

    # Wait for API to come back up (max 20s)
    info "Waiting for API to restart..."
    API_RESTARTED=false
    for i in $(seq 1 20); do
        if nested_ssh "curl -s --connect-timeout 1 http://$DEPLOYER_IP:3080/ 2>/dev/null" | grep -q "doctype"; then
            success "API is healthy after package update"
            API_RESTARTED=true
            break
        fi
        printf "\r${YELLOW}[INFO]${NC} Waiting for API restart... %ds" "$i"
        sleep 1
    done
    echo ""
    if [ "$API_RESTARTED" != "true" ]; then
        error "API failed to restart within 20 seconds"
    fi

    # Cleanup
    rm -f "$PROJECT_ROOT/$TARBALL"
    nested_ssh "rm -f /tmp/$TARBALL"
fi

# Step 6: Create snapshot with deployer installed (VM must be stopped for clean snapshot)
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
    pve_ssh "qm snapshot $TEST_VMID deployer-installed --description 'Nested VM with oci-lxc-deployer after step2'"
    success "Snapshot 'deployer-installed' created"
    pve_ssh "qm start $TEST_VMID"
    success "VM restarted"
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
echo "Deployer URL: $DEPLOYER_URL"
echo ""
if [ "$UPDATE_ONLY" != "true" ]; then
    echo "Quick update: ./step2-install-deployer.sh $E2E_INSTANCE --update-only"
fi
