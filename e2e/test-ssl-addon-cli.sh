#!/bin/bash
# test-ssl-addon-cli.sh - E2E tests for SSL addon via CLI
#
# Tests SSL addon functionality for three scenarios:
#   1. oci-lxc-deployer (reconfigure, proxy mode)
#   2. postgres (installation, certs mode)
#   3. zitadel (installation, docker-compose, native mode)
#
# Prerequisites:
#   - Nested VM running with deployer installed (step1 + step2)
#   - Project built (pnpm run build)
#
# Usage:
#   ./test-ssl-addon-cli.sh [instance]
#   ./test-ssl-addon-cli.sh [instance] --init        # Rollback to deployer-installed snapshot first
#   ./test-ssl-addon-cli.sh [instance] --test 1      # Run only test 1
#   ./test-ssl-addon-cli.sh [instance] --test 1,2    # Run tests 1 and 2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load shared configuration
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

# Parse arguments
INSTANCE_ARG=""
INIT_ENV=false
RUN_TESTS="1,2,3"
for arg in "$@"; do
    case "$arg" in
        --init) INIT_ENV=true ;;
        --test)
            # Next arg will be the test list
            NEXT_IS_TEST=true
            continue
            ;;
        -*)
            ;;
        *)
            if [ "${NEXT_IS_TEST:-}" = "true" ]; then
                RUN_TESTS="$arg"
                NEXT_IS_TEST=false
            elif [ -z "$INSTANCE_ARG" ]; then
                INSTANCE_ARG="$arg"
            fi
            ;;
    esac
done

# Load config for the specified instance
load_config "$INSTANCE_ARG"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Counters
PASS_COUNT=0
FAIL_COUNT=0

# CLI binary
CLI="node $PROJECT_ROOT/backend/dist/cli/oci-lxc-cli.mjs"

log()     { echo -e "${YELLOW}[INFO]${NC} $*" >&2; }
pass()    { echo -e "${GREEN}  PASS${NC}: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()    { echo -e "${RED}  FAIL${NC}: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
header()  {
    echo ""
    echo -e "${BLUE}-----------------------------------------------------------${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}-----------------------------------------------------------${NC}"
}

# SSH wrapper for nested VM (via PVE host port forwarding)
nested_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=10 \
        -p "$PORT_PVE_SSH" "root@$PVE_HOST" "$@"
}

# SSH wrapper for PVE host directly (VM management)
pve_ssh() {
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=10 \
        "root@$PVE_HOST" "$@"
}

# Wait for deployer API to be ready
wait_for_deployer() {
    log "Waiting for deployer API at $DEPLOYER_URL ..."
    local max_wait=60 waited=0
    while ! curl -sf --connect-timeout 2 "$DEPLOYER_URL/" >/dev/null 2>&1; do
        waited=$((waited + 2))
        if [ $waited -ge $max_wait ]; then
            echo "ERROR: Deployer API not reachable at $DEPLOYER_URL after ${max_wait}s" >&2
            return 1
        fi
        sleep 2
    done
    log "Deployer API is ready"
}

# Discover VE host from deployer API
discover_ve_host() {
    local ve_host
    ve_host=$(curl -sf "$DEPLOYER_URL/api/sshconfigs" | jq -r '.sshs[0].host // empty')
    if [ -z "$ve_host" ]; then
        echo "ERROR: Cannot determine VE host from deployer API" >&2
        return 1
    fi
    echo "$ve_host"
}

# Run CLI remote command
# Usage: cli_remote <application> <task> <params_file> [extra_args...]
cli_remote() {
    local app="$1" task="$2" params_file="$3"
    shift 3
    log "CLI: $app $task (params: $params_file)"
    $CLI remote \
        --server "$DEPLOYER_URL" \
        --ve "$VE_HOST" \
        --insecure \
        --timeout 600 \
        "$app" "$task" "$params_file" \
        "$@"
}

# Clean test containers (keep deployer)
clean_test_containers() {
    log "Cleaning test containers (keeping deployer $DEPLOYER_VMID)..."
    "$SCRIPT_DIR/clean-test-containers.sh" "$E2E_INSTANCE" 2>/dev/null || true
}

# Check if a test should run
should_run() {
    echo ",$RUN_TESTS," | grep -q ",$1,"
}

###############################################################################
# Environment initialization
###############################################################################
init_environment() {
    header "Initializing test environment"

    # Try rollback to deployer-installed snapshot first
    log "Rolling back to deployer-installed snapshot..."
    if pve_ssh "qm rollback $TEST_VMID deployer-installed" 2>/dev/null; then
        log "Snapshot rolled back, starting VM..."
        pve_ssh "qm start $TEST_VMID" 2>/dev/null || true
        # Wait for SSH
        local max_wait=60 waited=0
        while ! nested_ssh "echo ok" &>/dev/null; do
            waited=$((waited + 2))
            if [ $waited -ge $max_wait ]; then
                echo "ERROR: VM did not come up after snapshot rollback" >&2
                return 1
            fi
            sleep 2
        done
        log "VM is up after snapshot rollback"
    else
        log "No deployer-installed snapshot found, running step1 + step2..."
        "$SCRIPT_DIR/step1-create-vm.sh" "$E2E_INSTANCE"
        "$SCRIPT_DIR/step2-install-deployer.sh" "$E2E_INSTANCE"
    fi
}

###############################################################################
# Test 1: oci-lxc-deployer + SSL addon (reconfigure, proxy mode)
###############################################################################
test_deployer_ssl() {
    header "Test 1: oci-lxc-deployer + SSL addon (proxy mode)"

    local params_file="$SCRIPT_DIR/test-params/deployer-ssl-reconfigure.json"

    # Run reconfigure
    if ! cli_remote "oci-lxc-deployer" "reconfigure" "$params_file"; then
        fail "oci-lxc-deployer reconfigure command failed"
        return 1
    fi

    # Wait for container to settle
    sleep 5

    # Validate: certificates exist
    if nested_ssh "pct exec $DEPLOYER_VMID -- test -f /etc/ssl/addon/fullchain.pem" 2>/dev/null; then
        pass "fullchain.pem exists"
    else
        fail "fullchain.pem missing in /etc/ssl/addon/"
    fi

    if nested_ssh "pct exec $DEPLOYER_VMID -- test -f /etc/ssl/addon/privkey.pem" 2>/dev/null; then
        pass "privkey.pem exists"
    else
        fail "privkey.pem missing in /etc/ssl/addon/"
    fi

    # Validate: certificate has valid CN
    local cert_subject
    cert_subject=$(nested_ssh "pct exec $DEPLOYER_VMID -- openssl x509 -in /etc/ssl/addon/fullchain.pem -noout -subject 2>/dev/null" 2>/dev/null || true)
    if echo "$cert_subject" | grep -q "CN="; then
        pass "certificate has valid subject: $cert_subject"
    else
        fail "certificate has no CN"
    fi

    # Validate: HTTPS accessible via port-forwarded URL
    if curl -kf --connect-timeout 10 "$DEPLOYER_HTTPS_URL/" >/dev/null 2>&1; then
        pass "HTTPS accessible at $DEPLOYER_HTTPS_URL"
    else
        fail "HTTPS not accessible at $DEPLOYER_HTTPS_URL"
    fi
}

###############################################################################
# Test 2: postgres + SSL addon (installation, certs mode)
###############################################################################
test_postgres_ssl() {
    header "Test 2: postgres + SSL addon (certs mode)"

    local postgres_ip="10.0.0.50"
    local params_file
    params_file=$(mktemp /tmp/postgres-ssl-params.XXXXXX.json)

    # Generate parameters file
    cat > "$params_file" <<EOF
{
  "params": [
    { "name": "bridge", "value": "vmbr1" },
    { "name": "static_ip", "value": "${postgres_ip}/24" },
    { "name": "static_gw", "value": "10.0.0.1" },
    { "name": "hostname", "value": "postgres" }
  ],
  "addons": ["addon-ssl"]
}
EOF

    # Run installation
    if ! cli_remote "postgres" "installation" "$params_file"; then
        fail "postgres installation with SSL failed"
        rm -f "$params_file"
        return 1
    fi
    rm -f "$params_file"

    # Wait for postgres to be ready
    log "Waiting for postgres to start..."
    sleep 15

    # Find postgres container VMID
    local pg_vmid
    pg_vmid=$(nested_ssh "pct list 2>/dev/null | grep postgres | awk '{print \$1}'" 2>/dev/null || true)
    if [ -z "$pg_vmid" ]; then
        fail "postgres container not found"
        return 1
    fi
    log "Postgres container VMID: $pg_vmid"

    # Validate: certificate files exist in the certs volume
    if nested_ssh "pct exec $pg_vmid -- test -f /certs/fullchain.pem" 2>/dev/null; then
        pass "postgres: /certs/fullchain.pem exists"
    else
        fail "postgres: /certs/fullchain.pem missing"
    fi

    if nested_ssh "pct exec $pg_vmid -- test -f /certs/privkey.pem" 2>/dev/null; then
        pass "postgres: /certs/privkey.pem exists"
    else
        fail "postgres: /certs/privkey.pem missing"
    fi

    # Validate: TLS connection via openssl s_client
    if nested_ssh "echo | openssl s_client -starttls postgres -connect ${postgres_ip}:5432 2>&1 | grep -q 'Certificate chain'" 2>/dev/null; then
        pass "postgres: TLS connection verified (openssl s_client)"
    else
        fail "postgres: TLS connection failed"
    fi
}

###############################################################################
# Test 3: zitadel + SSL addon (docker-compose, native mode)
###############################################################################
test_zitadel_ssl() {
    header "Test 3: zitadel + SSL addon (docker-compose, native mode)"

    local zitadel_ip="10.0.0.51"

    # Discover stack ID from postgres (zitadel depends on postgres via stacktype)
    local stack_id
    stack_id=$(curl -sf "$DEPLOYER_URL/api/ve_${VE_HOST}/stacks" 2>/dev/null | jq -r '.stacks[0].id // empty' || true)
    if [ -z "$stack_id" ]; then
        log "WARNING: No stack found. Zitadel may fail to connect to postgres."
    else
        log "Using stack: $stack_id"
    fi

    local params_file
    params_file=$(mktemp /tmp/zitadel-ssl-params.XXXXXX.json)

    # Generate parameters file
    cat > "$params_file" <<EOF
{
  "params": [
    { "name": "bridge", "value": "vmbr1" },
    { "name": "static_ip", "value": "${zitadel_ip}/24" },
    { "name": "static_gw", "value": "10.0.0.1" },
    { "name": "hostname", "value": "zitadel" }
  ],
  "addons": ["addon-ssl"]${stack_id:+,
  "stackId": "$stack_id"}
}
EOF

    # Run installation
    if ! cli_remote "zitadel" "installation" "$params_file"; then
        fail "zitadel installation with SSL failed"
        rm -f "$params_file"
        return 1
    fi
    rm -f "$params_file"

    # Wait for zitadel to be ready (docker-compose services take longer)
    log "Waiting for zitadel to start (up to 60s)..."
    sleep 30

    # Find zitadel container VMID
    local zit_vmid
    zit_vmid=$(nested_ssh "pct list 2>/dev/null | grep zitadel | awk '{print \$1}'" 2>/dev/null || true)
    if [ -z "$zit_vmid" ]; then
        fail "zitadel container not found"
        return 1
    fi
    log "Zitadel container VMID: $zit_vmid"

    # Validate: certificate files exist in /certs
    if nested_ssh "pct exec $zit_vmid -- test -f /certs/fullchain.pem" 2>/dev/null; then
        pass "zitadel: /certs/fullchain.pem exists"
    else
        fail "zitadel: /certs/fullchain.pem missing"
    fi

    if nested_ssh "pct exec $zit_vmid -- test -f /certs/privkey.pem" 2>/dev/null; then
        pass "zitadel: /certs/privkey.pem exists"
    else
        fail "zitadel: /certs/privkey.pem missing"
    fi

    # Validate: HTTPS ready endpoint (via docker exec inside LXC)
    local ready_ok=false
    for attempt in $(seq 1 6); do
        if nested_ssh "pct exec $zit_vmid -- sh -c 'curl -kf https://localhost:8080/debug/ready 2>/dev/null'" 2>/dev/null; then
            ready_ok=true
            break
        fi
        log "Waiting for zitadel ready endpoint (attempt $attempt/6)..."
        sleep 10
    done

    if [ "$ready_ok" = "true" ]; then
        pass "zitadel: HTTPS ready endpoint works"
    else
        fail "zitadel: HTTPS ready endpoint not responding"
    fi
}

###############################################################################
# Main
###############################################################################
main() {
    echo ""
    echo -e "${BLUE}SSL Addon E2E Tests (CLI-based)${NC}"
    echo "Instance: $E2E_INSTANCE"
    echo "Deployer: $DEPLOYER_URL"
    echo "Tests:    $RUN_TESTS"
    echo ""

    # Check CLI binary exists
    if [ ! -f "$PROJECT_ROOT/backend/dist/cli/oci-lxc-cli.mjs" ]; then
        echo "ERROR: CLI not built. Run: cd $PROJECT_ROOT && pnpm run build" >&2
        exit 1
    fi

    # Init environment if requested
    if [ "$INIT_ENV" = "true" ]; then
        init_environment
    fi

    # Wait for deployer
    wait_for_deployer || exit 1

    # Discover VE host
    VE_HOST=$(discover_ve_host) || exit 1
    log "VE host: $VE_HOST"

    # Clean test containers before starting (keep deployer)
    if should_run 2 || should_run 3; then
        clean_test_containers
    fi

    # Run selected tests
    if should_run 1; then
        test_deployer_ssl || true
    fi

    if should_run 2; then
        test_postgres_ssl || true
    fi

    if should_run 3; then
        test_zitadel_ssl || true
    fi

    # Summary
    echo ""
    echo -e "${BLUE}===========================================================${NC}"
    echo -e "  Results: ${GREEN}$PASS_COUNT passed${NC}, ${RED}$FAIL_COUNT failed${NC}"
    echo -e "${BLUE}===========================================================${NC}"
    echo ""

    [ "$FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
}

main
