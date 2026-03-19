#!/bin/bash
# Enable ACME (Let's Encrypt) on the oci-lxc-deployer container.
#
# Prerequisites:
#   - oci-lxc-deployer is installed and running (HTTP on port 3080)
#   - Cloudflare API token and Zone ID are available
#
# Usage:
#   CF_TOKEN=xxx CF_ZONE_ID=yyy ./production/setup-acme.sh
#
# What this script does:
#   1. Waits for the deployer API to be ready
#   2. Generates CA certificate (needed for self-signed certs on postgres etc.)
#   3. Sets the domain suffix
#   4. Creates the production stack with cloudflare stacktype + credentials
#   5. Reconfigures oci-lxc-deployer with addon-acme → HTTPS on port 3443

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Configuration ---
PVE_HOST="pve1.cluster"
DEPLOYER_HOST="oci-lxc-deployer"
DEPLOYER_VMID=300
DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-.ohnewarum.de}"
DEPLOYER_API="http://${DEPLOYER_HOST}:3080"

# --- Cloudflare credentials ---
CF_TOKEN="${CF_TOKEN:-}"
CF_ZONE_ID="${CF_ZONE_ID:-}"

if [ -z "$CF_TOKEN" ] || [ -z "$CF_ZONE_ID" ]; then
  echo "ERROR: CF_TOKEN and CF_ZONE_ID must be set."
  echo "Usage: CF_TOKEN=xxx CF_ZONE_ID=yyy $0"
  echo ""
  echo "Get these from https://dash.cloudflare.com:"
  echo "  CF_TOKEN:   API Token with Zone:DNS:Edit permission"
  echo "  CF_ZONE_ID: Domain → Overview → Zone ID (right sidebar)"
  exit 1
fi

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

# --- Step 2: Resolve VE context and verify SSH ---
echo ""
echo "=== Step 2: Resolve VE context ==="

ve_key=$(curl -sf "${DEPLOYER_API}/api/ssh/config/${PVE_HOST}" | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" 2>/dev/null || echo "")

if [ -z "$ve_key" ]; then
  echo "ERROR: Could not resolve VE context for '${PVE_HOST}'"
  exit 1
fi
echo "  VE context: ${ve_key}"

# Verify SSH connection
echo "  Verifying SSH connection to PVE host..."
ssh_ok=""
for i in $(seq 1 5); do
  ssh_check=$(curl -s --max-time 5 \
    "${DEPLOYER_API}/api/ssh/check?host=${PVE_HOST}&port=22" 2>/dev/null || echo "")
  if printf '%s' "$ssh_check" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('permissionOk') else 1)" 2>/dev/null; then
    ssh_ok="true"
    break
  fi
  sleep 2
done

if [ "$ssh_ok" != "true" ]; then
  echo "ERROR: SSH connection to PVE host not ready"
  exit 1
fi
echo "  SSH connection verified."

# --- Step 3: Generate CA certificate and set domain suffix ---
echo ""
echo "=== Step 3: Generate CA certificate and set domain suffix ==="

ca_resp=$(curl -s -X POST "${DEPLOYER_API}/api/${ve_key}/ve/certificates/ca/generate" 2>/dev/null || echo "")
ca_msg=$(printf '%s' "$ca_resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('success'): print('generated')
else: print(d.get('error','already exists or failed'))
" 2>/dev/null || echo "see response")
echo "  CA certificate: ${ca_msg}"

suffix_resp=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"domain_suffix\":\"${DOMAIN_SUFFIX}\"}" \
  "${DEPLOYER_API}/api/${ve_key}/ve/certificates/domain-suffix" 2>/dev/null || echo "")
suffix_ok=$(printf '%s' "$suffix_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('success') else 'false')" 2>/dev/null || echo "false")
if [ "$suffix_ok" = "true" ]; then
  echo "  Domain suffix set to ${DOMAIN_SUFFIX}"
else
  echo "  Domain suffix: $(printf '%s' "$suffix_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','failed'))" 2>/dev/null || echo "see response")"
fi

# --- Step 4: Create production stack with cloudflare ---
echo ""
echo "=== Step 4: Create production stack with cloudflare credentials ==="

# Delete existing stack first (POST overwrites, but we want clean state)
curl -sk -X DELETE "${DEPLOYER_API}/api/stack/production" -o /dev/null 2>/dev/null || true

# Escape CF_TOKEN for JSON (handle special characters)
CF_TOKEN_ESCAPED=$(printf '%s' "$CF_TOKEN" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])")
CF_ZONE_ID_ESCAPED=$(printf '%s' "$CF_ZONE_ID" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])")

STACK_RESP=$(curl -s -X POST "${DEPLOYER_API}/api/stacks" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"production\",
    \"stacktype\": [\"postgres\", \"oidc\", \"cloudflare\"],
    \"entries\": [
      {\"name\": \"CF_TOKEN\", \"value\": \"${CF_TOKEN_ESCAPED}\"},
      {\"name\": \"CF_ZONE_ID\", \"value\": \"${CF_ZONE_ID_ESCAPED}\"}
    ]
  }" 2>/dev/null)

stack_ok=$(printf '%s' "$STACK_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('success') else 'false')" 2>/dev/null || echo "false")
if [ "$stack_ok" = "true" ]; then
  echo "  Production stack created with cloudflare credentials."
else
  echo "  ERROR: Failed to create production stack"
  echo "  Response: $STACK_RESP"
  exit 1
fi

# --- Step 5: Reconfigure deployer with ACME ---
echo ""
echo "=== Step 5: Reconfigure oci-lxc-deployer with ACME ==="

# Find the deployer VM ID
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

# Build reconfigure parameters
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

PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="npx tsx $PROJECT_ROOT/cli/src/oci-lxc-cli.mts"

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
