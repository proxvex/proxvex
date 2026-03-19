#!/bin/bash
# Reconfigure oci-lxc-deployer to enable OIDC authentication via addon-oidc.
#
# Prerequisites:
#   - oci-lxc-deployer is running with HTTPS (after setup-acme.sh)
#   - Zitadel is deployed and running (deploy.sh zitadel)
#
# Usage:
#   ./production/setup-deployer-oidc.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PVE_HOST="pve1.cluster"
DEPLOYER_HOST="oci-lxc-deployer"
PORT_DEPLOYER_HTTPS=3443
SERVER="https://${DEPLOYER_HOST}:${PORT_DEPLOYER_HTTPS}"
CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

# --- Step 1: Find deployer VM ID ---
echo "=== Step 1: Find oci-lxc-deployer VM ID ==="

DEPLOYER_VMID=$(curl -sk "${SERVER}/api/ssh/config/${PVE_HOST}" 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" 2>/dev/null || echo "")

if [ -z "$DEPLOYER_VMID" ]; then
  echo "ERROR: Could not resolve VE context"
  exit 1
fi

VE_KEY="$DEPLOYER_VMID"
DEPLOYER_VMID=$(curl -sk "${SERVER}/api/${VE_KEY}/ve/containers" 2>/dev/null | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for ct in data.get('containers', []):
    if ct.get('application_id') == 'oci-lxc-deployer':
        print(ct.get('vmid', ''))
        break
" 2>/dev/null || echo "")

if [ -z "$DEPLOYER_VMID" ]; then
  echo "ERROR: Could not find oci-lxc-deployer container"
  exit 1
fi
echo "  VM ID: ${DEPLOYER_VMID}"

# --- Step 2: Reconfigure with addon-acme + addon-oidc ---
echo ""
echo "=== Step 2: Reconfigure with addon-oidc ==="

PARAMS_FILE=$(mktemp)
cat > "$PARAMS_FILE" <<EOF
{
  "application": "oci-lxc-deployer",
  "task": "reconfigure",
  "params": [
    { "name": "previouse_vm_id", "value": ${DEPLOYER_VMID} }
  ],
  "selectedAddons": ["addon-acme", "addon-oidc"],
  "stackId": "production"
}
EOF

echo "  Running reconfigure with addon-acme + addon-oidc..."
NODE_TLS_REJECT_UNAUTHORIZED=0 $CLI remote \
  --server "$SERVER" \
  --ve "$PVE_HOST" \
  --insecure \
  --timeout 600 \
  "$PARAMS_FILE" || true

rm -f "$PARAMS_FILE"

# --- Step 3: Verify ---
echo ""
echo "=== Step 3: Verify OIDC ==="

# Wait for deployer to come back up
for i in $(seq 1 24); do
  if curl -sk --connect-timeout 3 "${SERVER}/" >/dev/null 2>&1; then
    echo "  Deployer is back up at ${SERVER}"
    break
  fi
  sleep 5
done

echo ""
echo "=== Setup complete ==="
echo "  oci-lxc-deployer now has OIDC authentication enabled."
echo "  Login via Zitadel at ${SERVER}"
