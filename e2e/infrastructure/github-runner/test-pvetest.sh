#!/bin/bash
# test-pvetest.sh - Run CI pipeline locally with Docker test-worker
#
# Starts a test-worker Docker container, then runs all ci-tests.yml
# steps via pvetest. Aborts on first failure.
#
# Architecture:
#   Local machine (= github-runner) ──SSH──▶ Docker test-worker (127.0.0.1:2222)
#                                    ──SSH──▶ Real PVE host (PVETEST_HOST)
#                                    ──SSH──▶ Real nested VM (PVETEST_HOST:NESTED_PORT)
#
# The user's SSH key (~/.ssh/id_*) is used for all connections:
#   - Runner → test-worker (local key authenticates via SSH_PUBLIC_KEY)
#   - Test-worker → PVE host / nested VM (key injected via SSH_PRIVATE_KEY)
#
# Prerequisites:
#   - Docker running
#   - SSH key in ~/.ssh/ with access to PVE host and nested VM
#   - Current commit pushed to remote (for checkout on test-worker)
#
# Usage:
#   ./test-pvetest.sh                        # Run all CI steps (quiet)
#   ./test-pvetest.sh --fast                 # Skip deployer install (use deployer-installed snapshot)
#   ./test-pvetest.sh --verbose              # Show full command output
#   ./test-pvetest.sh --keep                 # Keep container on failure
#   ./test-pvetest.sh --ssh-key ~/.ssh/mykey # Custom SSH key

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PVETEST="$SCRIPT_DIR/pvetest"

WORKER_IMAGE="pvetest-worker:local"
WORKER_CONTAINER="pvetest-worker-$$"
WORKER_PORT=2222
KEEP=false
VERBOSE=false
FAST=false
SSH_KEY_FILE=""

# --- Parse arguments ---
while [ "$#" -gt 0 ]; do
    case "$1" in
        --keep)      KEEP=true; shift ;;
        --fast)      FAST=true; shift ;;
        --verbose|-v) VERBOSE=true; shift ;;
        --ssh-key)   SSH_KEY_FILE="$2"; shift 2 ;;
        --help|-h)
            sed -n '2,/^$/s/^# \?//p' "$0"
            exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# --- Colors ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()   { echo -e "${YELLOW}[test]${NC} $*"; }
ok()     { echo -e "${GREEN}[test]${NC} $*"; }
err()    { echo -e "${RED}[test]${NC} $*" >&2; }

# Persistent log directory for all step outputs (survives for artifact upload)
LOG_DIR="$REPO_ROOT/e2e/test-results/pvetest-logs"
mkdir -p "$LOG_DIR"

# run_step <number> <description> <command...>
# Saves output to LOG_DIR. Shows one-line pass/fail; full output on failure.
run_step() {
    local num="$1" desc="$2"
    shift 2
    local logfile="$LOG_DIR/step-$(printf '%s' "$num" | grep -q '^[0-9]*$' && printf '%02d' "$num" || printf '%s' "$num").log"
    printf "${BLUE}── Step %s: %s ──${NC} " "$num" "$desc"
    printf "── Step %s: %s ──\n\n" "$num" "$desc" >"$logfile"
    if "$@" >>"$logfile" 2>&1; then
        echo -e "${GREEN}OK${NC}"
        return 0
    else
        local rc=$?
        echo -e "${RED}FAILED (exit $rc)${NC}"
        echo ""
        cat "$logfile"
        echo ""
        echo -e "${YELLOW}── Log: $logfile ──${NC}"
        return $rc
    fi
}

# --- Auto-detect SSH key ---
if [ -z "$SSH_KEY_FILE" ]; then
    for candidate in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa" "$HOME/.ssh/id_ecdsa"; do
        if [ -f "$candidate" ]; then
            SSH_KEY_FILE="$candidate"
            break
        fi
    done
fi
[ -z "$SSH_KEY_FILE" ] && { err "No SSH key found in ~/.ssh/ — use --ssh-key <path>"; exit 1; }
[ -f "$SSH_KEY_FILE" ] || { err "SSH key not found: $SSH_KEY_FILE"; exit 1; }
[ -f "${SSH_KEY_FILE}.pub" ] || { err "Public key not found: ${SSH_KEY_FILE}.pub"; exit 1; }
ok "Using SSH key: $SSH_KEY_FILE"

# --- Cleanup on exit ---
cleanup() {
    local exit_code=$?
    if [ -n "${WORKER_CONTAINER:-}" ]; then
        if $KEEP && [ $exit_code -ne 0 ]; then
            info "Container kept for debugging: $WORKER_CONTAINER (port $WORKER_PORT)"
            info "  Attach:  docker exec -it $WORKER_CONTAINER sh"
            info "  Remove:  docker rm -f $WORKER_CONTAINER"
        else
            docker rm -f "$WORKER_CONTAINER" 2>/dev/null || true
        fi
    fi
    if [ $exit_code -eq 0 ]; then
        echo ""
        ok "All CI steps completed successfully"
    else
        echo ""
        err "Aborted (exit code $exit_code)"
    fi
    info "Logs: $LOG_DIR"
}
trap cleanup EXIT INT TERM

# ============================================================
# Build test-worker image
# ============================================================
info "Building test-worker image..."
docker build -q -t "$WORKER_IMAGE" "$REPO_ROOT/e2e/infrastructure/test-worker" >/dev/null
ok "Image built: $WORKER_IMAGE"

# ============================================================
# Start test-worker container
# ============================================================
# Source pvetest.env early to get PVETEST_HOST for DNS resolution
if [ -f "$SCRIPT_DIR/pvetest.env" ]; then
    set -a; . "$SCRIPT_DIR/pvetest.env"; set +a
fi

# Resolve PVE host so the container can reach it by hostname
ADD_HOST_FLAGS=""
if [ -n "${PVETEST_HOST:-}" ]; then
    PVE_IP=$(python3 -c "import socket; print(socket.gethostbyname('$PVETEST_HOST'))" 2>/dev/null) \
        || { err "Cannot resolve $PVETEST_HOST"; exit 1; }
    ADD_HOST_FLAGS="--add-host $PVETEST_HOST:$PVE_IP"
    ok "Resolved $PVETEST_HOST → $PVE_IP"
fi

docker run -d \
    --name "$WORKER_CONTAINER" \
    -p "$WORKER_PORT:22" \
    $ADD_HOST_FLAGS \
    -e "SSH_PUBLIC_KEY=$(cat "${SSH_KEY_FILE}.pub")" \
    -e "SSH_PRIVATE_KEY=$(cat "$SSH_KEY_FILE")" \
    "$WORKER_IMAGE" >/dev/null

info "Waiting for test-worker SSH (127.0.0.1:$WORKER_PORT)..."
for i in $(seq 1 30); do
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o BatchMode=yes -o ConnectTimeout=2 -o LogLevel=ERROR \
        -p "$WORKER_PORT" node@127.0.0.1 true 2>/dev/null && break
    sleep 1
done
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o BatchMode=yes -o ConnectTimeout=2 -o LogLevel=ERROR \
    -p "$WORKER_PORT" node@127.0.0.1 true 2>/dev/null \
    || { err "Test-worker SSH not ready after 30s"; exit 1; }
ok "Test-worker running (port $WORKER_PORT)"

# Install rsync for workspace sync (not in base image to keep it lean)
docker exec "$WORKER_CONTAINER" apt-get update -qq >/dev/null 2>&1
docker exec "$WORKER_CONTAINER" apt-get install -y -qq rsync >/dev/null 2>&1

# ============================================================
# Configure pvetest environment (pvetest.env already sourced above)
# ============================================================

# Override worker connection to Docker container
export PVETEST_WORKER_HOST=127.0.0.1
export PVETEST_WORKER_PORT=$WORKER_PORT
export PVETEST_WORKER_USER=node
export PVETEST_WORKSPACE=/home/node/workspace

# Load E2E config for port values (step2 and port check)
source "$REPO_ROOT/e2e/config.sh"
load_config github-action

info "PVETEST_HOST=$PVETEST_HOST"
info "PORT_PVE_SSH=$PORT_PVE_SSH PORT_DEPLOYER=$PORT_DEPLOYER"

# ============================================================
# Sync local working copy to test-worker via rsync
# ============================================================
SSH_CMD="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p $WORKER_PORT"

sync_to_worker() {
    rsync -az --delete \
        --exclude node_modules --exclude .git --exclude dist \
        --exclude backend/coverage --exclude e2e/test-results \
        -e "$SSH_CMD" \
        "$REPO_ROOT/" "node@127.0.0.1:/home/node/workspace/"
}

# Check that required ports are listening on PVE host (with retry)
check_ports() {
    local host="$PVETEST_HOST"
    local max_attempts=30
    local failed=0
    for port in "$@"; do
        local ok=false
        for i in $(seq 1 $max_attempts); do
            if nc -z -w 5 "$host" "$port" 2>/dev/null; then
                ok=true
                break
            fi
            [ $((i % 5)) -eq 0 ] && echo "  waiting for $host:$port... ${i}/${max_attempts}"
            sleep 2
        done
        if $ok; then
            echo "  [ok] $host:$port"
        else
            echo "  [FAIL] $host:$port not reachable after ${max_attempts} attempts"
            failed=1
        fi
    done
    return $failed
}

# ============================================================
# Run CI steps (mirrors ci-tests.yml — aborts on first failure)
# Output is captured per step; only shown on failure.
# Use --verbose to see all output.
# ============================================================

run_step 1  "pvetest check"            $PVETEST check
run_step 2  "Rsync local workspace"    sync_to_worker
run_step 3  "Install dependencies"     $PVETEST exec pnpm install --frozen-lockfile
run_step 4  "Code quality (jscpd)"     $PVETEST exec "pnpm dupcheck"
if $FAST; then
    run_step "5-7"  "Snapshot rollback (fast)" $PVETEST snapshot-rollback deployer-installed
else
    run_step 5  "Snapshot rollback"        $PVETEST snapshot-rollback baseline
    run_step 6a "Setup mirrors"            "$REPO_ROOT/e2e/step2a-setup-mirrors.sh" github-action
    run_step 6b "Install deployer"         "$REPO_ROOT/e2e/step2b-install-deployer.sh" github-action
fi
run_step 7  "Check ports"              check_ports "$PORT_PVE_SSH" "$PORT_DEPLOYER"
run_step 8  "Frontend tests"           $PVETEST exec "cd frontend && CI=true pnpm test"
run_step 9  "Backend tests"            $PVETEST exec "cd backend && CI=true pnpm test:all"
run_step 10 "Template tests"           $PVETEST exec "cd backend && CI=true E2E_INSTANCE=github-action pnpm test:templates"
run_step 11 "Playwright + build"       $PVETEST exec "pnpm exec playwright install chromium && pnpm run build"
run_step 12 "Clean test containers"    $PVETEST exec "./e2e/clean-test-containers.sh github-action" || true
run_step 13 "Playwright E2E tests"     $PVETEST exec "CI=true E2E_INSTANCE=github-action pnpm exec playwright test --project=nested-vm"
