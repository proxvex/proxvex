#!/bin/bash
# Deploy one or more applications to a PVE host via the proxvex deployer.
#
# Usage:
#   ./deploy.sh [--host <pve-host>] <app|file.json> [<app|file.json> ...]
#   ./deploy.sh <app>                          # uses default host
#   ./deploy.sh --host ubuntupve github-runner # explicit override
#
# Env:
#   PVE_HOST       default target PVE host (default: pve1.cluster)
#   DEPLOYER_HOST  default: proxvex
#
# The host is also passed to the proxvex CLI as `--ve <host>`, so the chosen
# PVE host must be registered in the deployer's SSH config (see
# setup-pve-host.sh).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Shared helpers: auth_curl + init_admin_pat + init_oidc_jwt. After Step 11
# the deployer enforces OIDC on /api/* and rejects opaque tokens (e.g. PATs)
# with HTTP 401 / "Invalid Compact JWS". init_oidc_jwt reads the deployer-cli
# machine credentials from /bootstrap/deployer-oidc.json on the Zitadel LXC,
# performs an OIDC client_credentials grant, and exports the resulting JWT as
# OCI_DEPLOYER_TOKEN — picked up by both auth_curl and oci-lxc-cli.
. "$SCRIPT_DIR/_lib.sh"

PVE_HOST="${PVE_HOST:-pve1.cluster}"
DEPLOYER_HOST="${DEPLOYER_HOST:-proxvex}"

# Pull credentials so both ensure_stack's curl and the CLI invocation below
# carry valid auth post-OIDC. Both are no-ops if Zitadel/deployer-oidc.json
# isn't ready yet (pre-Zitadel-deploy phase).
init_admin_pat "$PVE_HOST"
init_oidc_jwt "$PVE_HOST"
# Optional: load operator-issued PAT for headless Zitadel-API auth in
# templates (conf-setup-oidc-client.sh & friends). When set, gets injected
# as a `ZITADEL_PAT` param into every params.json before the CLI call so
# the templates use it instead of the on-LXC /bootstrap/admin-client.pat.
init_deployer_pat

# augment_params_with_pat <input_file> → echoes path of params file to use.
# When OCI_DEPLOYER_PAT is set, writes a tempfile with the original
# params + a `{"name":"ZITADEL_PAT","value":"<pat>"}` entry appended
# (replacing any existing entry of the same name). Caller is responsible
# for removing the returned file if it differs from the input.
augment_params_with_pat() {
  local input="$1"
  if [ -z "${OCI_DEPLOYER_PAT:-}" ]; then
    echo "$input"
    return 0
  fi
  # Write the augmented file into the SAME directory as the input. The CLI
  # resolves `file:foo.conf` parameter values relative to the params.json
  # directory, so a /tmp tempfile would break upload references like
  # `file:mosquitto.conf` or `file:node-red-settings.js`
  # (resolved against /tmp instead of production/).
  local input_dir
  input_dir=$(cd "$(dirname "$input")" && pwd)
  local out="${input_dir}/.deploy-params.augmented.$$.json"
  python3 - "$input" "$OCI_DEPLOYER_PAT" > "$out" <<'EOF'
import json, sys
input_file, pat = sys.argv[1], sys.argv[2]
with open(input_file) as f:
    data = json.load(f)
params = [p for p in data.get("params", []) if p.get("name") != "ZITADEL_PAT"]
params.append({"name": "ZITADEL_PAT", "value": pat})
data["params"] = params
print(json.dumps(data))
EOF
  echo "$out"
}

# Optional per-call host override
if [ "$1" = "--host" ] || [ "$1" = "--ve" ]; then
  PVE_HOST="$2"
  shift 2
fi

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
    local with_pat
    with_pat=$(augment_params_with_pat "$params_file")
    local effective_params
    effective_params=$(augment_params_with_previous_vmid "$with_pat") || true
    # Push JSON file into container and run CLI from inside.
    # Use HTTPS — after Step 6 (ACME) the HTTP listener on :3080 only
    # serves a 301 to :3443, and the CLI's HTTP client does not follow
    # redirects on POST, so plain http://localhost:3080 returns
    # "Not found" instead of the expected route handler.
    pct push "$DEPLOYER_VMID" "$effective_params" /tmp/deploy-params.json
    pct exec "$DEPLOYER_VMID" -- oci-lxc-cli remote \
      --server https://localhost:3443 --ve "$PVE_HOST" \
      --insecure "$@" /tmp/deploy-params.json
    pct exec "$DEPLOYER_VMID" -- rm -f /tmp/deploy-params.json
    [ "$effective_params" != "$with_pat" ] && rm -f "$effective_params"
    [ "$with_pat" != "$params_file" ] && rm -f "$with_pat"
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
    local with_pat
    with_pat=$(augment_params_with_pat "$params_file")
    local effective_params
    effective_params=$(augment_params_with_previous_vmid "$with_pat") || true
    NODE_TLS_REJECT_UNAUTHORIZED=0 $CLI remote \
      --server "$SERVER" --ve "$PVE_HOST" --insecure \
      $OIDC_FLAGS "$@" "$effective_params"
    [ "$effective_params" != "$with_pat" ] && rm -f "$effective_params"
    [ "$with_pat" != "$params_file" ] && rm -f "$with_pat"
  }
fi

ensure_stack() {
  echo "=== Ensuring production stacks exist ==="
  # Each stacktype has its own stack with ID: {type}_production.
  # auth_curl injects the Zitadel admin PAT as Bearer when set (post-OIDC).
  for TYPE in postgres oidc cloudflare; do
    STACK_ID="${TYPE}_production"
    if auth_curl -sk "$SERVER/api/stacks?stacktype=${TYPE}" 2>/dev/null | grep -q "\"${STACK_ID}\""; then
      echo "  Stack '${STACK_ID}' exists."
    else
      echo "  Creating stack '${STACK_ID}'..."
      auth_curl -sk -X POST "$SERVER/api/stacks" \
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

# Resolve previous_vm_id for upgrade/reconfigure tasks by querying the
# deployer's installations API for managed containers with the given
# application_id. Errors out if zero or more-than-one are found — for
# multi-instance setups the operator must specify previous_vm_id manually
# in the params file. Echoes the VMID on stdout when exactly one is found.
resolve_previous_vmid() {
  local app="$1"
  local body
  body=$(auth_curl -sk --max-time 30 "$SERVER/api/ve_${PVE_HOST}/installations" 2>/dev/null)
  if [ -z "$body" ]; then
    echo "WARN: could not query installations API — cannot auto-detect previous_vm_id for $app" >&2
    return 1
  fi
  # Extract vm_ids where application_id matches. Use jq if available, else
  # fall back to a grep+awk pipeline that handles the same JSON shape.
  local matches
  if command -v jq >/dev/null 2>&1; then
    matches=$(echo "$body" | jq -r ".[] | select(.application_id == \"$app\") | .vm_id" 2>/dev/null)
  else
    matches=$(echo "$body" | tr ',' '\n' | awk -v app="$app" '
      /"vm_id":/ { gsub(/[^0-9]/, ""); cur_vmid=$0 }
      /"application_id":/ { gsub(/"|application_id|:| /, ""); if ($0 == app && cur_vmid != "") print cur_vmid; cur_vmid="" }
    ')
  fi
  local count
  count=$(echo "$matches" | grep -c .)
  if [ "$count" -eq 0 ]; then
    echo "ERROR: no managed container found for application_id=$app on $PVE_HOST" >&2
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "ERROR: multiple managed containers found for application_id=$app on $PVE_HOST (VMIDs: $matches) — set previous_vm_id explicitly in the params JSON to disambiguate" >&2
    return 1
  fi
  echo "$matches"
}

# Auto-inject previous_vm_id into the params JSON for upgrade/reconfigure
# tasks when missing. Echoes the (possibly-augmented) params file path —
# caller is responsible for removing the returned file if it differs from
# the input.
augment_params_with_previous_vmid() {
  local input="$1"
  local task
  task=$(grep -oE '"task"[[:space:]]*:[[:space:]]*"[^"]+"' "$input" 2>/dev/null | head -1 | sed -E 's/.*"task"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  case "$task" in
    upgrade|reconfigure) ;;
    *) echo "$input"; return 0 ;;
  esac
  # Already set in params?
  if grep -q '"name"[[:space:]]*:[[:space:]]*"previous_vm_id"' "$input" 2>/dev/null; then
    echo "$input"; return 0
  fi
  local app
  app=$(grep -oE '"application"[[:space:]]*:[[:space:]]*"[^"]+"' "$input" | head -1 | sed -E 's/.*"application"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  if [ -z "$app" ]; then echo "$input"; return 0; fi
  local vmid
  if ! vmid=$(resolve_previous_vmid "$app"); then
    # Resolution failed (zero or multiple matches). Pass the input through;
    # the CLI will reject with a clear "previous_vm_id is required" error.
    echo "$input"; return 1
  fi
  echo "  Auto-resolved previous_vm_id=$vmid for $task task" >&2
  local out
  out=$(mktemp)
  if command -v jq >/dev/null 2>&1; then
    jq --argjson v "$vmid" '.params += [{"name":"previous_vm_id","value":$v}]' "$input" > "$out"
  else
    awk -v vmid="$vmid" '
      /"params"[[:space:]]*:[[:space:]]*\[/ {
        sub(/\[/, "[ {\"name\":\"previous_vm_id\",\"value\":" vmid "},")
      }
      { print }
    ' "$input" > "$out"
  fi
  echo "$out"
}

ensure_stack

# Dependency order: postgres → nginx → zitadel → gitea
case "${1:-all}" in
  docker-registry-mirror) deploy_app docker-registry-mirror ;;
  ghcr-registry-mirror)   deploy_app ghcr-registry-mirror ;;
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
  *) echo "Usage: $0 [docker-registry-mirror|ghcr-registry-mirror|postgres|nginx|zitadel|gitea|eclipse-mosquitto|all|<file.json>]"; exit 1 ;;
esac
