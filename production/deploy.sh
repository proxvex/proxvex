#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PVE_HOST="pve1.cluster"
PORT_DEPLOYER_HTTPS=3443

SERVER="https://${PVE_HOST}:${PORT_DEPLOYER_HTTPS}"
CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

ensure_stack() {
  echo "=== Ensuring stack 'production' exists ==="
  curl -sk -X POST "$SERVER/api/stacks" \
    -H "Content-Type: application/json" \
    -d '{"name":"production","stacktype":["postgres","oidc"],"entries":[]}' \
    -o /dev/null -w "HTTP %{http_code}\n" || true
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
    --timeout "$timeout" "$params"
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
