#!/bin/bash
# Set up ACME prerequisites: production stack with Cloudflare credentials,
# CA certificate, and domain suffix.
#
# The deployer itself is NOT reconfigured to HTTPS here — that happens later
# (after nginx is deployed and public access is verified).
#
# Prerequisites:
#   - oci-lxc-deployer is installed and running (HTTP on port 3080)
#   - Cloudflare API token with Zone:DNS:Edit permission for all relevant domains
#
# Usage:
#   CF_TOKEN=xxx ./production/setup-acme.sh
#
# What this script does:
#   1. Waits for the deployer API to be ready
#   2. Resolves VE context and verifies SSH
#   3. Generates CA certificate and sets domain suffix
#   4. Creates the production stack with cloudflare stacktype + credentials

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

if [ -z "$CF_TOKEN" ]; then
  echo "ERROR: CF_TOKEN must be set."
  echo "Usage: CF_TOKEN=xxx $0"
  echo ""
  echo "Create at https://dash.cloudflare.com/profile/api-tokens"
  echo "  CF_TOKEN: API Token with Zone:DNS:Edit permission for all relevant domains"
  echo "  (acme.sh dns_cf resolves zones automatically — no Zone ID needed)"
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
echo "=== Step 4: Create production stack with Cloudflare credentials ==="

# Delete existing stack first (POST overwrites, but we want clean state)
curl -sk -X DELETE "${DEPLOYER_API}/api/stack/production" -o /dev/null 2>/dev/null || true

# Escape CF_TOKEN for JSON (handle special characters)
CF_TOKEN_ESCAPED=$(printf '%s' "$CF_TOKEN" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])")

STACK_RESP=$(curl -s -X POST "${DEPLOYER_API}/api/stacks" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"production\",
    \"stacktype\": [\"postgres\", \"oidc\", \"cloudflare\"],
    \"entries\": [
      {\"name\": \"CF_TOKEN\", \"value\": \"${CF_TOKEN_ESCAPED}\"}
    ]
  }" 2>/dev/null)

stack_ok=$(printf '%s' "$STACK_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('success') else 'false')" 2>/dev/null || echo "false")
if [ "$stack_ok" = "true" ]; then
  echo "  Production stack created with Cloudflare credentials."
else
  echo "  ERROR: Failed to create production stack"
  echo "  Response: $STACK_RESP"
  exit 1
fi

echo ""
echo "=== ACME setup complete ==="
echo "  Production stack with Cloudflare credentials is ready."
echo "  CA certificate generated, domain suffix set to ${DOMAIN_SUFFIX}"
echo ""
echo "  Next: deploy nginx with addon-acme to verify public access."
echo "  The deployer itself stays on HTTP for now — reconfigure it later."
