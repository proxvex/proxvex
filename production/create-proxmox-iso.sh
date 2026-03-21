#!/bin/bash
# create-proxmox-iso.sh - Creates a self-installing Proxmox VE ISO for production
#
# Creates a ZFS-based Proxmox installation ISO with:
# - Static IP, gateway 192.168.4.1, DNS 192.168.4.1
# - German keyboard, Europe/Berlin timezone
# - SSH key authentication (keys from build host + dev machine)
# - Root password (change DEFAULT_ROOT_PASSWORD below)
#
# The ISO is built on a PVE host using proxmox-auto-install-assistant.
#
# Usage:
#   ./create-proxmox-iso.sh <ip-address> <hostname> [pve-host]
#
# Examples:
#   ./create-proxmox-iso.sh 192.168.4.50 pve-prod
#   ./create-proxmox-iso.sh 192.168.4.51 pve-backup pve1.cluster

set -e

# ============================================================
# Configuration - change these as needed
# ============================================================
DEFAULT_ROOT_PASSWORD="Proxmox2024!"  # CHANGE THIS for production!
GATEWAY="192.168.4.1"
DNS_SERVER="192.168.4.1"
NETMASK="255.255.255.0"
DOMAIN="local"
MAILTO="admin@ohnewarum.de"
DEFAULT_PVE_HOST="pve1.cluster"
PVE_VERSION="9.1-1"
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="/tmp/proxmox-iso-build"

# Parse arguments
IP_ADDRESS="${1:-}"
HOSTNAME="${2:-}"
PVE_HOST="${3:-$DEFAULT_PVE_HOST}"

if [ -z "$IP_ADDRESS" ] || [ -z "$HOSTNAME" ]; then
    echo "Usage: $0 <ip-address> <hostname> [pve-host]"
    echo ""
    echo "  ip-address   Static IPv4 address (e.g. 192.168.4.50)"
    echo "  hostname     Short hostname (e.g. pve-prod)"
    echo "  pve-host     PVE host to build ISO on (default: $DEFAULT_PVE_HOST)"
    echo ""
    echo "Examples:"
    echo "  $0 192.168.4.50 pve-prod"
    echo "  $0 192.168.4.51 pve-backup pve1.cluster"
    exit 1
fi

FQDN="${HOSTNAME}.${DOMAIN}"
ISO_NAME="proxmox-ve-${HOSTNAME}.iso"

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

# SSH wrappers
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}
pve_scp() {
    scp -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=10 "$@"
}

header "Create Production Proxmox ISO"
echo "Hostname:    $HOSTNAME ($FQDN)"
echo "IP Address:  $IP_ADDRESS"
echo "Gateway:     $GATEWAY"
echo "DNS:         $DNS_SERVER"
echo "Build Host:  $PVE_HOST"
echo "ISO Name:    $ISO_NAME"
echo ""

# Step 1: Verify SSH connection
info "Checking SSH connection to $PVE_HOST..."
if ! pve_ssh "echo 'SSH OK'" &>/dev/null; then
    error "Cannot connect to $PVE_HOST via SSH"
fi
success "SSH connection verified"

# Step 2: Verify Proxmox host
info "Verifying Proxmox VE installation..."
PVE_VER=$(pve_ssh "pveversion 2>/dev/null || echo 'not-proxmox'")
if [[ "$PVE_VER" == "not-proxmox" ]]; then
    error "$PVE_HOST is not a Proxmox VE host"
fi
success "Proxmox VE detected: $PVE_VER"

# Step 3: Generate answer file
info "Generating answer file..."
cat > "/tmp/answer-production.toml" << EOF
# Proxmox VE Production - Automated Installation Answer File
# Generated for: $HOSTNAME ($IP_ADDRESS)

[global]
keyboard = "de"
country = "de"
fqdn = "$FQDN"
mailto = "$MAILTO"
timezone = "Europe/Berlin"
root-password = "$DEFAULT_ROOT_PASSWORD"
reboot-on-error = false

root-ssh-keys = [
    "PLACEHOLDER_PVE_SSH_KEY",
    "PLACEHOLDER_DEV_SSH_KEY"
]

[network]
source = "from-answer"
cidr = "$IP_ADDRESS/24"
dns = "$DNS_SERVER"
gateway = "$GATEWAY"
filter.LANG = "de*"

[disk-setup]
filesystem = "zfs"
disk-list = ["sda"]

[disk-setup.zfs]
raid = "raid0"

[first-boot]
source = "from-iso"
ordering = "network-online"
EOF
success "answer-production.toml generated"

# Step 4: Generate first-boot script
info "Generating first-boot script..."
cat > "/tmp/first-boot-production.sh" << FBEOF
#!/bin/bash
# First boot script for production Proxmox installation
# Configures: free repos, DNS, QEMU guest agent

set -e

echo "=== Production: First Boot Configuration ===" >&2

# Configure DNS
echo "nameserver $DNS_SERVER" > /etc/resolv.conf
echo "Configured DNS: $DNS_SERVER" >&2

# Determine Debian codename
CODENAME=\$(. /etc/os-release && echo \$VERSION_CODENAME)
[ -z "\$CODENAME" ] && CODENAME=bookworm

# Disable enterprise repositories
for f in /etc/apt/sources.list.d/*enterprise*.list /etc/apt/sources.list.d/ceph*.list \
         /etc/apt/sources.list.d/*enterprise*.sources /etc/apt/sources.list.d/ceph*.sources; do
    [ -f "\$f" ] && mv "\$f" "\${f}.disabled"
done

# Add no-subscription repository
cat > /etc/apt/sources.list.d/pve-no-subscription.list << REPOEOF
deb http://download.proxmox.com/debian/pve \$CODENAME pve-no-subscription
REPOEOF

# Use European Debian mirror
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
    sed -i 's|URIs: http://deb.debian.org/debian|URIs: http://mirror.23m.com/debian|g' /etc/apt/sources.list.d/debian.sources
fi
if [ -s /etc/apt/sources.list ]; then
    sed -i 's|deb.debian.org|mirror.23m.com|g' /etc/apt/sources.list
fi
# Remove duplicate entries if debian.sources exists
if [ -f /etc/apt/sources.list.d/debian.sources ] && [ -s /etc/apt/sources.list ]; then
    echo "# Cleared to avoid duplicates with debian.sources" > /etc/apt/sources.list
fi

echo "Free Proxmox repositories configured (EU mirror)" >&2

# System update
echo "Running apt update && apt dist-upgrade..." >&2
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y -qq
echo "System updated" >&2

# Enable QEMU guest agent
systemctl enable qemu-guest-agent 2>/dev/null || true
systemctl start qemu-guest-agent 2>/dev/null || true

echo "=== Production: First boot complete ===" >&2
FBEOF
success "first-boot-production.sh generated"

# Step 5: Copy dev machine SSH key
info "Copying dev machine SSH key..."
DEV_KEY_FILE=""
for keyfile in ~/.ssh/id_ed25519.pub ~/.ssh/id_rsa.pub; do
    if [ -f "$keyfile" ]; then
        DEV_KEY_FILE="$keyfile"
        break
    fi
done

# Step 6: Create work directory and copy files to PVE host
info "Creating work directory on $PVE_HOST..."
pve_ssh "mkdir -p $WORK_DIR"

pve_scp "/tmp/answer-production.toml" "root@$PVE_HOST:$WORK_DIR/"
pve_scp "/tmp/first-boot-production.sh" "root@$PVE_HOST:$WORK_DIR/"
if [ -n "$DEV_KEY_FILE" ]; then
    pve_scp "$DEV_KEY_FILE" "root@$PVE_HOST:$WORK_DIR/dev_ssh_key.pub"
    success "Dev SSH key copied"
else
    info "No dev SSH key found"
fi
success "Files copied to $PVE_HOST"

# Step 7: Build ISO on PVE host
header "Building ISO on $PVE_HOST"
pve_ssh "
set -e
cd $WORK_DIR
ISO_DIR='/var/lib/vz/template/iso'
PVE_ISO_FILE='proxmox-ve_${PVE_VERSION}.iso'
PVE_ISO_URL='http://download.proxmox.com/iso/proxmox-ve_${PVE_VERSION}.iso'

# Install proxmox-auto-install-assistant if needed
if ! command -v proxmox-auto-install-assistant &>/dev/null; then
    echo '[INFO] Installing proxmox-auto-install-assistant...'
    apt-get update -qq
    apt-get install -y -qq proxmox-auto-install-assistant
fi

# Get Proxmox ISO
if [ -f \"\$ISO_DIR/\$PVE_ISO_FILE\" ]; then
    echo '[INFO] Copying cached ISO...'
    cp \"\$ISO_DIR/\$PVE_ISO_FILE\" \"$WORK_DIR/\$PVE_ISO_FILE\"
elif [ ! -f \"$WORK_DIR/\$PVE_ISO_FILE\" ]; then
    echo '[INFO] Downloading Proxmox VE ${PVE_VERSION} ISO (~1.8GB)...'
    wget -q -O \"\$PVE_ISO_FILE\" \"\$PVE_ISO_URL\" || {
        echo '[ERROR] Download failed' >&2; exit 1
    }
    cp \"\$PVE_ISO_FILE\" \"\$ISO_DIR/\$PVE_ISO_FILE\"
fi

# Inject SSH keys into answer file
PVE_SSH_KEY=''
[ -f /root/.ssh/id_ed25519.pub ] && PVE_SSH_KEY=\$(cat /root/.ssh/id_ed25519.pub)
[ -z \"\$PVE_SSH_KEY\" ] && [ -f /root/.ssh/id_rsa.pub ] && PVE_SSH_KEY=\$(cat /root/.ssh/id_rsa.pub)
if [ -z \"\$PVE_SSH_KEY\" ]; then
    ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N '' -q
    PVE_SSH_KEY=\$(cat /root/.ssh/id_ed25519.pub)
fi

PVE_KEY_ESCAPED=\$(printf '%s\n' \"\$PVE_SSH_KEY\" | sed 's/[&/\\\\]/\\\\&/g')
sed -i \"s|PLACEHOLDER_PVE_SSH_KEY|\$PVE_KEY_ESCAPED|g\" answer-production.toml

if [ -f dev_ssh_key.pub ]; then
    DEV_KEY=\$(cat dev_ssh_key.pub)
    DEV_KEY_ESCAPED=\$(printf '%s\n' \"\$DEV_KEY\" | sed 's/[&/\\\\]/\\\\&/g')
    sed -i \"s|PLACEHOLDER_DEV_SSH_KEY|\$DEV_KEY_ESCAPED|g\" answer-production.toml
else
    sed -i '/PLACEHOLDER_DEV_SSH_KEY/d' answer-production.toml
fi

# Build the ISO
chmod +x first-boot-production.sh
echo '[INFO] Creating auto-install ISO...'
proxmox-auto-install-assistant prepare-iso \\
    \"\$PVE_ISO_FILE\" \\
    --fetch-from iso \\
    --answer-file answer-production.toml \\
    --on-first-boot first-boot-production.sh \\
    --output '$ISO_NAME'

# Move to ISO directory
mv -f '$ISO_NAME' \"\$ISO_DIR/$ISO_NAME\"

# Cleanup
rm -f \"$WORK_DIR/\$PVE_ISO_FILE\"

echo ''
echo '=============================================='
echo 'ISO creation successful!'
echo '=============================================='
echo \"ISO: \$ISO_DIR/$ISO_NAME\"
"

header "Done"
success "ISO created: $ISO_NAME"
echo ""
echo "ISO location on $PVE_HOST:"
echo "  /var/lib/vz/template/iso/$ISO_NAME"
echo ""
echo "To install, boot a machine from this ISO."
echo "Installation is fully automatic (ZFS, static IP $IP_ADDRESS)."
echo ""
echo "After installation, connect via:"
echo "  ssh root@$IP_ADDRESS"
echo ""
