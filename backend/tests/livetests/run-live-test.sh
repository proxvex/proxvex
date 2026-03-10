#!/bin/bash
#
# Live Integration Test for OCI LXC Deployer
#
# Delegates to the TypeScript runner (src/live-test-runner.mts) if tsx is available.
# Falls back to the built-in bash implementation otherwise.
#
# Uses test-definitions.json for multi-step test scenarios (e.g., postgres→zitadel).
#
# Prerequisites:
#   - Nested VM running with deployer installed (e2e/step1 + e2e/step2)
#   - Project built (pnpm run build)
#
# Usage:
#   ./run-live-test.sh [instance] [test-name|--all]
#
# Examples:
#   ./run-live-test.sh                                    # Default: eclipse-mosquitto
#   ./run-live-test.sh github-action                      # Specific instance, default test
#   ./run-live-test.sh github-action zitadel-ssl          # Multi-step: postgres+SSL → zitadel+SSL
#   ./run-live-test.sh github-action --all                # All tests in parallel (TypeScript only)
#   KEEP_VM=1 ./run-live-test.sh github-action zitadel    # Keep containers for debugging
#
set -e

# Try TypeScript runner first (supports --all and parallel execution)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TS_RUNNER="$SCRIPT_DIR/src/live-test-runner.mts"
if [ -f "$TS_RUNNER" ] && command -v tsx &>/dev/null; then
    exec tsx "$TS_RUNNER" "$@"
fi

# Paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
PROJECT_ROOT="$(dirname "$BACKEND_ROOT")"
E2E_DIR="$PROJECT_ROOT/e2e"
TEST_DEFS_FILE="$SCRIPT_DIR/test-definitions.json"

# Load shared e2e configuration
# shellcheck source=../../../e2e/config.sh
source "$E2E_DIR/config.sh"

# Parse arguments: instance, test-name
INSTANCE="${1:-}"
TEST_NAME="${2:-eclipse-mosquitto}"

# Load config for the specified instance
load_config "$INSTANCE"

TIMESTAMP=$(date +%s)

# CLI binary
CLI="node $PROJECT_ROOT/cli/dist/cli/src/oci-lxc-cli.mjs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_ok() { echo -e "${GREEN}✓${NC} $1"; }
log_fail() { echo -e "${RED}✗${NC} $1"; }
log_warn() { echo -e "${YELLOW}!${NC} $1"; }
log_info() { echo -e "→ $1"; }
log_step() { echo -e "\n${BLUE}── Step $1: $2 ──${NC}"; }

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

assert() {
    local condition="$1"
    local message="$2"
    if eval "$condition"; then
        log_ok "$message"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "$message"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# SSH wrapper for nested VM (via PVE host port forwarding)
nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=10 \
        -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
}

# Track all created VMs for cleanup
CREATED_VMS=""
PARAMS_FILES=""
# Track deployed app IPs for inter-container references (e.g., "postgres=10.0.0.5")
DEPLOYED_APP_IPS=""

cleanup() {
    local exit_code=$?

    # Cleanup params files
    for f in $PARAMS_FILES; do
        [ -f "$f" ] && rm -f "$f"
    done

    # Cleanup VMs in reverse order (unless KEEP_VM is set)
    if [ -n "$CREATED_VMS" ]; then
        local reversed=""
        for vm in $CREATED_VMS; do
            reversed="$vm $reversed"
        done
        for vm in $reversed; do
            if [ -z "${KEEP_VM:-}" ]; then
                log_info "Cleaning up VM $vm..."
                nested_ssh "pct stop $vm 2>/dev/null || true; pct destroy $vm --force --purge 2>/dev/null || true" 2>/dev/null || true
            else
                log_warn "KEEP_VM set - VM $vm not destroyed"
                echo "  ssh -p $PORT_PVE_SSH root@$PVE_HOST 'pct stop $vm; pct destroy $vm'"
            fi
        done
    fi

    exit $exit_code
}

trap cleanup EXIT

# ── Extract VM_ID from CLI output ──
extract_vmid() {
    local output="$1"
    echo "$output" | grep -oE '"(vm_id|vmId)"[[:space:]]*:[[:space:]]*"?[0-9]+"?' | grep -o '[0-9]*' | tail -1 || true
}

# ── Run a single CLI remote command ──
cli_remote() {
    local app="$1"
    local task="$2"
    local params_file="$3"
    local addons="${4:-}"

    local addon_args=""
    if [ -n "$addons" ]; then
        addon_args="--enable-addons $addons"
    fi

    set +e
    local output
    output=$($CLI remote \
        --server "$API_URL" \
        --ve "$VE_HOST" \
        --insecure \
        --timeout 600 \
        --quiet \
        $addon_args \
        "$app" "$task" "$params_file" 2>&1)
    local exit_code=$?
    set -e

    if [ $exit_code -ne 0 ]; then
        echo "$output" >&2
        return 1
    fi
    echo "$output"
}

# ── Verify: container_running ──
verify_container_running() {
    local vmid="$1"
    if nested_ssh "pct status $vmid" >/dev/null 2>&1; then
        local status
        status=$(nested_ssh "pct status $vmid 2>/dev/null" | awk '{print $2}')
        assert '[ "$status" = "running" ]' "[$vmid] Container is running (status: $status)"
    else
        log_fail "[$vmid] Container does not exist"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# ── Verify: notes_managed ──
verify_notes_managed() {
    local vmid="$1"
    local notes
    notes=$(nested_ssh "pct config $vmid 2>/dev/null" | grep -a -A100 "description:" || echo "")
    assert 'echo "$notes" | grep -aqE "oci-lxc-deployer(:managed|%3Amanaged)"' "[$vmid] Notes contain managed marker"
}

# ── Verify: services_up (docker-compose apps) ──
verify_services_up() {
    local vmid="$1"
    local services
    services=$(nested_ssh "pct exec $vmid -- docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null" || echo "")
    if [ -z "$services" ]; then
        log_fail "[$vmid] No docker services found"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return
    fi
    local not_up
    not_up=$(echo "$services" | grep -v "Up" || true)
    if [ -z "$not_up" ]; then
        log_ok "[$vmid] All docker services are up"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "[$vmid] Some docker services not up:"
        echo "$not_up" | sed 's/^/  /'
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# ── Verify: lxc_log_no_errors ──
verify_lxc_log() {
    local vmid="$1"
    local hostname="$2"
    local errors
    errors=$(nested_ssh "cat /var/log/lxc/${hostname}-${vmid}.log 2>/dev/null | grep -i error | head -10" 2>/dev/null || echo "")
    if [ -z "$errors" ]; then
        log_ok "[$vmid] LXC log clean (no errors)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_warn "[$vmid] LXC log contains errors:"
        echo "$errors" | head -5 | sed 's/^/  /'
    fi
}

# ── Verify: docker_log_no_errors ──
verify_docker_logs() {
    local vmid="$1"
    local errors
    errors=$(nested_ssh "pct exec $vmid -- sh -c 'for cid in \$(docker ps -q); do docker logs \$cid 2>&1; done | grep -i error | head -10'" 2>/dev/null || echo "")
    if [ -z "$errors" ]; then
        log_ok "[$vmid] Docker logs clean (no errors)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_warn "[$vmid] Docker logs contain errors:"
        echo "$errors" | head -5 | sed 's/^/  /'
    fi
}

# ── Verify: tls_connect ──
verify_tls_connect() {
    local vmid="$1"
    local port="$2"
    local ip
    ip=$(nested_ssh "pct exec $vmid -- ip -4 addr show eth0 2>/dev/null | grep inet | awk '{print \$2}' | cut -d/ -f1" 2>/dev/null || echo "")
    if [ -z "$ip" ]; then
        log_fail "[$vmid] Cannot determine container IP for TLS check"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return
    fi
    if nested_ssh "curl -sk --connect-timeout 5 https://${ip}:${port}/ 2>/dev/null" | grep -q ""; then
        log_ok "[$vmid] TLS connection successful on port $port"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "[$vmid] TLS connection failed on port $port"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# ── Verify: pg_ssl_on (Postgres SSL enabled via SHOW ssl) ──
verify_pg_ssl_on() {
    local vmid="$1"
    local ssl_status
    ssl_status=$(nested_ssh "pct exec $vmid -- psql -U postgres -tA -c 'SHOW ssl;' 2>/dev/null" 2>/dev/null | tr -d '[:space:]')
    if [ "$ssl_status" = "on" ]; then
        log_ok "[$vmid] Postgres SSL is enabled (SHOW ssl = on)"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        log_fail "[$vmid] Postgres SSL not enabled (SHOW ssl = '$ssl_status')"
        TESTS_FAILED=$((TESTS_FAILED + 1))
    fi
}

# ── Run verification checks for a step ──
run_verifications() {
    local vmid="$1"
    local hostname="$2"
    local verify_json="$3"

    if [ -z "$verify_json" ] || [ "$verify_json" = "null" ]; then
        return
    fi

    if echo "$verify_json" | jq -e '.container_running' >/dev/null 2>&1; then
        verify_container_running "$vmid"
    fi

    if echo "$verify_json" | jq -e '.notes_managed' >/dev/null 2>&1; then
        verify_notes_managed "$vmid"
    fi

    if echo "$verify_json" | jq -e '.services_up' >/dev/null 2>&1; then
        verify_services_up "$vmid"
    fi

    if echo "$verify_json" | jq -e '.lxc_log_no_errors' >/dev/null 2>&1; then
        verify_lxc_log "$vmid" "$hostname"
    fi

    if echo "$verify_json" | jq -e '.docker_log_no_errors' >/dev/null 2>&1; then
        verify_docker_logs "$vmid"
    fi

    local tls_port
    tls_port=$(echo "$verify_json" | jq -r '.tls_connect // empty' 2>/dev/null)
    if [ -n "$tls_port" ]; then
        verify_tls_connect "$vmid" "$tls_port"
    fi

    if echo "$verify_json" | jq -e '.pg_ssl_on' >/dev/null 2>&1; then
        verify_pg_ssl_on "$vmid"
    fi
}

# ── Wait for docker services to start ──
wait_for_services() {
    local vmid="$1"
    local max_wait="${2:-120}"

    log_info "Waiting for docker services (max ${max_wait}s)..."
    local elapsed=0
    while [ $elapsed -lt "$max_wait" ]; do
        local running
        running=$(nested_ssh "pct exec $vmid -- docker ps -q 2>/dev/null" || echo "")
        if [ -n "$running" ]; then
            # Check if all services are "Up"
            local not_up
            not_up=$(nested_ssh "pct exec $vmid -- docker ps --format '{{.Status}}' 2>/dev/null" | grep -v "Up" || true)
            if [ -z "$not_up" ]; then
                log_ok "Docker services ready after ${elapsed}s"
                return 0
            fi
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    log_warn "Docker services not fully ready after ${max_wait}s"
    return 0
}

# ════════════════════════════════════════════════════
#  Main
# ════════════════════════════════════════════════════

echo "========================================"
echo " OCI LXC Deployer - Live Integration Test"
echo "========================================"
echo ""
echo "Instance:  $E2E_INSTANCE"
echo "Test:      $TEST_NAME"
echo "Deployer:  $DEPLOYER_URL (HTTPS: $DEPLOYER_HTTPS_URL)"
echo "PVE Host:  $PVE_HOST"
echo ""

# 1. Verify prerequisites
log_info "Checking prerequisites..."

if [ ! -f "$PROJECT_ROOT/cli/dist/cli/src/oci-lxc-cli.mjs" ]; then
    log_fail "CLI not built. Run: cd $PROJECT_ROOT && pnpm run build"
    exit 1
fi
log_ok "CLI is built"

# Check deployer is reachable (try HTTPS first, then HTTP)
API_URL=""
if curl -skf --connect-timeout 5 "$DEPLOYER_HTTPS_URL/" >/dev/null 2>&1; then
    API_URL="$DEPLOYER_HTTPS_URL"
elif curl -sf --connect-timeout 5 "$DEPLOYER_URL/api/sshconfigs" >/dev/null 2>&1; then
    API_URL="$DEPLOYER_URL"
fi
if [ -z "$API_URL" ]; then
    log_fail "Deployer API not reachable at $DEPLOYER_HTTPS_URL or $DEPLOYER_URL"
    exit 1
fi
log_ok "Deployer API reachable at $API_URL"

# Discover VE host
VE_HOST=$(curl -skf "$API_URL/api/sshconfigs" | jq -r '.sshs[0].host // empty')
if [ -z "$VE_HOST" ]; then
    log_fail "Cannot determine VE host from deployer API"
    exit 1
fi
log_ok "VE host discovered: $VE_HOST"

# 2. Load test definition
if [ -f "$TEST_DEFS_FILE" ]; then
    TEST_DEF=$(jq -r ".\"$TEST_NAME\" // empty" "$TEST_DEFS_FILE")
fi

if [ -z "${TEST_DEF:-}" ] || [ "$TEST_DEF" = "null" ]; then
    # Fallback: treat TEST_NAME as application name, single-step test
    log_info "No test definition for '$TEST_NAME', using as application name"
    TEST_DEF=$(cat <<EOF
{"description":"Ad-hoc test: $TEST_NAME","steps":[{"application":"$TEST_NAME","task":"installation","verify":{"container_running":true,"notes_managed":true,"lxc_log_no_errors":true}}]}
EOF
    )
fi

DESCRIPTION=$(echo "$TEST_DEF" | jq -r '.description // "No description"')
STEP_COUNT=$(echo "$TEST_DEF" | jq '.steps | length')
log_ok "Test definition loaded: $DESCRIPTION ($STEP_COUNT steps)"

# 3. Execute steps
for STEP_IDX in $(seq 0 $((STEP_COUNT - 1))); do
    STEP=$(echo "$TEST_DEF" | jq ".steps[$STEP_IDX]")
    STEP_APP=$(echo "$STEP" | jq -r '.application')
    STEP_TASK=$(echo "$STEP" | jq -r '.task // "installation"')
    STEP_ADDONS=$(echo "$STEP" | jq -r '.addons // [] | join(",")')
    STEP_WAIT=$(echo "$STEP" | jq -r '.wait_seconds // "0"')
    STEP_VERIFY=$(echo "$STEP" | jq -c '.verify // {}')
    STEP_HOSTNAME="${STEP_APP}-${TIMESTAMP}"

    log_step "$((STEP_IDX + 1))/$STEP_COUNT" "$STEP_APP ($STEP_TASK)"

    # Create params file for this step
    STEP_PARAMS=$(mktemp /tmp/livetest-params-XXXXXX)
    mv "$STEP_PARAMS" "${STEP_PARAMS}.json"
    STEP_PARAMS="${STEP_PARAMS}.json"
    PARAMS_FILES="$PARAMS_FILES $STEP_PARAMS"

    # Check if there's a stack to link (from previous dependency installs)
    STACK_ID=""
    APP_STACKTYPE=$(curl -skf "$API_URL/api/applications" 2>/dev/null | jq -r ".[] | select(.id==\"$STEP_APP\") | .stacktype // empty" 2>/dev/null | head -1 || echo "")
    if [ -n "$APP_STACKTYPE" ]; then
        STACK_ID=$(curl -skf "$API_URL/api/stacks?stacktype=$APP_STACKTYPE" 2>/dev/null | jq -r '.stacks[0].id // empty' 2>/dev/null || echo "")
    fi

    # Build params JSON
    PARAMS_ARRAY='[{"name": "hostname", "value": "'"$STEP_HOSTNAME"'"}, {"name": "bridge", "value": "'"$VM_BRIDGE"'"}]'

    if [ -n "$STACK_ID" ]; then
        cat > "$STEP_PARAMS" <<PARAMS_EOF
{"params": $PARAMS_ARRAY, "stackId": "$STACK_ID"}
PARAMS_EOF
        log_info "Using stack: $STACK_ID"
    else
        cat > "$STEP_PARAMS" <<PARAMS_EOF
{"params": $PARAMS_ARRAY}
PARAMS_EOF
    fi

    # Add addons to params if defined
    if [ -n "$STEP_ADDONS" ]; then
        log_info "Addons: $STEP_ADDONS"
    fi

    # Run CLI
    log_info "Running: $STEP_APP $STEP_TASK..."
    STEP_OUTPUT=$(cli_remote "$STEP_APP" "$STEP_TASK" "$STEP_PARAMS" "$STEP_ADDONS")
    if [ $? -ne 0 ]; then
        log_fail "Step failed: $STEP_APP $STEP_TASK"
        echo "$STEP_OUTPUT" | tail -20
        exit 1
    fi

    # Extract VM_ID
    STEP_VMID=$(extract_vmid "$STEP_OUTPUT")
    if [ -z "$STEP_VMID" ]; then
        log_fail "Could not extract VM_ID from output"
        echo "$STEP_OUTPUT" | tail -20
        exit 1
    fi

    CREATED_VMS="$CREATED_VMS $STEP_VMID"
    log_ok "Container created: VM_ID=$STEP_VMID"

    # Track this container's IP for inter-container references
    STEP_IP=$(nested_ssh "pct exec $STEP_VMID -- ip -4 addr show eth0 2>/dev/null | grep inet | awk '{print \$2}' | cut -d/ -f1" 2>/dev/null || echo "")
    if [ -n "$STEP_IP" ]; then
        DEPLOYED_APP_IPS="$DEPLOYED_APP_IPS ${STEP_APP}=${STEP_IP}"
        log_info "Container IP: $STEP_IP (stored as ${STEP_APP})"
    fi

    # Patch .env with dependency IPs if this container has a docker-compose .env file
    if [ -n "$DEPLOYED_APP_IPS" ]; then
        ENV_PATH=$(nested_ssh "pct exec $STEP_VMID -- find /opt/docker-compose -name .env -type f 2>/dev/null | head -1" 2>/dev/null || echo "")
        if [ -n "$ENV_PATH" ]; then
            PATCHED=false
            for entry in $DEPLOYED_APP_IPS; do
                dep_app="${entry%%=*}"
                dep_ip="${entry#*=}"
                # Skip self-references
                [ "$dep_app" = "$STEP_APP" ] && continue
                host_var="$(echo "$dep_app" | tr '[:lower:]' '[:upper:]' | tr '-' '_')_HOST"
                # Update or append the HOST variable in .env
                nested_ssh "pct exec $STEP_VMID -- sh -c 'if grep -q \"^${host_var}=\" \"$ENV_PATH\"; then sed -i \"s|^${host_var}=.*|${host_var}=${dep_ip}|\" \"$ENV_PATH\"; else echo \"${host_var}=${dep_ip}\" >> \"$ENV_PATH\"; fi'" 2>/dev/null
                log_info "Patched $ENV_PATH: ${host_var}=${dep_ip}"
                PATCHED=true
            done
            if [ "$PATCHED" = "true" ]; then
                # Restart docker-compose to pick up new .env
                COMPOSE_DIR=$(dirname "$ENV_PATH")
                nested_ssh "pct exec $STEP_VMID -- sh -c 'cd $COMPOSE_DIR && docker compose down 2>/dev/null; docker compose up -d 2>/dev/null'" 2>/dev/null
                log_info "Docker compose restarted with updated .env"
            fi
        fi
    fi

    # Wait for services if needed
    if [ "$STEP_WAIT" -gt 0 ]; then
        wait_for_services "$STEP_VMID" "$STEP_WAIT"
    fi

    # Run verifications
    log_info "Verifying..."
    run_verifications "$STEP_VMID" "$STEP_HOSTNAME" "$STEP_VERIFY"
done

# 4. Summary
echo ""
echo "========================================"
echo " Test Summary"
echo "========================================"
echo ""
echo "Instance:     $E2E_INSTANCE"
echo "Test:         $TEST_NAME ($DESCRIPTION)"
echo "VMs created:  $CREATED_VMS"
echo "Tests Passed: $TESTS_PASSED"
echo "Tests Failed: $TESTS_FAILED"
echo ""

if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}FAILED${NC} - Some tests did not pass"
    echo ""
    echo "To inspect manually:"
    for vm in $CREATED_VMS; do
        echo "  ssh -p $PORT_PVE_SSH root@$PVE_HOST 'pct config $vm'"
    done
    exit 1
else
    echo -e "${GREEN}PASSED${NC} - All tests passed"
fi

echo ""
echo "Cleanup will run automatically on exit."
echo "Set KEEP_VM=1 to preserve containers for debugging."
