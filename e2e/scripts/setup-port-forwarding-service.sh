#!/bin/bash
# setup-port-forwarding-service.sh - Install persistent port forwarding on PVE host
#
# This script installs a systemd service on the PVE host (ubuntupve) that
# automatically sets up iptables port forwarding rules on boot.
#
# The service reads configuration from /etc/oci-lxc-deployer/e2e/config.json
# and applies forwarding rules for all configured instances.
#
# Usage:
#   ./setup-port-forwarding-service.sh
#   PVE_HOST=myhost ./setup-port-forwarding-service.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"

# Load config if not already loaded
if [ -z "$PVE_HOST" ]; then
    # shellcheck source=../config.sh
    source "$E2E_DIR/config.sh"
    load_config "${1:-}"
fi

# Colors
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# SSH wrapper
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=10 "root@$PVE_HOST" "$@"
}

CONFIG_DIR="/etc/oci-lxc-deployer/e2e"
CONFIG_FILE="$CONFIG_DIR/config.json"
SERVICE_SCRIPT="/usr/local/bin/e2e-port-forwarding.sh"
SERVICE_NAME="e2e-port-forwarding"

info "Setting up persistent port forwarding service on $PVE_HOST..."

# Step 1: Create config directory and copy config.json
info "Copying config.json to $PVE_HOST:$CONFIG_FILE..."
pve_ssh "mkdir -p $CONFIG_DIR"
scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$E2E_DIR/config.json" "root@$PVE_HOST:$CONFIG_FILE"
success "Config file copied"

# Step 2: Create the port forwarding script (Python-based, no external dependencies)
info "Creating port forwarding script..."
pve_ssh "cat > $SERVICE_SCRIPT << 'SCRIPT_EOF'
#!/usr/bin/env python3
\"\"\"e2e-port-forwarding.py - Apply iptables rules from E2E config

This script is managed by the e2e-port-forwarding systemd service.
Uses only Python stdlib - no external dependencies required.
\"\"\"
import json
import subprocess
import sys
from pathlib import Path

CONFIG_FILE = Path('/etc/oci-lxc-deployer/e2e/config.json')

def run(cmd, check=True):
    \"\"\"Run shell command, optionally ignoring errors.\"\"\"
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f'[ERROR] Command failed: {cmd}')
        print(result.stderr)
        sys.exit(1)
    return result

def cleanup_rules(ip, subnet):
    \"\"\"Remove ALL existing iptables rules for an instance by IP.\"\"\"
    # Clean PREROUTING NAT rules
    result = run('iptables -t nat -S PREROUTING', check=False)
    for line in result.stdout.splitlines():
        if ip in line:
            run('iptables -t nat ' + line.replace('-A ', '-D ', 1), check=False)
    # Clean FORWARD rules
    result = run('iptables -S FORWARD', check=False)
    for line in result.stdout.splitlines():
        if ip in line:
            run('iptables ' + line.replace('-A ', '-D ', 1), check=False)
    # Clean POSTROUTING NAT rules
    result = run('iptables -t nat -S POSTROUTING', check=False)
    for line in result.stdout.splitlines():
        if f'{subnet}.0/24' in line:
            run('iptables -t nat ' + line.replace('-A ', '-D ', 1), check=False)

def main():
    if not CONFIG_FILE.exists():
        print(f'[ERROR] Config file not found: {CONFIG_FILE}')
        sys.exit(1)

    with open(CONFIG_FILE) as f:
        config = json.load(f)

    # Enable IP forwarding
    Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
    print('[OK] IP forwarding enabled')

    # Get base ports
    base_pve_web = config['ports']['pveWeb']
    base_pve_ssh = config['ports']['pveSsh']
    base_deployer = config['ports']['deployer']
    base_deployer_https = config['ports']['deployerHttps']

    # Process each instance
    for name, inst in config['instances'].items():
        subnet = inst['subnet']
        offset = inst['portOffset']
        nested_ip = f'{subnet}.10'

        port_pve_web = base_pve_web + offset
        port_pve_ssh = base_pve_ssh + offset
        port_deployer = base_deployer + offset
        port_deployer_https = base_deployer_https + offset

        print(f'[INFO] Setting up port forwarding for instance: {name}')
        print(f'       Subnet: {subnet}.0/24, IP: {nested_ip}, Offset: {offset}')

        # Remove ALL existing rules for this instance's IP
        cleanup_rules(nested_ip, subnet)

        # Add port forwarding rules
        run(f'iptables -t nat -A PREROUTING -p tcp --dport {port_pve_web} -j DNAT --to-destination {nested_ip}:8006')
        run(f'iptables -A FORWARD -p tcp -d {nested_ip} --dport 8006 -j ACCEPT')
        run(f'iptables -t nat -A PREROUTING -p tcp --dport {port_pve_ssh} -j DNAT --to-destination {nested_ip}:22')
        run(f'iptables -A FORWARD -p tcp -d {nested_ip} --dport 22 -j ACCEPT')
        run(f'iptables -t nat -A PREROUTING -p tcp --dport {port_deployer} -j DNAT --to-destination {nested_ip}:3080')
        run(f'iptables -A FORWARD -p tcp -d {nested_ip} --dport 3080 -j ACCEPT')
        run(f'iptables -t nat -A PREROUTING -p tcp --dport {port_deployer_https} -j DNAT --to-destination {nested_ip}:3443')
        run(f'iptables -A FORWARD -p tcp -d {nested_ip} --dport 3443 -j ACCEPT')

        # NAT for nested VM network
        run(f'iptables -t nat -A POSTROUTING -s {subnet}.0/24 -o vmbr0 -j MASQUERADE')

        print(f'[OK] Port forwarding configured:')
        print(f'     {port_pve_web} -> {nested_ip}:8006 (Web UI)')
        print(f'     {port_pve_ssh} -> {nested_ip}:22 (SSH)')
        print(f'     {port_deployer} -> {nested_ip}:3080 (Deployer HTTP)')
        print(f'     {port_deployer_https} -> {nested_ip}:3443 (Deployer HTTPS)')

    print('[OK] All port forwarding rules applied')

if __name__ == '__main__':
    main()
SCRIPT_EOF"

pve_ssh "chmod +x $SERVICE_SCRIPT"
success "Port forwarding script created"

# Step 3: Create systemd service
info "Creating systemd service..."
pve_ssh "cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SERVICE_EOF'
[Unit]
Description=E2E Test Port Forwarding
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/bin/e2e-port-forwarding.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SERVICE_EOF"

# Step 4: Enable and start service
pve_ssh "systemctl daemon-reload"
pve_ssh "systemctl enable ${SERVICE_NAME}.service"
pve_ssh "systemctl start ${SERVICE_NAME}.service"
success "Service enabled and started"

# Verify
info "Verifying service status..."
if pve_ssh "systemctl is-active ${SERVICE_NAME}.service" &>/dev/null; then
    success "Service is running"
else
    error "Service failed to start. Check with: ssh root@$PVE_HOST journalctl -u ${SERVICE_NAME}"
fi

success "Persistent port forwarding installed on $PVE_HOST"
echo ""
echo "Management commands:"
echo "  Status:   ssh root@$PVE_HOST systemctl status ${SERVICE_NAME}"
echo "  Restart:  ssh root@$PVE_HOST systemctl restart ${SERVICE_NAME}"
echo "  Logs:     ssh root@$PVE_HOST journalctl -u ${SERVICE_NAME}"
echo "  Config:   ssh root@$PVE_HOST cat $CONFIG_FILE"
