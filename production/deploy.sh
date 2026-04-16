#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PVE_HOST="pve1.cluster"
DEPLOYER_HOST="${DEPLOYER_HOST:-oci-lxc-deployer}"

# Auto-detect: HTTPS (port 3443) or HTTP (port 3080)
if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/applications" >/dev/null 2>&1; then
  SERVER="https://${DEPLOYER_HOST}:3443"
else
  SERVER="http://${DEPLOYER_HOST}:3080"
fi
echo "Using deployer at ${SERVER}"

# Detect execution mode: PVE host (use pct exec) or dev machine (use npx tsx)
DEPLOYER_VMID=""
if command -v pct >/dev/null 2>&1; then
  DEPLOYER_VMID=$(pct list 2>/dev/null | awk -v h="$DEPLOYER_HOST" '$3 == h {print $1}')
fi

if [ -n "$DEPLOYER_VMID" ]; then
  echo "Running on PVE host (deployer container: $DEPLOYER_VMID)"
  run_cli() {
    local params_file="$1"
    shift
    # Push JSON file into container and run CLI from inside
    pct push "$DEPLOYER_VMID" "$params_file" /tmp/deploy-params.json
    pct exec "$DEPLOYER_VMID" -- oci-lxc-cli remote \
      --server http://localhost:3080 --ve "$PVE_HOST" \
      --insecure "$@" /tmp/deploy-params.json
    pct exec "$DEPLOYER_VMID" -- rm -f /tmp/deploy-params.json
  }
else
  echo "Running on dev machine (using npx tsx)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

  # Load OIDC credentials if available (optional — without .env, CLI runs without auth)
  ENV_FILE="$SCRIPT_DIR/.env"
  if [ -f "$ENV_FILE" ]; then
    set -a; . "$ENV_FILE"; set +a
    echo "OIDC credentials loaded from $ENV_FILE"
  fi

  # Build OIDC flags if credentials are set
  OIDC_FLAGS=""
  if [ -n "$OIDC_CLI_CLIENT_ID" ]; then
    OIDC_FLAGS="--oidc-issuer $OIDC_ISSUER_URL --oidc-client-id $OIDC_CLI_CLIENT_ID --oidc-client-secret $OIDC_CLI_CLIENT_SECRET"
  fi

  run_cli() {
    local params_file="$1"
    shift
    NODE_TLS_REJECT_UNAUTHORIZED=0 $CLI remote \
      --server "$SERVER" --ve "$PVE_HOST" --insecure \
      $OIDC_FLAGS "$@" "$params_file"
  }
fi

ensure_stack() {
  echo "=== Ensuring production stacks exist ==="
  # Each stacktype has its own stack with ID: {type}_production
  for TYPE in postgres oidc cloudflare; do
    STACK_ID="${TYPE}_production"
    # Check if stack exists by listing stacks of this type and grepping for the ID
    if curl -sk "$SERVER/api/stacks?stacktype=${TYPE}" 2>/dev/null | grep -q "\"${STACK_ID}\""; then
      echo "  Stack '${STACK_ID}' exists."
    else
      echo "  Creating stack '${STACK_ID}'..."
      curl -sk -X POST "$SERVER/api/stacks" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"production\",\"stacktype\":\"${TYPE}\",\"entries\":[]}" \
        -o /dev/null -w "HTTP %{http_code}\n" || true
    fi
  done
}

deploy_app() {
  local app="$1"
  local timeout="${2:-600}"
  local params="$SCRIPT_DIR/$app.json"

  echo "=== Deploying $app ==="
  if [ ! -f "$params" ]; then
    echo "ERROR: $params not found"; exit 1
  fi

  run_cli "$params" --timeout "$timeout"
}

ensure_stack

# Dependency order: postgres → nginx → zitadel → gitea
case "${1:-all}" in
  docker-registry-mirror) deploy_app docker-registry-mirror ;;
  postgres) deploy_app postgres ;;
  nginx)    deploy_app nginx ;;
  zitadel)  deploy_app postgres; deploy_app zitadel 900 ;;
  gitea)    deploy_app postgres; deploy_app zitadel 900; deploy_app gitea ;;
  eclipse-mosquitto) deploy_app eclipse-mosquitto ;;
  all)
    deploy_app docker-registry-mirror
    deploy_app postgres
    deploy_app nginx
    deploy_app zitadel 900
    deploy_app gitea
    deploy_app eclipse-mosquitto
    ;;
  *.json)
    if [ ! -f "$1" ]; then
      # Try with SCRIPT_DIR prefix
      if [ -f "$SCRIPT_DIR/$1" ]; then
        echo "=== Deploying from $1 ==="
        run_cli "$SCRIPT_DIR/$1" --timeout 600
      else
        echo "ERROR: $1 not found"; exit 1
      fi
    else
      echo "=== Deploying from $1 ==="
      run_cli "$1" --timeout 600
    fi
    ;;
  *) echo "Usage: $0 [docker-registry-mirror|postgres|nginx|zitadel|gitea|eclipse-mosquitto|all|<file.json>]"; exit 1 ;;
esac
