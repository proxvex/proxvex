#!/bin/bash
# step1-create-vm.sh - Creates nested Proxmox VM for E2E testing
#
# This script:
# 1. Creates a QEMU VM on the PVE host with the custom ISO
# 2. Waits for unattended Proxmox installation + first-boot (Static IP only)
# 3. Copies SSH keys for passwordless access
# 4. Configures repos, runs apt dist-upgrade, installs tools
# 5. Loads kernel modules for Docker-in-LXC
# 6. Sets up vmbr1 NAT bridge + dnsmasq DHCP for containers
# 7. Reboots to apply kernel upgrade + verifies everything
# 8. Configures port forwarding on PVE host
#
# After this step, subsequent steps can connect directly to the nested VM.
#
# Usage:
#   ./step1-create-vm.sh              # Use default pve1.cluster
#   ./step1-create-vm.sh pve2.cluster # Use different host
#   KEEP_VM=1 ./step1-create-vm.sh    # Don't cleanup existing VM

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load shared configuration
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

# Load config: use positional arg as instance name, or default
load_config "${1:-}"

ISO_NAME="proxmox-ve-e2e-${E2E_INSTANCE}.iso"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }
header() { echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"; }

# SSH wrapper for pve1
# Uses /dev/null for known_hosts to avoid host key conflicts during E2E testing
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

# SSH wrapper for nested VM via port forwarding on PVE host
# Connects directly through PVE_HOST:PORT_PVE_SSH -> nested VM:22
nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
}

# Store nested VM IP for later steps
NESTED_IP_FILE="$SCRIPT_DIR/.nested-vm-ip"

header "Step 1: Create Nested Proxmox VM"
echo "Proxmox Host: $PVE_HOST"
echo "Test VM ID: $TEST_VMID"
echo "VM Name: $VM_NAME"
echo ""

# Step 1: Check SSH connection to pve1
info "Checking SSH connection to $PVE_HOST..."
if ! pve_ssh "echo 'SSH OK'" &>/dev/null; then
    error "Cannot connect to $PVE_HOST via SSH"
fi
success "SSH connection verified"

# Step 2: Check if ISO exists
info "Checking for ISO: $ISO_NAME"
if ! pve_ssh "test -f /var/lib/vz/template/iso/$ISO_NAME"; then
    error "ISO not found: $ISO_NAME
Run: ./step0-create-iso.sh $E2E_INSTANCE"
fi
success "ISO found: $ISO_NAME"

# Step 3: Cleanup existing VM (unless KEEP_VM is set)
if [ -z "$KEEP_VM" ]; then
    if pve_ssh "qm status $TEST_VMID" &>/dev/null; then
        info "Removing existing VM $TEST_VMID (force)..."
        # Force stop immediately - no graceful shutdown for test VMs
        pve_ssh "qm stop $TEST_VMID --skiplock --timeout 5" 2>/dev/null || true
        # Destroy with force and purge
        pve_ssh "qm destroy $TEST_VMID --purge --skiplock" 2>/dev/null || true

        # Wait up to 60 seconds for VM to be gone
        WAIT_COUNT=0
        while pve_ssh "qm status $TEST_VMID" &>/dev/null; do
            WAIT_COUNT=$((WAIT_COUNT + 1))
            if [ $WAIT_COUNT -ge 60 ]; then
                error "Failed to remove existing VM $TEST_VMID after 60 seconds"
            fi
            printf "\r${YELLOW}[INFO]${NC} Waiting for VM deletion... %ds" $WAIT_COUNT
            sleep 1
        done
        [ $WAIT_COUNT -gt 0 ] && echo ""
        success "Existing VM removed"
    fi
fi

# Step 4: Create VM
info "Creating VM $TEST_VMID (disk: ${VM_DISK_SIZE}G on $VM_STORAGE)..."
pve_ssh "qm create $TEST_VMID \
    --name $VM_NAME \
    --memory $VM_MEMORY \
    --cores $VM_CORES \
    --cpu host \
    --bios ovmf \
    --machine q35 \
    --efidisk0 $VM_STORAGE:1,efitype=4m,pre-enrolled-keys=0 \
    --net0 virtio,bridge=$VM_BRIDGE \
    --scsihw virtio-scsi-pci \
    --scsi0 $VM_STORAGE:$VM_DISK_SIZE \
    --cdrom local:iso/$ISO_NAME \
    --ostype l26 \
    --onboot 1"
success "VM created"

# Step 5: Start VM
info "Starting VM..."
pve_ssh "qm start $TEST_VMID"
success "VM started"

# Step 6: Wait for installation to complete
header "Waiting for Proxmox Installation"
info "This typically takes 5-10 minutes..."
info "The VM will reboot automatically after installation."
info "Network: $VM_BRIDGE - Static IP: $NESTED_STATIC_IP"

# Clean up any old known_hosts entries for the nested VM
# (VM was recreated, so host key has changed)
ssh-keygen -R "[$PVE_HOST]:$PORT_PVE_SSH" 2>/dev/null || true

# Ensure SSH port forwarding exists BEFORE polling
# (step0 may have used different ports, or rules may have been cleared)
info "Ensuring port forwarding: $PVE_HOST:$PORT_PVE_SSH -> $NESTED_STATIC_IP:22"
pve_ssh "
    iptables -t nat -D PREROUTING -p tcp --dport $PORT_PVE_SSH -j DNAT --to-destination $NESTED_STATIC_IP:22 2>/dev/null || true
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_PVE_SSH -j DNAT --to-destination $NESTED_STATIC_IP:22
    iptables -C FORWARD -p tcp -d $NESTED_STATIC_IP --dport 22 -j ACCEPT 2>/dev/null || iptables -A FORWARD -p tcp -d $NESTED_STATIC_IP --dport 22 -j ACCEPT
    iptables -t nat -C POSTROUTING -s ${SUBNET}.0/24 -o vmbr0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s ${SUBNET}.0/24 -o vmbr0 -j MASQUERADE
"

# Wait for SSH to become available via port forwarding
MAX_WAIT=900  # 15 minutes (installation can take a while)
WAITED=0
INTERVAL=15
LAST_SSH_STATUS=""
info "Polling SSH: root@$PVE_HOST:$PORT_PVE_SSH"

while [ $WAITED -lt $MAX_WAIT ]; do
    # Try SSH via port forwarding (keys were injected via ISO answer file)
    SSH_OUTPUT=$(ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -p "$PORT_PVE_SSH" "root@$PVE_HOST" 'echo SSH_OK' 2>&1) || true
    if echo "$SSH_OUTPUT" | grep -q "SSH_OK"; then
        echo ""
        success "Installation complete - SSH accessible at $PVE_HOST:$PORT_PVE_SSH"
        break
    fi

    # Extract short status from SSH output (e.g. "Connection refused", "Connection timed out")
    SSH_STATUS=$(echo "$SSH_OUTPUT" | grep -oE 'Connection (refused|timed out|reset)|No route to host|Host is down' | head -1)
    [ -z "$SSH_STATUS" ] && [ -n "$SSH_OUTPUT" ] && SSH_STATUS="$SSH_OUTPUT"

    # Log when status changes
    if [ -n "$SSH_STATUS" ] && [ "$SSH_STATUS" != "$LAST_SSH_STATUS" ]; then
        echo ""
        info "SSH: $SSH_STATUS"
        LAST_SSH_STATUS="$SSH_STATUS"
    fi

    # Show progress
    PROGRESS=$((WAITED * 100 / MAX_WAIT))
    printf "\r${YELLOW}[INFO]${NC} Waiting for installation... %d%% (%ds/%ds)" $PROGRESS $WAITED $MAX_WAIT

    sleep $INTERVAL
    WAITED=$((WAITED + INTERVAL))
done

echo ""  # New line after progress

if [ $WAITED -ge $MAX_WAIT ]; then
    error "Timeout waiting for installation to complete after ${MAX_WAIT}s
Check VM console at: https://$PVE_HOST:8006/#v1:0:=qemu%2F$TEST_VMID"
fi

# Step 7: Copy SSH keys and wait for services

# Note: Proxmox VE uses /etc/pve/priv/authorized_keys (symlinked from ~/.ssh/authorized_keys)
# On fresh installations, /etc/pve/priv/ may not exist yet, so we create it
# Fallback to ~/.ssh/authorized_keys if /etc/pve/priv/ doesn't work

info "Copying PVE host SSH keys to nested VM..."
PVE_HOST_PUBKEY=$(pve_ssh "cat ~/.ssh/id_rsa.pub 2>/dev/null || cat ~/.ssh/id_ed25519.pub 2>/dev/null")

# Copy local machine's SSH key
LOCAL_PUBKEY=""
for keyfile in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub; do
    if [ -f "$keyfile" ]; then
        LOCAL_PUBKEY=$(cat "$keyfile")
        break
    fi
done

# Combine all keys
ALL_KEYS=""
[ -n "$PVE_HOST_PUBKEY" ] && ALL_KEYS="$PVE_HOST_PUBKEY"
if [ -n "$LOCAL_PUBKEY" ]; then
    [ -n "$ALL_KEYS" ] && ALL_KEYS="$ALL_KEYS"$'\n'"$LOCAL_PUBKEY" || ALL_KEYS="$LOCAL_PUBKEY"
fi

if [ -n "$ALL_KEYS" ]; then
    # Pipe keys directly to nested VM via port forwarding
    echo "$ALL_KEYS" | nested_ssh "
        # Try PVE standard location first
        if [ -d /etc/pve/priv ] || mkdir -p /etc/pve/priv 2>/dev/null; then
            cat >> /etc/pve/priv/authorized_keys
            chmod 600 /etc/pve/priv/authorized_keys
            echo 'Keys installed to /etc/pve/priv/authorized_keys'
        else
            # Fallback to standard SSH location
            mkdir -p ~/.ssh
            cat >> ~/.ssh/authorized_keys
            chmod 600 ~/.ssh/authorized_keys
            echo 'Keys installed to ~/.ssh/authorized_keys (fallback)'
        fi
    " || error "Failed to copy SSH keys"
    success "SSH keys copied to nested VM"
else
    info "No SSH keys found to copy"
fi

# Verify SSH keys were actually copied (check both locations)
info "Verifying SSH keys..."
KEY_COUNT=$(nested_ssh "
    count=0
    [ -f /etc/pve/priv/authorized_keys ] && count=\$(cat /etc/pve/priv/authorized_keys | wc -l)
    [ \"\$count\" -eq 0 ] && [ -f ~/.ssh/authorized_keys ] && count=\$(cat ~/.ssh/authorized_keys | wc -l)
    echo \$count
" 2>/dev/null)
if [ "$KEY_COUNT" -lt 1 ]; then
    error "SSH keys not found in authorized_keys (count: $KEY_COUNT)"
fi
success "Verified $KEY_COUNT SSH key(s) in authorized_keys"

# Sync filesystem to ensure keys are flushed to disk before snapshot
info "Syncing filesystem..."
nested_ssh "sync" || true
success "Filesystem synced"

NESTED_IP="$NESTED_STATIC_IP"
success "Nested VM IP: $NESTED_IP"

# Save IP for subsequent steps
echo "$NESTED_IP" > "$NESTED_IP_FILE"
info "IP saved to $NESTED_IP_FILE"

# Step 9: Verify Proxmox is running
info "Verifying Proxmox VE installation..."
PVE_VERSION=$(nested_ssh "pveversion 2>/dev/null" 2>/dev/null || echo "unknown")

if [[ "$PVE_VERSION" == *"pve-manager"* ]]; then
    success "Proxmox VE verified: $PVE_VERSION"
else
    info "Could not verify Proxmox version (may need time to fully initialize)"
fi

# Step 9b: Wait for first-boot.sh to complete
# first-boot.sh only configures Static IP + DNS now, so it completes quickly
info "Waiting for first-boot script to complete..."
FIRST_BOOT_TIMEOUT=120
FIRST_BOOT_WAITED=0
while [ $FIRST_BOOT_WAITED -lt $FIRST_BOOT_TIMEOUT ]; do
    # Note: This is a oneshot service with RemainAfterExit=yes, so status is "active" when done
    FB_STATUS=$(nested_ssh "systemctl is-active proxmox-first-boot-network-online.service 2>/dev/null; true" 2>/dev/null | tr -d '[:space:]')
    case "$FB_STATUS" in
        active|inactive) break ;;
        failed)
            info "First-boot service failed - checking logs..."
            nested_ssh "journalctl -u proxmox-first-boot-network-online.service --no-pager -n 20" 2>/dev/null || true
            break ;;
    esac
    sleep 5
    FIRST_BOOT_WAITED=$((FIRST_BOOT_WAITED + 5))
    if [ $((FIRST_BOOT_WAITED % 30)) -eq 0 ]; then
        info "Still waiting for first-boot... ${FIRST_BOOT_WAITED}s/$FIRST_BOOT_TIMEOUT"
    fi
done

if [ $FIRST_BOOT_WAITED -ge $FIRST_BOOT_TIMEOUT ]; then
    info "First-boot did not complete within ${FIRST_BOOT_TIMEOUT}s - continuing anyway"
elif [ "$FB_STATUS" = "failed" ]; then
    info "First-boot failed (${FIRST_BOOT_WAITED}s) - continuing with step1 configuration"
else
    success "First-boot completed (${FIRST_BOOT_WAITED}s)"
fi

# Step 10: Configure free Proxmox repositories and update system
header "Configuring Free Repositories & System Update"

info "Configuring no-subscription repository and disabling enterprise repos..."
nested_ssh "
    # Determine Debian codename (trixie for PVE 9.x, bookworm for PVE 8.x)
    CODENAME=\$(. /etc/os-release && echo \$VERSION_CODENAME)
    [ -z \"\$CODENAME\" ] && CODENAME=bookworm

    # Disable ALL enterprise repositories (require paid subscription)
    # Handle both .list (classic) and .sources (DEB822 format, PVE 9+/trixie)
    for f in /etc/apt/sources.list.d/*enterprise*.list /etc/apt/sources.list.d/ceph*.list \
             /etc/apt/sources.list.d/*enterprise*.sources /etc/apt/sources.list.d/ceph*.sources; do
        [ -f \"\$f\" ] && mv \"\$f\" \"\${f}.disabled\"
    done

    # Remove duplicate entries: if debian.sources exists, clear sources.list to avoid duplicates
    if [ -f /etc/apt/sources.list.d/debian.sources ] && [ -s /etc/apt/sources.list ]; then
        echo \"# Cleared to avoid duplicates with debian.sources\" > /etc/apt/sources.list
    fi

    # Add Proxmox no-subscription repository (free)
    cat > /etc/apt/sources.list.d/pve-no-subscription.list << REPOEOF
# Proxmox VE No-Subscription Repository (for testing/development)
deb http://download.proxmox.com/debian/pve \$CODENAME pve-no-subscription
REPOEOF
" || error "Failed to configure repositories"
success "Free Proxmox repositories configured"

info "Running apt update && apt dist-upgrade (this may take a few minutes)..."
nested_ssh "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -qq" || error "Failed to update packages"
success "System packages updated"

# Install tools needed for E2E testing
info "Installing additional tools..."
nested_ssh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq curl netcat-openbsd" || error "Failed to install tools"
success "Tools installed (jq, curl, netcat)"

# Install helper scripts on nested VM
info "Installing helper scripts..."
nested_ssh "cat > /usr/local/bin/pct-cleanup << 'SCRIPTEOF'
#!/bin/bash
# pct-cleanup - Destroy a range of LXC containers
# Usage: pct-cleanup <from> <to>
FROM=\${1:?Usage: pct-cleanup <from> <to>}
TO=\${2:?Usage: pct-cleanup <from> <to>}
for vmid in \$(seq \"\$FROM\" \"\$TO\"); do
    if pct status \"\$vmid\" &>/dev/null; then
        pct stop \"\$vmid\" 2>/dev/null
        pct destroy \"\$vmid\" --purge && echo \"Destroyed \$vmid\" || echo \"Failed to destroy \$vmid\"
    else
        echo \"Skipped \$vmid (not found)\"
    fi
done
SCRIPTEOF
chmod +x /usr/local/bin/pct-cleanup"
success "Helper scripts installed (pct-cleanup)"

# Step 10b: Configure kernel modules for Docker-in-LXC
header "Configuring Kernel Modules for Docker-in-LXC"

info "Loading and persisting kernel modules..."
nested_ssh "
    # Try to load modules immediately (may fail in nested VMs - that is OK)
    modprobe overlay 2>/dev/null || true
    modprobe ip_tables 2>/dev/null || true
    modprobe ip6_tables 2>/dev/null || true
    modprobe br_netfilter 2>/dev/null || true

    # Persist for next boot via systemd-modules-load
    mkdir -p /etc/modules-load.d
    cat > /etc/modules-load.d/docker.conf << MODEOF
overlay
ip_tables
ip6_tables
br_netfilter
MODEOF
" || error "Failed to configure kernel modules"

# Check if overlay is available now
if nested_ssh "lsmod | grep -q '^overlay ' || test -d /sys/module/overlay" 2>/dev/null; then
    success "Kernel modules loaded (overlay available)"
else
    info "Overlay module not loaded yet - will be available after reboot"
fi

# Step 10c: Create vmbr1 NAT bridge in nested VM for containers
header "Setting up Container NAT Bridge (vmbr1)"
info "Creating vmbr1 in nested VM for container networking..."

# Check if vmbr1 already exists
if nested_ssh "ip link show vmbr1" &>/dev/null; then
    success "vmbr1 already exists"
else
    # Add vmbr1 configuration to nested VM
    nested_ssh "cat >> /etc/network/interfaces << EOF

auto vmbr1
iface vmbr1 inet static
    address 10.0.0.1
    netmask 255.255.255.0
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up echo 1 > /proc/sys/net/ipv6/conf/vmbr1/disable_ipv6
    post-up iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
EOF
" || error "Failed to add vmbr1 configuration"

    # Bring up vmbr1
    nested_ssh "ifup vmbr1" || error "Failed to bring up vmbr1"
    success "vmbr1 created with NAT (10.0.0.0/24)"
fi

# Step 10d: Install and configure dnsmasq for DHCP on vmbr1
info "Setting up DHCP server (dnsmasq) on vmbr1..."
nested_ssh "
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dnsmasq

    cat > /etc/dnsmasq.d/e2e-nat.conf << DNSEOF
# E2E Test NAT Network DHCP
interface=vmbr1
bind-interfaces
dhcp-range=10.0.0.100,10.0.0.200,24h
dhcp-option=option:router,10.0.0.1
dhcp-option=option:dns-server,10.0.0.1,8.8.8.8
local=/e2e.local/
domain=e2e.local
expand-hosts
# Explicit upstream DNS (don't read /etc/resolv.conf which points to ourselves)
no-resolv
server=8.8.8.8
server=8.8.4.4
DNSEOF

    systemctl enable dnsmasq
    systemctl restart dnsmasq

    # Update host resolv.conf to use local dnsmasq as primary DNS.
    # This ensures containers with static IP (which inherit the host's resolv.conf)
    # can resolve other container hostnames via dnsmasq expand-hosts.
    echo 'nameserver 10.0.0.1' > /etc/resolv.conf
    echo 'nameserver 8.8.8.8' >> /etc/resolv.conf
" || error "Failed to configure dnsmasq"
success "DHCP server configured on vmbr1 (10.0.0.100-200, DNS: 10.0.0.1)"

# Step 10e: Reboot nested VM to apply kernel upgrade + load modules
header "Rebooting Nested VM"
info "Rebooting to apply kernel upgrade and load modules..."
nested_ssh "reboot" 2>/dev/null || true

# Wait for SSH to come back after reboot
info "Waiting for nested VM to come back online..."
REBOOT_TIMEOUT=180
REBOOT_WAITED=0
sleep 10  # Give it time to actually shut down

while [ $REBOOT_WAITED -lt $REBOOT_TIMEOUT ]; do
    if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes -p "$PORT_PVE_SSH" "root@$PVE_HOST" 'echo SSH_OK' 2>/dev/null | grep -q "SSH_OK"; then
        break
    fi
    sleep 5
    REBOOT_WAITED=$((REBOOT_WAITED + 5))
    if [ $((REBOOT_WAITED % 30)) -eq 0 ]; then
        info "Still waiting... ${REBOOT_WAITED}s/$REBOOT_TIMEOUT"
    fi
done

if [ $REBOOT_WAITED -ge $REBOOT_TIMEOUT ]; then
    error "Nested VM did not come back after reboot within ${REBOOT_TIMEOUT}s"
fi
success "Nested VM back online after reboot (${REBOOT_WAITED}s)"

# Verify kernel modules are loaded after reboot
info "Verifying kernel modules after reboot..."
if nested_ssh "lsmod | grep -q '^overlay ' || test -d /sys/module/overlay" 2>/dev/null; then
    success "Overlay module loaded"
else
    info "Warning: overlay module still not available after reboot"
fi

# Verify Proxmox version after upgrade + reboot
info "Verifying Proxmox version..."
PVE_FULL=$(nested_ssh "pveversion 2>/dev/null" 2>/dev/null || echo "unknown")
success "Proxmox version: $PVE_FULL"

# Verify vmbr1 and dnsmasq survived reboot
if nested_ssh "ip link show vmbr1" &>/dev/null; then
    success "vmbr1 active after reboot"
else
    info "Warning: vmbr1 not active after reboot - bringing up..."
    nested_ssh "ifup vmbr1" 2>/dev/null || true
fi

if nested_ssh "systemctl is-active dnsmasq" 2>/dev/null | grep -q "active"; then
    success "dnsmasq running after reboot"
else
    info "Warning: dnsmasq not running - restarting..."
    nested_ssh "systemctl restart dnsmasq" 2>/dev/null || true
fi

# Step 11: Set up port forwarding on PVE host to nested VM
header "Setting up Port Forwarding (offset: $PORT_OFFSET)"
info "Configuring port forwarding on $PVE_HOST..."

# Configure all port forwarding in a single SSH call for efficiency
pve_ssh "
    # Enable IP forwarding
    echo 1 > /proc/sys/net/ipv4/ip_forward

    # Remove ALL existing forwarding rules for this instance's IP
    # Generic cleanup: catches any stale rules regardless of port numbers
    iptables -t nat -S PREROUTING 2>/dev/null | grep -F '$NESTED_IP' | sed 's/^-A /-D /' | while IFS= read -r rule; do
        iptables -t nat \$rule 2>/dev/null || true
    done
    iptables -S FORWARD 2>/dev/null | grep -F '$NESTED_IP' | sed 's/^-A /-D /' | while IFS= read -r rule; do
        iptables \$rule 2>/dev/null || true
    done
    iptables -t nat -S POSTROUTING 2>/dev/null | grep -F '${SUBNET}.0/24' | sed 's/^-A /-D /' | while IFS= read -r rule; do
        iptables -t nat \$rule 2>/dev/null || true
    done

    # Add port forwarding rules
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_PVE_WEB -j DNAT --to-destination $NESTED_IP:8006
    iptables -A FORWARD -p tcp -d $NESTED_IP --dport 8006 -j ACCEPT
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_PVE_SSH -j DNAT --to-destination $NESTED_IP:22
    iptables -A FORWARD -p tcp -d $NESTED_IP --dport 22 -j ACCEPT
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_DEPLOYER -j DNAT --to-destination $NESTED_IP:3080
    iptables -A FORWARD -p tcp -d $NESTED_IP --dport 3080 -j ACCEPT
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_DEPLOYER_HTTPS -j DNAT --to-destination $NESTED_IP:3443
    iptables -A FORWARD -p tcp -d $NESTED_IP --dport 3443 -j ACCEPT

    # NAT for nested VM network
    iptables -t nat -A POSTROUTING -s ${SUBNET}.0/24 -o vmbr0 -j MASQUERADE
" || error "Failed to configure port forwarding"

success "Port $PORT_PVE_WEB -> $NESTED_IP:8006 (Web UI)"
success "Port $PORT_PVE_SSH -> $NESTED_IP:22 (SSH)"
success "Port $PORT_DEPLOYER -> $NESTED_IP:3080 (Deployer HTTP)"
success "Port $PORT_DEPLOYER_HTTPS -> $NESTED_IP:3443 (Deployer HTTPS)"
success "NAT configured for ${SUBNET}.0/24"

# Step 11b: Install persistent port forwarding service
header "Installing Persistent Port Forwarding Service"
info "This ensures port forwarding survives reboots and snapshot rollbacks..."
PVE_HOST="$PVE_HOST" "$SCRIPT_DIR/scripts/setup-port-forwarding-service.sh"
success "Persistent port forwarding service installed"

# Step 12: Create baseline snapshot (VM must be stopped for clean snapshot)
header "Creating Baseline Snapshot"
info "Stopping VM $TEST_VMID for clean snapshot..."
pve_ssh "qm shutdown $TEST_VMID --timeout 60"
for i in $(seq 1 60); do
    pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null && break
    sleep 1
done
pve_ssh "qm status $TEST_VMID 2>/dev/null | grep -q stopped" 2>/dev/null \
    || error "VM $TEST_VMID did not shut down cleanly — cannot create reliable snapshot"
pve_ssh "qm snapshot $TEST_VMID baseline --description 'Clean nested Proxmox VM after step1 setup'"
pve_ssh "qm start $TEST_VMID"
info "Waiting for VM to boot after snapshot..."
for i in $(seq 1 60); do
    nested_ssh "true" 2>/dev/null && break
    sleep 2
done
nested_ssh "true" 2>/dev/null || error "VM did not come back after snapshot"
success "Baseline snapshot created"

# Summary
header "Step 1 Complete"
echo -e "${GREEN}Nested Proxmox VM is ready!${NC}"
echo ""
echo "Instance: $E2E_INSTANCE"
echo ""
echo "VM Details:"
echo "  - VMID: $TEST_VMID"
echo "  - Name: $VM_NAME"
echo "  - IP Address: $NESTED_IP"
echo "  - Root Password: $NESTED_PASSWORD"
echo ""
echo "Network Configuration:"
echo "  - $VM_BRIDGE on $PVE_HOST: NAT network (${SUBNET}.0/24)"
echo "  - vmbr0 in nested VM: External network"
echo "  - vmbr1 in nested VM: NAT for containers (10.0.0.0/24)"
echo "  - dnsmasq DHCP: 10.0.0.100-200 on vmbr1"
echo ""
echo "Port Forwarding (offset: $PORT_OFFSET):"
echo "  - $PVE_HOST:$PORT_PVE_SSH -> $NESTED_IP:22 (SSH)"
echo "  - $PVE_HOST:$PORT_PVE_WEB -> $NESTED_IP:8006 (Web UI)"
echo "  - $PVE_HOST:$PORT_DEPLOYER -> deployer:3080 (Deployer HTTP)"
echo "  - $PVE_HOST:$PORT_DEPLOYER_HTTPS -> deployer:3443 (Deployer HTTPS)"
echo ""
echo "Access:"
echo "  SSH:     ssh -p $PORT_PVE_SSH root@$PVE_HOST"
echo "  Web UI:  $PVE_WEB_URL"
echo ""
echo "Next steps:"
echo "  ./step2-install-deployer.sh $E2E_INSTANCE"
echo ""
