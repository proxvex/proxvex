#!/bin/bash
#
# Live Integration Test for OCI LXC Deployer
#
# Creates a real container on a Proxmox host via the CLI tool and verifies:
# - Container creation
# - Notes generation (log-url, icon-url, etc.)
# - Container is running
#
# Prerequisites:
#   - Nested VM running with deployer installed (e2e/step1 + e2e/step2)
#   - Project built (pnpm run build)
#
# Usage:
#   ./run-live-test.sh [instance] [application] [task]
#
# Examples:
#   ./run-live-test.sh                                          # Default instance + alpine-packages
#   ./run-live-test.sh local-test                               # Specific instance
#   ./run-live-test.sh local-test node-red installation         # Test node-red
#   KEEP_VM=1 ./run-live-test.sh local-test                     # Don't cleanup after test
#
set -e

# Paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
PROJECT_ROOT="$(dirname "$BACKEND_ROOT")"
E2E_DIR="$PROJECT_ROOT/e2e"

# Load shared e2e configuration
# shellcheck source=../../../e2e/config.sh
source "$E2E_DIR/config.sh"

# Parse arguments: instance, application, task
INSTANCE="${1:-}"
APPLICATION="${2:-alpine-packages}"
TASK="${3:-installation}"

# Load config for the specified instance
load_config "$INSTANCE"

TIMESTAMP=$(date +%s)
HOSTNAME="test-$TIMESTAMP"

# CLI binary
CLI="node $PROJECT_ROOT/cli/dist/cli/src/oci-lxc-cli.mjs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_ok() { echo -e "${GREEN}✓${NC} $1"; }
log_fail() { echo -e "${RED}✗${NC} $1"; }
log_warn() { echo -e "${YELLOW}!${NC} $1"; }
log_info() { echo "→ $1"; }

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

assert() {
    local condition="$1"
    local message="$2"
    if eval "$condition"; then
        log_ok "$message"
        ((TESTS_PASSED++))
    else
        log_fail "$message"
        ((TESTS_FAILED++))
    fi
}

# SSH wrapper for nested VM (via PVE host port forwarding)
nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=10 \
        -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
}

# Cleanup function
VM_ID=""
PARAMS_FILE=""
cleanup() {
    local exit_code=$?

    # Cleanup params file
    if [ -n "$PARAMS_FILE" ] && [ -f "$PARAMS_FILE" ]; then
        rm -f "$PARAMS_FILE"
    fi

    # Cleanup VM unless KEEP_VM is set
    if [ -n "$VM_ID" ] && [ -z "${KEEP_VM:-}" ]; then
        log_info "Cleaning up VM $VM_ID..."
        nested_ssh "pct stop $VM_ID 2>/dev/null || true; pct destroy $VM_ID 2>/dev/null || true" 2>/dev/null
    elif [ -n "$VM_ID" ] && [ -n "${KEEP_VM:-}" ]; then
        log_warn "KEEP_VM set - VM $VM_ID not destroyed"
        echo "  To destroy manually: ssh -p $PORT_PVE_SSH root@$PVE_HOST 'pct stop $VM_ID; pct destroy $VM_ID'"
    fi

    exit $exit_code
}

trap cleanup EXIT

echo "========================================"
echo " OCI LXC Deployer - Live Integration Test"
echo "========================================"
echo ""
echo "Instance:    $E2E_INSTANCE"
echo "Application: $APPLICATION"
echo "Task:        $TASK"
echo "Deployer:    $DEPLOYER_URL"
echo "PVE Host:    $PVE_HOST"
echo ""

# 1. Verify prerequisites
log_info "Checking prerequisites..."

# Check CLI is built
if [ ! -f "$PROJECT_ROOT/cli/dist/cli/src/oci-lxc-cli.mjs" ]; then
    log_fail "CLI not built. Run: cd $PROJECT_ROOT && pnpm run build"
    exit 1
fi
log_ok "CLI is built"

# Check deployer is reachable
if ! curl -sf --connect-timeout 5 "$DEPLOYER_URL/" >/dev/null 2>&1; then
    log_fail "Deployer API not reachable at $DEPLOYER_URL"
    exit 1
fi
log_ok "Deployer API reachable at $DEPLOYER_URL"

# Discover VE host from deployer API
VE_HOST=$(curl -sf "$DEPLOYER_URL/api/sshconfigs" | jq -r '.sshs[0].host // empty')
if [ -z "$VE_HOST" ]; then
    log_fail "Cannot determine VE host from deployer API"
    exit 1
fi
log_ok "VE host discovered: $VE_HOST"

# 2. Create parameters file
PARAMS_FILE=$(mktemp /tmp/livetest-params.XXXXXX.json)
cat > "$PARAMS_FILE" <<EOF
{
  "params": [
    { "name": "hostname", "value": "$HOSTNAME" }
  ]
}
EOF

log_info "Test hostname: $HOSTNAME"

# 3. Create container via CLI
echo ""
log_info "Creating container with $APPLICATION via oci-lxc-cli..."

set +e
OUTPUT=$($CLI remote \
    --server "$DEPLOYER_URL" \
    --ve "$VE_HOST" \
    --insecure \
    --timeout 600 \
    --quiet \
    "$APPLICATION" "$TASK" "$PARAMS_FILE" 2>&1)
EXIT_CODE=$?
set -e

if [ $EXIT_CODE -ne 0 ]; then
    echo "$OUTPUT"
    log_fail "Container creation failed (exit code: $EXIT_CODE)"
    exit 1
fi

# Extract VM_ID from CLI output (JSON)
VM_ID=$(echo "$OUTPUT" | grep -o '"vm_id"[[:space:]]*:[[:space:]]*"[0-9]*"' | grep -o '[0-9]*' | tail -1 || true)

if [ -z "$VM_ID" ]; then
    log_fail "Could not extract VM_ID from output"
    echo "--- Output (last 50 lines) ---"
    echo "$OUTPUT" | tail -50
    echo "--- End Output ---"
    exit 1
fi

log_ok "Container created: VM_ID=$VM_ID"

# 4. Run verifications
echo ""
log_info "Running verifications..."

# 4a. Container exists?
if nested_ssh "pct status $VM_ID" >/dev/null 2>&1; then
    log_ok "Container $VM_ID exists"
    ((TESTS_PASSED++))
else
    log_fail "Container $VM_ID does not exist"
    ((TESTS_FAILED++))
    exit 1
fi

# 4b. Container is running?
STATUS=$(nested_ssh "pct status $VM_ID 2>/dev/null" | awk '{print $2}')
assert '[ "$STATUS" = "running" ]' "Container is running (status: $STATUS)"

# 4c. Get and verify Notes
NOTES=$(nested_ssh "pct config $VM_ID 2>/dev/null" | grep -A100 "description:" || echo "")

# Proxmox URL-encodes the description, so : becomes %3A
assert 'echo "$NOTES" | grep -qE "oci-lxc-deployer(:managed|%3Amanaged)"' "Notes contain oci-lxc-deployer:managed marker"
assert 'echo "$NOTES" | grep -qE "oci-lxc-deployer(:log-url|%3Alog-url)"' "Notes contain log-url"
assert 'echo "$NOTES" | grep -qE "oci-lxc-deployer(:icon-url|%3Aicon-url)"' "Notes contain icon-url"
assert 'echo "$NOTES" | grep -qE "(\*\*Links\*\*|%2A%2ALinks%2A%2A)"' "Notes contain Links section"

# 4d. Optional: Check if container has network
IP=$(nested_ssh "pct exec $VM_ID -- ip -4 addr show eth0 2>/dev/null | grep inet | awk '{print \$2}' | cut -d/ -f1" 2>/dev/null || echo "")
if [ -n "$IP" ]; then
    log_ok "Container has IP: $IP"
    ((TESTS_PASSED++))
else
    log_warn "Container has no IP (might be DHCP pending)"
fi

# 5. Summary
echo ""
echo "========================================"
echo " Test Summary"
echo "========================================"
echo ""
echo "Instance: $E2E_INSTANCE"
echo "VM_ID: $VM_ID"
echo "Hostname: $HOSTNAME"
echo "Tests Passed: $TESTS_PASSED"
echo "Tests Failed: $TESTS_FAILED"
echo ""

if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}FAILED${NC} - Some tests did not pass"
    echo ""
    echo "To inspect manually:"
    echo "  ssh -p $PORT_PVE_SSH root@$PVE_HOST 'pct config $VM_ID'"
    echo "  ssh -p $PORT_PVE_SSH root@$PVE_HOST 'pct enter $VM_ID'"
    exit 1
else
    echo -e "${GREEN}PASSED${NC} - All tests passed"
fi

echo ""
echo "Cleanup will run automatically on exit."
echo "Set KEEP_VM=1 to preserve the container for debugging."
