#!/bin/bash
# step0-create-iso.sh - Creates custom Proxmox ISO for E2E testing
#
# This script runs on the DEVELOPMENT MACHINE and:
# 1. Connects to pve1.cluster via SSH
# 2. Copies necessary files to /tmp/e2e-iso-build/
# 3. Executes create-iso.sh on pve1 to build the ISO
# 4. ISO is placed at /var/lib/vz/template/iso/proxmox-ve-e2e-<instance>.iso
#
# Usage:
#   ./step0-create-iso.sh [instance]   # Use specific instance from config.json
#   ./step0-create-iso.sh              # Use default instance

set -e

# Configuration
WORK_DIR="/tmp/e2e-iso-build"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPTS="$SCRIPT_DIR/pve1-scripts"

# Load configuration
source "$SCRIPT_DIR/config.sh"
load_config "${1:-}"

# Use config values
NESTED_STATIC_IP="${SUBNET}.10"
GATEWAY="${SUBNET}.1"
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

# SSH wrapper with standard options
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

pve_scp() {
    scp -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 "$@"
}

header "Step 0: Create Proxmox E2E Test ISO"
echo "Instance:       $E2E_INSTANCE"
echo "Target Host:    $PVE_HOST"
echo "Work Directory: $WORK_DIR"
echo "NAT Subnet:     ${SUBNET}.0/24"
echo "Nested VM IP:   $NESTED_STATIC_IP"
echo "Bridge:         $VM_BRIDGE"
echo "Filesystem:     $FILESYSTEM"
echo ""

# Step 1: Verify SSH connection
info "Checking SSH connection to $PVE_HOST..."
if ! pve_ssh "echo 'SSH OK'" &>/dev/null; then
    error "Cannot connect to $PVE_HOST via SSH. Please ensure:
  - SSH key is configured (ssh-copy-id root@$PVE_HOST)
  - Host is reachable
  - Hostname resolves correctly"
fi
success "SSH connection verified"

# Step 2: Verify we're connecting to a Proxmox host
info "Verifying Proxmox VE installation..."
PVE_VERSION=$(pve_ssh "pveversion 2>/dev/null || echo 'not-proxmox'")
if [[ "$PVE_VERSION" == "not-proxmox" ]]; then
    error "$PVE_HOST does not appear to be a Proxmox VE host"
fi
success "Proxmox VE detected: $PVE_VERSION"

# Step 3: Setup NAT network bridge for E2E test VMs
info "Setting up NAT network ($VM_BRIDGE) on $PVE_HOST..."

# Get node name
PVE_NODE=$(pve_ssh "hostname")

# Create bridge in Proxmox config if not already configured
if pve_ssh "pvesh get /nodes/$PVE_NODE/network/$VM_BRIDGE" &>/dev/null; then
    success "$VM_BRIDGE already in Proxmox config"
else
    info "Creating $VM_BRIDGE in Proxmox config..."
    pve_ssh "pvesh create /nodes/$PVE_NODE/network \
        --iface $VM_BRIDGE \
        --type bridge \
        --address $GATEWAY \
        --netmask 255.255.255.0 \
        --autostart 1 \
        --comments 'NAT bridge for E2E instance $E2E_INSTANCE'"
    pve_ssh "pvesh set /nodes/$PVE_NODE/network"
    success "$VM_BRIDGE added to Proxmox config"
fi

# Ensure bridge is up in kernel (may not be after config-only creation or reboot)
if pve_ssh "ip link show $VM_BRIDGE" &>/dev/null; then
    pve_ssh "ifup $VM_BRIDGE 2>/dev/null || true"
else
    info "Bringing up $VM_BRIDGE..."
    pve_ssh "ifup $VM_BRIDGE 2>/dev/null || true"
fi

# Verify bridge is up with correct IP
if pve_ssh "ip addr show $VM_BRIDGE | grep -q '$GATEWAY'" 2>/dev/null; then
    success "$VM_BRIDGE is up ($GATEWAY)"
else
    info "$VM_BRIDGE missing IP, configuring manually..."
    pve_ssh "ip link add name $VM_BRIDGE type bridge 2>/dev/null || true
        ip addr add $GATEWAY/24 dev $VM_BRIDGE 2>/dev/null || true
        ip link set $VM_BRIDGE up"
    success "$VM_BRIDGE brought up manually ($GATEWAY)"
fi

# Enable IP forwarding and NAT masquerading
pve_ssh "
    echo 1 > /proc/sys/net/ipv4/ip_forward
    echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-e2e-nat.conf
    iptables -t nat -C POSTROUTING -s '${SUBNET}.0/24' -o vmbr0 -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -s '${SUBNET}.0/24' -o vmbr0 -j MASQUERADE
"

# Make NAT rules persistent (per-instance file)
pve_ssh "cat > /etc/network/interfaces.d/e2e-nat-${E2E_INSTANCE} << EOF
# NAT rules for E2E instance $E2E_INSTANCE ($VM_BRIDGE, ${SUBNET}.0/24)
post-up iptables -t nat -A POSTROUTING -s '${SUBNET}.0/24' -o vmbr0 -j MASQUERADE
post-down iptables -t nat -D POSTROUTING -s '${SUBNET}.0/24' -o vmbr0 -j MASQUERADE
EOF"

# Step 3c: Setup port forwarding to nested VM
info "Setting up port forwarding to nested VM..."
pve_ssh "
    # Remove existing rules if present (ignore errors)
    iptables -t nat -D PREROUTING -p tcp --dport $PORT_PVE_SSH -j DNAT --to-destination ${NESTED_STATIC_IP}:22 2>/dev/null || true
    iptables -t nat -D PREROUTING -p tcp --dport $PORT_PVE_WEB -j DNAT --to-destination ${NESTED_STATIC_IP}:8006 2>/dev/null || true

    # Add port forwarding rules
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_PVE_SSH -j DNAT --to-destination ${NESTED_STATIC_IP}:22
    iptables -t nat -A PREROUTING -p tcp --dport $PORT_PVE_WEB -j DNAT --to-destination ${NESTED_STATIC_IP}:8006
"
success "Port forwarding configured: $PORT_PVE_SSH->SSH, $PORT_PVE_WEB->WebUI"

# Step 3b: Setup DHCP server on bridge
# Always update config to match current instance subnet
info "Configuring DHCP server (dnsmasq) on $VM_BRIDGE for ${SUBNET}.0/24..."
pve_ssh "
    # Install dnsmasq if needed
    which dnsmasq >/dev/null 2>&1 || apt-get install -y -qq dnsmasq

    # Remove old-style config file (from pre-bridge-per-instance code)
    rm -f /etc/dnsmasq.d/vmbr1-dhcp.conf

    # Configure DHCP for instance bridge (per-instance config file)
    cat > /etc/dnsmasq.d/e2e-${E2E_INSTANCE}-dhcp.conf << EOF
# DHCP for E2E instance $E2E_INSTANCE on $VM_BRIDGE
interface=$VM_BRIDGE
bind-interfaces
dhcp-range=${SUBNET}.100,${SUBNET}.200,24h
dhcp-option=option:router,$GATEWAY
dhcp-option=option:dns-server,8.8.8.8,8.8.4.4
EOF

    # Restart dnsmasq
    systemctl enable dnsmasq
    systemctl restart dnsmasq
"

# Verify dnsmasq is running
if pve_ssh "systemctl is-active dnsmasq" 2>/dev/null | grep -q "active"; then
    success "DHCP configured on $VM_BRIDGE: ${SUBNET}.100-200 (instance: $E2E_INSTANCE)"
else
    info "dnsmasq failed to start - checking logs..."
    pve_ssh "journalctl -u dnsmasq --no-pager -n 5" 2>/dev/null || true
    error "dnsmasq failed to start on $VM_BRIDGE. Check logs above."
fi

# Step 4: Check local files exist
info "Checking local script files..."
for file in create-iso.sh first-boot.sh.template; do
    if [ ! -f "$HOST_SCRIPTS/$file" ]; then
        error "Required file not found: $HOST_SCRIPTS/$file"
    fi
done
success "All required files present"

# Generate first-boot.sh with host-specific IP
info "Generating first-boot.sh with IP $NESTED_STATIC_IP..."
sed -e "s/{{STATIC_IP}}/$NESTED_STATIC_IP/g" \
    -e "s/{{GATEWAY}}/$GATEWAY/g" \
    "$HOST_SCRIPTS/first-boot.sh.template" > "/tmp/first-boot.sh"
success "first-boot.sh generated"

# Generate answer-e2e.toml based on filesystem type
info "Generating answer-e2e.toml (filesystem: $FILESYSTEM)..."
cat > "/tmp/answer-e2e.toml" << EOF
# Proxmox VE E2E Test - Automated Installation Answer File
# Generated by step0-create-iso.sh for instance: $E2E_INSTANCE

[global]
keyboard = "de"
country = "de"
fqdn = "pve-e2e-nested.local"
mailto = "test@localhost"
timezone = "Europe/Berlin"
root-password = "$NESTED_PASSWORD"
reboot-on-error = false

root-ssh-keys = [
    "PLACEHOLDER_PVE1_SSH_KEY",
    "PLACEHOLDER_DEV_SSH_KEY"
]

[network]
source = "from-dhcp"

[disk-setup]
filesystem = "$FILESYSTEM"
disk-list = ["sda"]
EOF

# Add filesystem-specific configuration
if [ "$FILESYSTEM" = "zfs" ]; then
    cat >> "/tmp/answer-e2e.toml" << EOF

[disk-setup.zfs]
raid = "raid0"
EOF
elif [ "$FILESYSTEM" = "ext4" ]; then
    cat >> "/tmp/answer-e2e.toml" << EOF

[disk-setup.lvm]
swapsize = $SWAP_SIZE
maxroot = 30
EOF
fi

# Add first-boot section
cat >> "/tmp/answer-e2e.toml" << EOF

[first-boot]
source = "from-iso"
ordering = "network-online"
EOF
success "answer-e2e.toml generated"

# Step 4: Create work directory on pve1
info "Creating work directory on $PVE_HOST..."
pve_ssh "mkdir -p $WORK_DIR"
success "Work directory created: $WORK_DIR"

# Step 5: Copy files to target host
info "Copying files to $PVE_HOST:$WORK_DIR/..."
pve_scp "/tmp/answer-e2e.toml" "root@$PVE_HOST:$WORK_DIR/"
pve_scp "$HOST_SCRIPTS/create-iso.sh" "root@$PVE_HOST:$WORK_DIR/"
pve_scp "/tmp/first-boot.sh" "root@$PVE_HOST:$WORK_DIR/"

# Copy dev machine's SSH public key for direct access to nested VM
info "Copying dev machine SSH key..."
if [ -f ~/.ssh/id_ed25519.pub ]; then
    pve_scp ~/.ssh/id_ed25519.pub "root@$PVE_HOST:$WORK_DIR/dev_ssh_key.pub"
    success "Dev SSH key (ed25519) copied"
elif [ -f ~/.ssh/id_rsa.pub ]; then
    pve_scp ~/.ssh/id_rsa.pub "root@$PVE_HOST:$WORK_DIR/dev_ssh_key.pub"
    success "Dev SSH key (rsa) copied"
else
    info "No dev SSH key found - only pve1 will have access to nested VM"
fi

success "Files copied successfully"

# Step 6: Make scripts executable
info "Setting execute permissions..."
pve_ssh "chmod +x $WORK_DIR/*.sh"
success "Permissions set"

# Step 7: Remove old E2E ISO to ensure fresh build
info "Checking for old E2E ISO..."
if pve_ssh "test -f /var/lib/vz/template/iso/$ISO_NAME"; then
    pve_ssh "rm -f /var/lib/vz/template/iso/$ISO_NAME"
    success "Old ISO removed"
else
    info "No old ISO found, skipping removal"
fi

# Step 8: Execute create-iso.sh on pve1
header "Executing ISO creation on $PVE_HOST"
info "This may take a few minutes..."
echo ""

# Run the script and capture output
if pve_ssh "cd $WORK_DIR && ./create-iso.sh $WORK_DIR $E2E_INSTANCE"; then
    echo ""
    header "ISO Creation Complete"
    success "Custom Proxmox ISO created successfully!"
    echo ""
    echo "ISO Location: $PVE_HOST:/var/lib/vz/template/iso/$ISO_NAME"
    echo ""
    echo "Next steps:"
    echo "  1. Run step1-create-vm.sh to create a test VM with this ISO"
    echo "  2. Or manually create a VM:"
    echo "     ssh root@$PVE_HOST"
    echo "     qm create 9000 --name pve-e2e-test --memory 4096 --cores 2 \\"
    echo "       --cpu host --net0 virtio,bridge=$VM_BRIDGE --scsi0 local-lvm:32 \\"
    echo "       --cdrom local:iso/$ISO_NAME --boot order=scsi0"
    echo ""
else
    error "ISO creation failed. Check the output above for details."
fi
