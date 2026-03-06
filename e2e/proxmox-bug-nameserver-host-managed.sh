#!/bin/bash
# Proxmox Bug Reproducer: --nameserver ignored with host-managed=1 + ip=dhcp
#
# Summary:
#   When creating an LXC container with host-managed=1 network and ip=dhcp,
#   the --nameserver option is silently ignored. Instead of writing the
#   configured nameserver to /etc/resolv.conf, Proxmox copies the host's
#   /etc/resolv.conf into the container.
#
#   With ip=static (same host-managed=1), --nameserver is correctly applied.
#
# Impact:
#   OCI container images (imported via skopeo) automatically get host-managed=1
#   set by Proxmox ("Auto-Enabling host-managed network for network device net0").
#   These containers typically use ip=dhcp. The combination means --nameserver
#   is silently ignored for all OCI containers.
#
# Tested on:
#   proxmox-ve: 9.1.0
#   pve-manager: 9.1.6 (running version: 9.1.6/71482d1833ded40a)
#   Kernel: 6.17.13-1-pve
#
# Prerequisites:
#   - Any Proxmox VE host (DHCP or static network - doesn't matter)
#   - local-lvm storage (default on every PVE installation)
#   - A bridge interface (default: vmbr0, present on every PVE installation)
#   - Internet access (to download Alpine template if not cached)
#   - No containers using VMIDs 9991-9993
#
# The script uses --nameserver 1.2.3.4 (an intentionally distinctive value
# that won't appear in any host's /etc/resolv.conf) so the test result is
# unambiguous regardless of the host's DNS configuration.
#
# Usage:
#   bash proxmox-bug-nameserver-host-managed.sh [bridge]

set -e

BRIDGE="${1:-vmbr0}"
STORAGE="local"
NAMESERVER="1.2.3.4"   # Intentionally distinctive to verify
VMID_BASE=9990         # Use high VMIDs to avoid conflicts

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }

cleanup() {
    info "Cleaning up test containers..."
    for id in $VMID_A $VMID_B $VMID_C; do
        pct stop "$id" 2>/dev/null || true
        pct destroy "$id" 2>/dev/null || true
    done
}

# --- Setup ---
VMID_A=$((VMID_BASE + 1))  # host-managed=0, ip=dhcp, --nameserver
VMID_B=$((VMID_BASE + 2))  # host-managed=1, ip=dhcp, --nameserver  (BUG)
VMID_C=$((VMID_BASE + 3))  # host-managed=1, ip=static, --nameserver

# Ensure clean state
cleanup 2>/dev/null

# Ensure Alpine template exists
TEMPLATE=$(pveam list "$STORAGE" 2>/dev/null | grep -m1 'alpine.*default.*amd64' | awk '{print $1}')
if [ -z "$TEMPLATE" ]; then
    info "Downloading Alpine template..."
    AVAILABLE=$(pveam available --section system | grep -m1 'alpine.*default.*amd64' | awk '{print $2}')
    pveam download "$STORAGE" "$AVAILABLE" >/dev/null 2>&1
    TEMPLATE=$(pveam list "$STORAGE" 2>/dev/null | grep -m1 'alpine.*default.*amd64' | awk '{print $1}')
fi

echo "========================================================"
echo "Proxmox Bug: --nameserver ignored with host-managed + dhcp"
echo "========================================================"
echo ""
echo "Template:    $TEMPLATE"
echo "Bridge:      $BRIDGE"
echo "Nameserver:  $NAMESERVER (intentionally set to verify)"
echo "Host resolv: $(grep '^nameserver' /etc/resolv.conf | head -1)"
echo ""

# --- Test A: Baseline (no host-managed, ip=dhcp, --nameserver) ---
info "Test A: host-managed=0, ip=dhcp, --nameserver $NAMESERVER"
pct create "$VMID_A" "$TEMPLATE" \
    --rootfs local-lvm:1 \
    --hostname test-no-hm \
    --memory 64 \
    --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
    --ostype alpine \
    --unprivileged 1 \
    --nameserver "$NAMESERVER" >/dev/null 2>&1

pct start "$VMID_A" 2>/dev/null; sleep 2
RESOLV_A=$(pct exec "$VMID_A" -- cat /etc/resolv.conf 2>/dev/null)
if echo "$RESOLV_A" | grep -q "$NAMESERVER"; then
    ok "Test A: resolv.conf contains $NAMESERVER"
else
    fail "Test A: resolv.conf does NOT contain $NAMESERVER"
fi
echo "    $(echo "$RESOLV_A" | grep nameserver)"

# --- Test B: BUG CASE (host-managed=1, ip=dhcp, --nameserver) ---
echo ""
info "Test B: host-managed=1, ip=dhcp, --nameserver $NAMESERVER"
pct create "$VMID_B" "$TEMPLATE" \
    --rootfs local-lvm:1 \
    --hostname test-hm-dhcp \
    --memory 64 \
    --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp,host-managed=1" \
    --ostype alpine \
    --unprivileged 1 \
    --nameserver "$NAMESERVER" >/dev/null 2>&1

pct start "$VMID_B" 2>/dev/null; sleep 2
RESOLV_B=$(pct exec "$VMID_B" -- cat /etc/resolv.conf 2>/dev/null)
if echo "$RESOLV_B" | grep -q "$NAMESERVER"; then
    ok "Test B: resolv.conf contains $NAMESERVER"
else
    fail "Test B: resolv.conf does NOT contain $NAMESERVER (BUG!)"
    echo "    Expected: nameserver $NAMESERVER"
    echo "    Got:      $(echo "$RESOLV_B" | grep nameserver)"
    echo "    Config:   $(grep '^nameserver' /etc/pve/lxc/${VMID_B}.conf)"
fi

# --- Test C: Control (host-managed=1, ip=static, --nameserver) ---
echo ""
info "Test C: host-managed=1, ip=static, --nameserver $NAMESERVER"
pct create "$VMID_C" "$TEMPLATE" \
    --rootfs local-lvm:1 \
    --hostname test-hm-static \
    --memory 64 \
    --net0 "name=eth0,bridge=$BRIDGE,ip=10.255.255.99/24,gw=10.255.255.1,host-managed=1" \
    --ostype alpine \
    --unprivileged 1 \
    --nameserver "$NAMESERVER" >/dev/null 2>&1

pct start "$VMID_C" 2>/dev/null; sleep 2
RESOLV_C=$(pct exec "$VMID_C" -- cat /etc/resolv.conf 2>/dev/null)
if echo "$RESOLV_C" | grep -q "$NAMESERVER"; then
    ok "Test C: resolv.conf contains $NAMESERVER"
else
    fail "Test C: resolv.conf does NOT contain $NAMESERVER"
fi
echo "    $(echo "$RESOLV_C" | grep nameserver)"

# --- Summary ---
echo ""
echo "========================================================"
echo "SUMMARY"
echo "========================================================"
echo ""
echo "Test A (no host-managed, dhcp, --nameserver):    $(echo "$RESOLV_A" | grep -c "$NAMESERVER" >/dev/null && echo 'PASS' || echo 'FAIL')"
echo "Test B (host-managed=1, dhcp, --nameserver):     $(echo "$RESOLV_B" | grep -c "$NAMESERVER" >/dev/null && echo 'PASS' || echo 'FAIL - nameserver config ignored')"
echo "Test C (host-managed=1, static, --nameserver):   $(echo "$RESOLV_C" | grep -c "$NAMESERVER" >/dev/null && echo 'PASS' || echo 'FAIL')"
echo ""
echo "When host-managed=1 and ip=dhcp are combined, the explicit"
echo "--nameserver setting is silently ignored. The host's"
echo "/etc/resolv.conf is copied instead."
echo ""
echo "This affects all OCI containers because Proxmox automatically"
echo "sets host-managed=1 for them ('Auto-Enabling host-managed"
echo "network for network device net0')."
echo ""

# --- Cleanup ---
cleanup
info "Done."
