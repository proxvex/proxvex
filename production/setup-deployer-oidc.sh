#!/bin/bash
# Reconfigure proxvex to enable OIDC authentication.
# This also activates native HTTPS (port 3443).
#
# Prerequisites:
#   - proxvex is running (HTTP on port 3080)
#   - Zitadel is deployed (auto-creates deployer OIDC credentials)
#
# Usage:
#   ./production/setup-deployer-oidc.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
. "$SCRIPT_DIR/_lib.sh"

PVE_HOST="${PVE_HOST:-pve1.cluster}"
DEPLOYER_HOST="${DEPLOYER_HOST:-proxvex}"
CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

# Fetch a deployer JWT via init_oidc_jwt — this requests the right Zitadel
# scopes (project audience + projects:roles) so the JWT carries the admin
# role claim. The CLI's own internal grant in cli-api-client.mts only asks
# for `scope=openid`, which yields a JWT WITHOUT roles → deployer's
# webapp-auth-middleware role check returns 403 ("Invalid token"). Pre-
# fetching here and exporting OCI_DEPLOYER_TOKEN makes CliApiClient
# short-circuit (see cli-api-client.mts:104) and use this token verbatim.
init_oidc_jwt "$PVE_HOST"

# --- Step 1: Detect deployer API (HTTP or HTTPS) ---
# After OIDC enforcement /api/applications returns 401 without a Bearer
# token; auth_curl injects OCI_DEPLOYER_TOKEN (set by init_oidc_jwt above)
# so we get a real status code instead of being denied at the auth layer.
echo "=== Step 1: Detect deployer API ==="

if auth_curl -sk --connect-timeout 3 -o /dev/null -w '%{http_code}' "https://${DEPLOYER_HOST}:3443/api/applications" 2>/dev/null | grep -qE '^(2|3)[0-9][0-9]$'; then
  SERVER="https://${DEPLOYER_HOST}:3443"
elif auth_curl -sk --connect-timeout 3 -o /dev/null -w '%{http_code}' "http://${DEPLOYER_HOST}:3080/api/applications" 2>/dev/null | grep -qE '^(2|3)[0-9][0-9]$'; then
  SERVER="http://${DEPLOYER_HOST}:3080"
else
  echo "ERROR: Deployer not reachable at ${DEPLOYER_HOST}"
  exit 1
fi
echo "  Using ${SERVER}"

# --- Step 2: Find deployer VM ID ---
# These calls also need auth_curl post-OIDC.
echo ""
echo "=== Step 2: Find proxvex VM ID ==="

VE_KEY=$(auth_curl -sk "${SERVER}/api/ssh/config/${PVE_HOST}" 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" 2>/dev/null || echo "")

if [ -z "$VE_KEY" ]; then
  echo "ERROR: Could not resolve VE context"
  exit 1
fi

DEPLOYER_VMID=$(auth_curl -sk "${SERVER}/api/${VE_KEY}/installations" 2>/dev/null | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for ct in (data if isinstance(data, list) else data.get('installations', [])):
    if ct.get('application_id') == 'proxvex':
        print(ct.get('vm_id', ''))
        break
" 2>/dev/null || echo "")

if [ -z "$DEPLOYER_VMID" ]; then
  echo "ERROR: Could not find proxvex container"
  exit 1
fi
echo "  VM ID: ${DEPLOYER_VMID}"

# --- Step 3: Reconfigure with addon-oidc ---
echo ""
echo "=== Step 3: Reconfigure with addon-oidc ==="

PARAMS_FILE=$(mktemp)
cat > "$PARAMS_FILE" <<EOF
{
  "application": "proxvex",
  "task": "reconfigure",
  "params": [
    { "name": "previous_vm_id", "value": ${DEPLOYER_VMID} }
  ],
  "selectedAddons": ["addon-oidc", "addon-ssl"],
  "stackId": "oidc_production"
}
EOF

echo "  Running reconfigure with addon-oidc..."
NODE_TLS_REJECT_UNAUTHORIZED=0 $CLI remote \
  --server "$SERVER" \
  --ve "$PVE_HOST" \
  --insecure \
  --timeout 600 \
  "$PARAMS_FILE" || true

rm -f "$PARAMS_FILE"

# --- Step 4: Verify HTTPS + OIDC ---
echo ""
echo "=== Step 4: Verify deployer ==="

HTTPS_URL="https://${DEPLOYER_HOST}:3443"
for i in $(seq 1 24); do
  if curl -sk --connect-timeout 3 "${HTTPS_URL}/" >/dev/null 2>&1; then
    echo "  Deployer is up at ${HTTPS_URL}"
    break
  fi
  sleep 5
done

echo ""
echo "=== Setup complete ==="
echo "  proxvex: ${HTTPS_URL} (OIDC login via Zitadel)"
