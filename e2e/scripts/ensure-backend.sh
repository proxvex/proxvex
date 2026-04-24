#!/bin/bash
# ensure-backend.sh - Wake ubuntupve via WOL and wait for deployer API
#
# This script ensures the test backend (nested Proxmox VM on ubuntupve)
# is available before running template-tests or e2e-tests.
#
# Flow:
#   1. Ping ubuntupve to check if it's reachable
#   2. If not reachable, send WOL magic packet and wait
#   3. Wait for the deployer API to respond (nested VM auto-starts on boot)
#
# Usage:
#   ./ensure-backend.sh                              # Uses E2E_INSTANCE or default
#   E2E_INSTANCE=github-action ./ensure-backend.sh   # Specific instance
#   ./ensure-backend.sh github-action                # Instance as argument
#
# Environment overrides:
#   UBUNTUPVE_MAC  - MAC address for WOL (overrides config.json wol.macAddress)
#   WOL_WAIT       - Max seconds to wait for host wake (default: 180)
#   API_WAIT       - Max seconds to wait for deployer API (default: 300)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
E2E_DIR="$(dirname "$SCRIPT_DIR")"

# Load shared configuration
# shellcheck source=../config.sh
source "$E2E_DIR/config.sh"
load_config "${1:-}"

# Configuration
MAC="${UBUNTUPVE_MAC:-$WOL_MAC}"
WOL_WAIT="${WOL_WAIT:-180}"
API_WAIT="${API_WAIT:-300}"

# Colors (matching step2b-install-deployer.sh pattern)
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

header "Ensure Backend Available"
echo "Instance:      $E2E_INSTANCE"
echo "PVE Host:      $PVE_HOST"
echo "Deployer URL:  $DEPLOYER_URL"
echo "WOL MAC:       ${MAC:-not configured}"
echo ""

# Step 1: Check if ubuntupve is reachable
info "Checking if $PVE_HOST is reachable..."
if ping -c 1 -W 3 "$PVE_HOST" &>/dev/null; then
    success "$PVE_HOST is reachable"
else
    # Step 2: Send WOL magic packet
    if [ -z "$MAC" ] || [ "$MAC" = "XX:XX:XX:XX:XX:XX" ]; then
        error "$PVE_HOST is unreachable and no valid WOL MAC address configured. Set wol.macAddress in e2e/config.json or UBUNTUPVE_MAC env variable."
    fi

    if ! command -v etherwake &>/dev/null; then
        error "etherwake is not installed. Install with: apt-get install etherwake"
    fi

    info "Sending WOL magic packet to $MAC..."
    etherwake "$MAC" 2>/dev/null || etherwake -D "$MAC" 2>/dev/null || error "Failed to send WOL packet"
    success "WOL packet sent"

    # Wait for host to come up
    info "Waiting for $PVE_HOST to wake up (max ${WOL_WAIT}s)..."
    HOST_UP=false
    for i in $(seq 1 "$WOL_WAIT"); do
        if ping -c 1 -W 2 "$PVE_HOST" &>/dev/null; then
            HOST_UP=true
            break
        fi
        if (( i % 10 == 0 )); then
            printf "\r${YELLOW}[INFO]${NC} Waiting for host... %ds" "$i"
        fi
        sleep 1
    done
    echo ""

    if [ "$HOST_UP" != "true" ]; then
        error "$PVE_HOST did not respond within ${WOL_WAIT}s after WOL"
    fi
    success "$PVE_HOST is reachable after WOL"
fi

# Step 3: Wait for deployer API health check
# The nested VM auto-starts on ubuntupve boot, and the deployer container
# starts automatically inside the nested VM. We just need to wait for it.
info "Waiting for deployer API at $DEPLOYER_URL (max ${API_WAIT}s)..."
API_READY=false
for i in $(seq 1 "$API_WAIT"); do
    if curl -sf --connect-timeout 3 "$DEPLOYER_URL/" 2>/dev/null | grep -q "doctype"; then
        API_READY=true
        break
    fi
    if (( i % 10 == 0 )); then
        printf "\r${YELLOW}[INFO]${NC} Waiting for deployer API... %ds" "$i"
    fi
    sleep 1
done
echo ""

if [ "$API_READY" != "true" ]; then
    error "Deployer API at $DEPLOYER_URL did not respond within ${API_WAIT}s"
fi
success "Deployer API is healthy"

# Summary
TOTAL_TIME=$(elapsed)
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Backend ready in ${TOTAL_TIME}${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
echo "Deployer URL: $DEPLOYER_URL"
echo "PVE Web UI:   $PVE_WEB_URL"
