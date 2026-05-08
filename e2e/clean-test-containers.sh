#!/bin/bash
# clean-test-containers.sh - Remove test containers but keep deployer
#
# This script removes all LXC containers created by E2E tests,
# but preserves the deployer container (VMID 300).
# Also cleans up associated volumes.
#
# Usage:
#   ./clean-test-containers.sh [instance]
#   ./clean-test-containers.sh --all          # Clean all instances

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load shared configuration
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

# Parse arguments
CLEAN_ALL=false
INSTANCE_ARG=""
for arg in "$@"; do
    case "$arg" in
        --all) CLEAN_ALL=true ;;
        *) INSTANCE_ARG="$arg" ;;
    esac
done

# Load config
load_config "$INSTANCE_ARG"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# nested_ssh comes from lib/nested-ssh.sh — pinned ed25519 host key + StrictHostKeyChecking=yes.
# shellcheck source=lib/nested-ssh.sh
. "$SCRIPT_DIR/lib/nested-ssh.sh"

echo "Clean Test Containers"
echo "Instance: $E2E_INSTANCE"
echo "Deployer VMID (protected): $DEPLOYER_VMID"
echo ""

# Check SSH connection
info "Connecting to nested VM..."
if ! nested_ssh "echo 'SSH OK'" &>/dev/null; then
    error "Cannot connect to nested VM. Is it running?"
fi
success "Connected"

# Get list of all containers
info "Finding test containers..."
CONTAINERS=$(nested_ssh "pct list 2>/dev/null | tail -n +2 | awk '{print \$1}'")

if [ -z "$CONTAINERS" ]; then
    success "No containers found"
    exit 0
fi

# Filter out deployer
TEST_CONTAINERS=""
for vmid in $CONTAINERS; do
    if [ "$vmid" != "$DEPLOYER_VMID" ]; then
        TEST_CONTAINERS="$TEST_CONTAINERS $vmid"
    fi
done

if [ -z "$TEST_CONTAINERS" ]; then
    success "No test containers to clean (only deployer $DEPLOYER_VMID exists)"
    exit 0
fi

echo ""
info "Found test containers:$TEST_CONTAINERS"
echo ""

# Get volumes base path
VOLUMES_BASE=$(nested_ssh "cat /mnt/pve-volumes/*/volumes 2>/dev/null | head -1 | xargs dirname 2>/dev/null || echo '/mnt/pve-volumes'")

# Stop and destroy each test container
for vmid in $TEST_CONTAINERS; do
    # Get container name for volume cleanup
    CT_NAME=$(nested_ssh "pct config $vmid 2>/dev/null | grep -oP 'hostname: \K.*'" || echo "unknown")

    info "Removing container $vmid ($CT_NAME)..."

    # Stop if running
    if nested_ssh "pct status $vmid 2>/dev/null | grep -q running"; then
        nested_ssh "pct stop $vmid --timeout 10" 2>/dev/null || true
    fi

    # Destroy container
    nested_ssh "pct destroy $vmid --purge --force" 2>/dev/null || true

    # Clean up volumes directory
    if [ "$CT_NAME" != "unknown" ]; then
        # Find and remove volume directories for this container
        nested_ssh "
            for voldir in /mnt/pve-volumes/*/volumes/$CT_NAME; do
                if [ -d \"\$voldir\" ]; then
                    echo \"  Removing volume: \$voldir\"
                    rm -rf \"\$voldir\"
                fi
            done
        " 2>/dev/null || true
    fi

    success "Removed container $vmid and volumes"
done

echo ""
success "Cleanup complete - removed ${#TEST_CONTAINERS[@]} test container(s)"
echo ""
echo "Remaining:"
nested_ssh "pct list" 2>/dev/null || echo "  (none)"
