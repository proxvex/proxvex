#!/bin/bash
# Reconfigure oci-lxc-deployer with addon-acme (Let's Encrypt).
# After this, the deployer runs on HTTPS (port 3443).
#
# Prerequisites:
#   - oci-lxc-deployer is running (HTTP on port 3080)
#   - Production stack with Cloudflare credentials exists (setup-acme.sh)
#
# Usage:
#   ./production/setup-deployer-acme.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Configuration ---
PVE_HOST="pve1.cluster"
DEPLOYER_HOST="oci-lxc-deployer"
DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-.ohnewarum.de}"
DEPLOYER_API="http://${DEPLOYER_HOST}:3080"

CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

# --- Step 1: Wait for deployer API ---
echo "=== Step 1: Waiting for deployer API at ${DEPLOYER_API} ==="
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  if curl -sf "${DEPLOYER_API}/api/applications" >/dev/null 2>&1; then
    echo "  Deployer API is ready."
    break
  fi
  RETRIES=$((RETRIES - 1))
  echo "  Not ready, retrying... ($RETRIES left)"
  sleep 2
done
if [ $RETRIES -eq 0 ]; then
  echo "ERROR: Deployer API did not become ready at $DEPLOYER_API"
  exit 1
fi

# --- Step 2: Resolve VE context ---
echo ""
echo "=== Step 2: Resolve VE context ==="

ve_key=$(curl -sf "${DEPLOYER_API}/api/ssh/config/${PVE_HOST}" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" 2>/dev/null || echo "")

if [ -z "$ve_key" ]; then
  echo "ERROR: Could not resolve VE context for '${PVE_HOST}'"
  exit 1
fi
echo "  VE context: ${ve_key}"

# --- Step 3: Find deployer VM ID ---
echo ""
echo "=== Step 3: Find deployer VM ID ==="

DEPLOYER_VMID=$(curl -sf "${DEPLOYER_API}/api/${ve_key}/ve/containers" 2>/dev/null | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for ct in data.get('containers', []):
    if ct.get('application_id') == 'oci-lxc-deployer':
        print(ct.get('vmid', ''))
        break
" 2>/dev/null || echo "")

if [ -z "$DEPLOYER_VMID" ]; then
  echo "ERROR: Could not find oci-lxc-deployer container VM ID"
  exit 1
fi
echo "  Deployer VM ID: ${DEPLOYER_VMID}"

# --- Step 4: Reconfigure with ACME ---
echo ""
echo "=== Step 4: Reconfigure oci-lxc-deployer with ACME ==="

ACME_SAN="${DEPLOYER_HOST}${DOMAIN_SUFFIX}"
cat > /tmp/deployer-acme-params.json <<EOF
{
  "application": "oci-lxc-deployer",
  "task": "reconfigure",
  "params": [
    { "name": "previouse_vm_id", "value": ${DEPLOYER_VMID} },
    { "name": "acme_san", "value": "${ACME_SAN}" }
  ],
  "selectedAddons": ["addon-acme"],
  "stackId": "production"
}
EOF

echo "  ACME SAN: ${ACME_SAN}"
echo "  Running reconfigure via oci-lxc-cli..."

https_done=""
NODE_TLS_REJECT_UNAUTHORIZED=0 $CLI remote \
  --server "${DEPLOYER_API}" \
  --ve "${PVE_HOST}" \
  --insecure \
  --timeout 600 \
  /tmp/deployer-acme-params.json \
  && https_done="true" || true

# Check if HTTPS came up (container may have been replaced)
if [ "$https_done" != "true" ]; then
  echo "  CLI exited, checking HTTPS..."
  container_ip=$(getent hosts "$DEPLOYER_HOST" 2>/dev/null | awk '{print $1; exit}' || echo "$DEPLOYER_HOST")
  for i in $(seq 1 24); do
    if curl -sk --connect-timeout 3 "https://${container_ip}:3443/" >/dev/null 2>&1; then
      https_done="true"
      break
    fi
    sleep 5
  done
fi

rm -f /tmp/deployer-acme-params.json

echo ""
if [ "$https_done" = "true" ]; then
  echo "=== ACME setup complete ==="
  echo "  oci-lxc-deployer is now available at https://${DEPLOYER_HOST}:3443"
else
  echo "=== WARNING: HTTPS did not come up within 120s ==="
  echo "  Check container logs for ACME certificate errors."
fi
