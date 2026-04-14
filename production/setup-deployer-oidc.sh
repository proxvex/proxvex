#!/bin/bash
# Reconfigure oci-lxc-deployer to enable OIDC authentication.
# This also activates native HTTPS (port 3443).
#
# Prerequisites:
#   - oci-lxc-deployer is running (HTTP on port 3080)
#   - Zitadel is deployed (auto-creates deployer OIDC credentials)
#
# Usage:
#   ./production/setup-deployer-oidc.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PVE_HOST="${PVE_HOST:-pve1.cluster}"
DEPLOYER_HOST="${DEPLOYER_HOST:-oci-lxc-deployer}"
CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

# --- Step 1: Detect deployer API (HTTP or HTTPS) ---
echo "=== Step 1: Detect deployer API ==="

if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/applications" >/dev/null 2>&1; then
  SERVER="https://${DEPLOYER_HOST}:3443"
elif curl -sf --connect-timeout 3 "http://${DEPLOYER_HOST}:3080/api/applications" >/dev/null 2>&1; then
  SERVER="http://${DEPLOYER_HOST}:3080"
else
  echo "ERROR: Deployer not reachable at ${DEPLOYER_HOST}"
  exit 1
fi
echo "  Using ${SERVER}"

# --- Step 2: Find deployer VM ID ---
echo ""
echo "=== Step 2: Find oci-lxc-deployer VM ID ==="

VE_KEY=$(curl -sk "${SERVER}/api/ssh/config/${PVE_HOST}" 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" 2>/dev/null || echo "")

if [ -z "$VE_KEY" ]; then
  echo "ERROR: Could not resolve VE context"
  exit 1
fi

DEPLOYER_VMID=$(curl -sk "${SERVER}/api/${VE_KEY}/installations" 2>/dev/null | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for ct in (data if isinstance(data, list) else data.get('installations', [])):
    if ct.get('application_id') == 'oci-lxc-deployer':
        print(ct.get('vm_id', ''))
        break
" 2>/dev/null || echo "")

if [ -z "$DEPLOYER_VMID" ]; then
  echo "ERROR: Could not find oci-lxc-deployer container"
  exit 1
fi
echo "  VM ID: ${DEPLOYER_VMID}"

# --- Step 3: Reconfigure with addon-oidc ---
echo ""
echo "=== Step 3: Reconfigure with addon-oidc ==="

PARAMS_FILE=$(mktemp)
cat > "$PARAMS_FILE" <<EOF
{
  "application": "oci-lxc-deployer",
  "task": "reconfigure",
  "params": [
    { "name": "previouse_vm_id", "value": ${DEPLOYER_VMID} }
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
echo "  oci-lxc-deployer: ${HTTPS_URL} (OIDC login via Zitadel)"
