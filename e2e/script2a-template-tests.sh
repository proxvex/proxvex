#!/bin/bash
# script2a-template-tests.sh - Initialize nested VM for template tests
#
# This script ensures the nested Proxmox VM is ready for template tests:
# 1. Checks SSH connectivity to nested VM
# 2. Verifies Proxmox tools
# 3. Ensures OS templates (Alpine + Debian) are downloaded
# 4. Verifies storage is available
# 5. Runs a smoke test (create, start, readiness-check, destroy)
# 6. Cleans up leftover test containers (VMID 9900-9999)
#
# Usage:
#   ./script2a-template-tests.sh [instance]
#
# After running this script, template tests can be executed:
#   cd backend && pnpm run test:templates

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load shared configuration
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

load_config "${1:-}"

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

# nested_ssh comes from lib/nested-ssh.sh — pinned ed25519 host key + StrictHostKeyChecking=yes.
# shellcheck source=lib/nested-ssh.sh
. "$SCRIPT_DIR/lib/nested-ssh.sh"

SMOKE_VMID=9999

header "Script 2a: Initialize Template Tests"
echo "Instance:    $E2E_INSTANCE"
echo "PVE Host:    $PVE_HOST"
echo "SSH Port:    $PORT_PVE_SSH"
echo ""

# ─── Step 1: SSH Connectivity ───────────────────────────────────────────────

info "Checking SSH connectivity to nested VM..."
if ! nested_ssh "echo ok" &>/dev/null; then
    error "Cannot connect to nested VM via $PVE_HOST:$PORT_PVE_SSH.
  Is the nested VM running? Try: ./step1-create-vm.sh"
fi
success "SSH connection verified"

# ─── Step 2: Proxmox Tools ─────────────────────────────────────────────────

info "Verifying Proxmox installation..."
PVE_VERSION=$(nested_ssh "pveversion 2>/dev/null" || echo "")
if [ -z "$PVE_VERSION" ]; then
    error "pveversion not found. Is Proxmox installed on the nested VM?"
fi
success "$PVE_VERSION"

# ─── Step 3: Storage ───────────────────────────────────────────────────────

info "Checking storage with rootdir content..."
STORAGE=$(nested_ssh "pvesm status --content rootdir 2>/dev/null | tail -n +2 | awk '{print \$1}' | head -1")
if [ -z "$STORAGE" ]; then
    error "No storage with rootdir content found.
  Template tests need a storage that supports LXC rootfs (e.g., local-zfs, local-lvm)."
fi
success "Storage: $STORAGE"

# ─── Step 4: OS Templates ──────────────────────────────────────────────────

header "Ensuring OS Templates"

for OS_TYPE in alpine debian; do
    info "Checking $OS_TYPE template..."
    PATTERN=$([ "$OS_TYPE" = "alpine" ] && echo "alpine-" || echo "debian-")
    TEMPLATE=$(nested_ssh "pveam list local 2>/dev/null | grep '$PATTERN' | tail -1 | awk '{print \$1}'" || true)

    if [ -n "$TEMPLATE" ]; then
        success "$OS_TYPE template available: $TEMPLATE"
    else
        info "Downloading $OS_TYPE template..."
        nested_ssh "pveam update" &>/dev/null || error "pveam update failed"

        TEMPLATE_FILE=$(nested_ssh "pveam available --section system | grep '$OS_TYPE' | tail -1 | awk '{print \$2}'" || true)
        if [ -z "$TEMPLATE_FILE" ]; then
            error "No $OS_TYPE template available for download"
        fi

        info "Downloading $TEMPLATE_FILE (this may take a minute)..."
        nested_ssh "pveam download local $TEMPLATE_FILE" || error "Download of $TEMPLATE_FILE failed"
        success "$OS_TYPE template downloaded: $TEMPLATE_FILE"
    fi
done

# ─── Step 5: Clean up leftover test containers ─────────────────────────────

header "Cleaning Up Test Containers"

info "Checking for leftover test containers (VMID 9900-9999)..."
LEFTOVER=$(nested_ssh "pct list 2>/dev/null | awk '\$1 >= 9900 && \$1 <= 9999 {print \$1}'" || true)

if [ -n "$LEFTOVER" ]; then
    for vmid in $LEFTOVER; do
        info "Removing leftover container $vmid..."
        nested_ssh "pct destroy $vmid --force --purge" 2>/dev/null || true
        success "Removed $vmid"
    done
else
    success "No leftover test containers"
fi

# ─── Step 6: Smoke Test ────────────────────────────────────────────────────

header "Smoke Test (VMID $SMOKE_VMID)"

# Get Alpine template name
ALPINE_TEMPLATE=$(nested_ssh "pveam list local 2>/dev/null | grep 'alpine-' | tail -1 | awk '{print \$1}'")

info "Creating test container..."
nested_ssh "pct create $SMOKE_VMID $ALPINE_TEMPLATE \
    --hostname smoke-test \
    --memory 256 \
    --rootfs $STORAGE:1 \
    --net0 name=eth0,bridge=vmbr0,ip=dhcp \
    --unprivileged 1" 2>/dev/null || error "Failed to create smoke test container"
success "Container created"

info "Starting container..."
nested_ssh "pct start $SMOKE_VMID" 2>/dev/null || error "Failed to start smoke test container"
success "Container started"

info "Waiting for container readiness..."
READY=false
for i in $(seq 1 20); do
    if nested_ssh "lxc-attach -n $SMOKE_VMID -- /bin/sh -c 'true' </dev/null" &>/dev/null; then
        READY=true
        break
    fi
    sleep 2
done

if [ "$READY" = "false" ]; then
    nested_ssh "pct destroy $SMOKE_VMID --force --purge" 2>/dev/null || true
    error "Smoke test container did not become ready within 40s"
fi
success "Container is ready (${i}x2s)"

info "Destroying smoke test container..."
nested_ssh "pct destroy $SMOKE_VMID --force --purge" 2>/dev/null || true
success "Smoke test container removed"

# ─── Summary ───────────────────────────────────────────────────────────────

header "Template Tests Ready"
echo -e "${GREEN}All checks passed!${NC}"
echo ""
echo "Run template tests:"
echo "  cd backend && pnpm run test:templates"
echo ""
echo "Or run all backend tests:"
echo "  cd backend && pnpm test"
echo ""
