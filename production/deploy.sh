#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PVE_HOST="pve1.cluster"
DEPLOYER_HOST="oci-lxc-deployer"

CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

# Auto-detect: HTTPS (port 3443) or HTTP (port 3080)
if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/applications" >/dev/null 2>&1; then
  SERVER="https://${DEPLOYER_HOST}:3443"
else
  SERVER="http://${DEPLOYER_HOST}:3080"
fi
echo "Using deployer at ${SERVER}"

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

ensure_stack() {
  echo "=== Ensuring stack 'production' exists ==="
  # Check if stack already exists (avoid overwriting cloudflare entries)
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "$SERVER/api/stack/production" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "  Stack 'production' already exists (skipping creation to preserve entries)."
  else
    echo "  Creating stack 'production'..."
    curl -sk -X POST "$SERVER/api/stacks" \
      -H "Content-Type: application/json" \
      -d '{"name":"production","stacktype":["postgres","oidc","cloudflare"],"entries":[]}' \
      -o /dev/null -w "HTTP %{http_code}\n" || true
  fi
}

deploy_app() {
  local app="$1"
  local timeout="${2:-600}"
  local params="$SCRIPT_DIR/$app.json"

  echo "=== Deploying $app ==="
  if [ ! -f "$params" ]; then
    echo "ERROR: $params not found"; exit 1
  fi

  NODE_TLS_REJECT_UNAUTHORIZED=0 $CLI remote \
    --server "$SERVER" --ve "$PVE_HOST" --insecure \
    --timeout "$timeout" $OIDC_FLAGS "$params"
}

ensure_stack

# Dependency order: postgres → nginx → zitadel → gitea
case "${1:-all}" in
  postgres) deploy_app postgres ;;
  nginx)    deploy_app nginx ;;
  zitadel)  deploy_app postgres; deploy_app zitadel 900 ;;
  gitea)    deploy_app postgres; deploy_app zitadel 900; deploy_app gitea ;;
  all)
    deploy_app postgres
    deploy_app nginx
    deploy_app zitadel 900
    deploy_app gitea
    ;;
  *) echo "Usage: $0 [postgres|nginx|zitadel|gitea|all]"; exit 1 ;;
esac
