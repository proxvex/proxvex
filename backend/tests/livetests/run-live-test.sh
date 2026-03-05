#!/bin/bash
#
# Live Integration Test for OCI LXC Deployer
#
# Creates a real container on a Proxmox host and verifies:
# - Container creation
# - Notes generation (log-url, icon-url, etc.)
# - Container is running
#
# Usage:
#   ./run-live-test.sh [pve_host] [application] [task]
#
# Examples:
#   ./run-live-test.sh pve1.cluster                        # Test with alpine-packages
#   ./run-live-test.sh pve1.cluster node-red installation  # Test node-red
#   ./run-live-test.sh pve2.cluster                        # Different host
#   KEEP_VM=1 ./run-live-test.sh pve1.cluster              # Don't cleanup after test
#
set -e

# Konfiguration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
PROJECT_ROOT="$(dirname "$BACKEND_ROOT")"
TEST_LOCAL=$(mktemp -d /tmp/lxc-manager-test-XXXXXX)
TIMESTAMP=$(date +%s)

# Parse arguments: first arg is PVE_HOST (can include user@), then application, then task
PVE_HOST_ARG="${1:-${PVE_HOST:-pve1.cluster}}"
APPLICATION="${2:-alpine-packages}"
TASK="${3:-installation}"

# Add root@ if no user specified
if [[ "$PVE_HOST_ARG" != *"@"* ]]; then
    PVE_SSH="root@${PVE_HOST_ARG}"
else
    PVE_SSH="$PVE_HOST_ARG"
fi
# Extract just the hostname for storagecontext (without user@)
PVE_HOST="${PVE_HOST_ARG#*@}"

# Farben für Output
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

# Cleanup-Funktion
cleanup() {
    local exit_code=$?

    # Cleanup temp directory
    if [ -d "$TEST_LOCAL" ]; then
        rm -rf "$TEST_LOCAL"
        log_info "Removed temp directory: $TEST_LOCAL"
    fi

    # Cleanup VM unless KEEP_VM is set
    if [ -n "$VM_ID" ] && [ -z "$KEEP_VM" ]; then
        log_info "Cleaning up VM $VM_ID..."
        ssh "$PVE_SSH" "pct stop $VM_ID 2>/dev/null || true; pct destroy $VM_ID 2>/dev/null || true" 2>/dev/null
    elif [ -n "$VM_ID" ] && [ -n "$KEEP_VM" ]; then
        log_warn "KEEP_VM set - VM $VM_ID not destroyed"
        echo "  To destroy manually: ssh $PVE_SSH 'pct stop $VM_ID; pct destroy $VM_ID'"
    fi

    exit $exit_code
}

trap cleanup EXIT

echo "========================================"
echo " OCI LXC Deployer - Live Integration Test"
echo "========================================"
echo ""
echo "Application: $APPLICATION"
echo "Task: $TASK"
echo "PVE Host: $PVE_HOST"
echo ""

# 1. Verify prerequisites
log_info "Checking prerequisites..."

if ! ssh -o ConnectTimeout=5 "$PVE_SSH" "echo ok" >/dev/null 2>&1; then
    log_fail "Cannot connect to PVE host: $PVE_SSH"
    exit 1
fi
log_ok "SSH connection to $PVE_SSH"

log_ok "PVE host configured: $PVE_HOST"

if [ ! -f "$BACKEND_ROOT/dist/oci-lxc-deployer.mjs" ]; then
    log_warn "Backend not built, building now..."
    (cd "$BACKEND_ROOT" && npm run build)
fi
log_ok "Backend is built"

# 2. Prepare test directory
log_info "Preparing test directory: $TEST_LOCAL"
mkdir -p "$TEST_LOCAL"

# Create storagecontext.json with VE context
cat > "$TEST_LOCAL/storagecontext.json" << EOF
{
  "ve_${PVE_HOST}": {
    "host": "${PVE_HOST}",
    "current": true
  }
}
EOF
log_ok "Created storagecontext.json with VE context for $PVE_HOST"

# Create secret.txt (backend will use this for encryption)
openssl rand -base64 32 > "$TEST_LOCAL/secret.txt"
log_ok "Created secret.txt"

# 3. Create parameters file
HOSTNAME="test-$TIMESTAMP"
PARAMS_FILE="$TEST_LOCAL/params.json"
cat > "$PARAMS_FILE" << EOF
[
  {"name": "hostname", "value": "$HOSTNAME"},
  {"name": "deployer_base_url", "value": "http://test-backend:3000"},
  {"name": "ve_context_key", "value": "ve_${PVE_HOST}"},
  {"name": "application_id", "value": "$APPLICATION"}
]
EOF

log_info "Test hostname: $HOSTNAME"

# 4. Create container
echo ""
log_info "Creating container with $APPLICATION..."
cd "$BACKEND_ROOT"

# Capture output to get VM_ID
set +e
OUTPUT=$(node dist/oci-lxc-deployer.mjs exec "$APPLICATION" "$TASK" "$PARAMS_FILE" --local "$TEST_LOCAL" 2>&1)
EXIT_CODE=$?
set -e

if [ $EXIT_CODE -ne 0 ]; then
    echo "$OUTPUT"
    log_fail "Container creation failed (exit code: $EXIT_CODE)"
    exit 1
fi

# VM_ID aus JSON Output extrahieren
# Das JSON ist mehrzeilig, also suchen wir direkt nach "vm_id": "..."
VM_ID=$(echo "$OUTPUT" | grep -o '"vm_id"[[:space:]]*:[[:space:]]*"[0-9]*"' | grep -o '[0-9]*' | tail -1 || true)

if [ -z "$VM_ID" ]; then
    log_fail "Could not extract VM_ID from output"
    echo "--- Output (last 50 lines) ---"
    echo "$OUTPUT" | tail -50
    echo "--- End Output ---"
    exit 1
fi

log_ok "Container created: VM_ID=$VM_ID"

# 5. Run verifications
echo ""
log_info "Running verifications..."

# 5a. Container exists?
if ssh "$PVE_SSH" "pct status $VM_ID" >/dev/null 2>&1; then
    log_ok "Container $VM_ID exists"
    ((TESTS_PASSED++))
else
    log_fail "Container $VM_ID does not exist"
    ((TESTS_FAILED++))
    exit 1
fi

# 5b. Container is running?
STATUS=$(ssh "$PVE_SSH" "pct status $VM_ID 2>/dev/null" | awk '{print $2}')
assert '[ "$STATUS" = "running" ]' "Container is running (status: $STATUS)"

# 5c. Get and verify Notes
NOTES=$(ssh "$PVE_SSH" "pct config $VM_ID 2>/dev/null" | grep -A100 "description:" || echo "")

# Proxmox URL-encodes the description, so : becomes %3A
assert 'echo "$NOTES" | grep -qE "oci-lxc-deployer(:managed|%3Amanaged)"' "Notes contain oci-lxc-deployer:managed marker"
assert 'echo "$NOTES" | grep -qE "oci-lxc-deployer(:log-url|%3Alog-url)"' "Notes contain log-url"
assert 'echo "$NOTES" | grep -qE "oci-lxc-deployer(:icon-url|%3Aicon-url)"' "Notes contain icon-url"
assert 'echo "$NOTES" | grep -qE "(\*\*Links\*\*|%2A%2ALinks%2A%2A)"' "Notes contain Links section"

# 5d. Optional: Check if container has network
IP=$(ssh "$PVE_SSH" "pct exec $VM_ID -- ip -4 addr show eth0 2>/dev/null | grep inet | awk '{print \$2}' | cut -d/ -f1" 2>/dev/null || echo "")
if [ -n "$IP" ]; then
    log_ok "Container has IP: $IP"
    ((TESTS_PASSED++))
else
    log_warn "Container has no IP (might be DHCP pending)"
fi

# 6. Summary
echo ""
echo "========================================"
echo " Test Summary"
echo "========================================"
echo ""
echo "VM_ID: $VM_ID"
echo "Hostname: $HOSTNAME"
echo "Tests Passed: $TESTS_PASSED"
echo "Tests Failed: $TESTS_FAILED"
echo ""

if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}FAILED${NC} - Some tests did not pass"
    echo ""
    echo "To inspect manually:"
    echo "  ssh $PVE_SSH 'pct config $VM_ID'"
    echo "  ssh $PVE_SSH 'pct enter $VM_ID'"
    exit 1
else
    echo -e "${GREEN}PASSED${NC} - All tests passed"
fi

echo ""
echo "Cleanup will run automatically on exit."
echo "Set KEEP_VM=1 to preserve the container for debugging."
