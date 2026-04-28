#!/bin/bash
# Set up production stack: Cloudflare credentials and domain suffix.
# ACME is only used for the nginx wildcard certificate.
#
# Prerequisites:
#   - proxvex is installed and running (HTTPS on port 3443 or HTTP on port 3080)
#   - Cloudflare API token with Zone:DNS:Edit permission for all relevant domains
#
# Usage:
#   CF_TOKEN=xxx ./production/setup-acme.sh
#
# What this script does:
#   1. Waits for the deployer API to be ready
#   2. Resolves VE context and verifies SSH
#   3. Sets domain suffix
#   4. Creates the production stack with cloudflare stacktype + credentials

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Configuration ---
PVE_HOST="pve1.cluster"
DEPLOYER_HOST="${DEPLOYER_HOST:-proxvex}"
DOMAIN_SUFFIX="${DOMAIN_SUFFIX:-.ohnewarum.de}"
# Auto-detect: HTTPS (port 3443) or HTTP (port 3080)
if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/applications" >/dev/null 2>&1; then
  DEPLOYER_API="https://${DEPLOYER_HOST}:3443"
else
  DEPLOYER_API="http://${DEPLOYER_HOST}:3080"
fi

# --- External credentials ---
CF_TOKEN="${CF_TOKEN:-}"
SMTP_PASSWORD="${SMTP_PASSWORD:-}"
# Optional: when set, an additional dockermr stack is provisioned with this
# Docker Hub PAT so the registry mirror can do authenticated pull-through
# (200 pulls / 6h instead of the 100/6h anonymous limit). Skipped silently
# when unset — the mirror then runs anonymously.
DOCKER_HUB_PASSWORD="${DOCKER_HUB_PASSWORD:-}"

if [ -z "$CF_TOKEN" ]; then
  echo "ERROR: CF_TOKEN must be set."
  echo "Usage: CF_TOKEN=xxx SMTP_PASSWORD=yyy [DOCKER_HUB_PASSWORD=zzz] $0"
  echo ""
  echo "  CF_TOKEN:            Cloudflare API Token with Zone:DNS:Edit permission"
  echo "  SMTP_PASSWORD:       SMTP account password for Zitadel mail notifications"
  echo "  DOCKER_HUB_PASSWORD: (optional) Docker Hub PAT for authenticated pull-through"
  exit 1
fi

if [ -z "$SMTP_PASSWORD" ]; then
  echo "ERROR: SMTP_PASSWORD must be set."
  echo "Usage: CF_TOKEN=xxx SMTP_PASSWORD=yyy [DOCKER_HUB_PASSWORD=zzz] $0"
  exit 1
fi

# --- Step 1: Wait for deployer API ---
echo "=== Step 1: Waiting for deployer API at ${DEPLOYER_API} ==="
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  if curl -sk "${DEPLOYER_API}/api/applications" >/dev/null 2>&1; then
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

ve_key=$(curl -sk "${DEPLOYER_API}/api/ssh/config/${PVE_HOST}" | \
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
  ssh_check=$(curl -sk --max-time 5 \
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

# --- Step 3: Set domain suffix ---
echo ""
echo "=== Step 3: Set domain suffix ==="

suffix_resp=$(curl -sk -X POST -H "Content-Type: application/json" \
  -d "{\"domain_suffix\":\"${DOMAIN_SUFFIX}\"}" \
  "${DEPLOYER_API}/api/${ve_key}/ve/certificates/domain-suffix" 2>/dev/null || echo "")
suffix_ok=$(printf '%s' "$suffix_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('success') else 'false')" 2>/dev/null || echo "false")
if [ "$suffix_ok" = "true" ]; then
  echo "  Domain suffix set to ${DOMAIN_SUFFIX}"
else
  echo "  Domain suffix: $(printf '%s' "$suffix_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','failed'))" 2>/dev/null || echo "see response")"
fi

# --- Step 4: Create production stacks (one per stacktype) ---
echo ""
echo "=== Step 4: Create production stacks ==="

# Escape secrets for JSON (handle special characters)
CF_TOKEN_ESCAPED=$(printf '%s' "$CF_TOKEN" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])")
SMTP_PASSWORD_ESCAPED=$(printf '%s' "$SMTP_PASSWORD" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])")
if [ -n "$DOCKER_HUB_PASSWORD" ]; then
  DOCKER_HUB_PASSWORD_ESCAPED=$(printf '%s' "$DOCKER_HUB_PASSWORD" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])")
fi

# Idempotent: if {type}_production already exists, leave it untouched (do NOT
# overwrite stored secrets) and report. Only POST when the stack is missing.
ensure_stack_exists() {
  _type="$1"
  _entries="$2"
  _stack_id="${_type}_production"

  if curl -sk "${DEPLOYER_API}/api/stacks?stacktype=${_type}" 2>/dev/null \
       | grep -q "\"${_stack_id}\""; then
    echo "  Stack ${_stack_id} already exists — keeping stored values (no update)."
    return 0
  fi

  _resp=$(curl -sk -X POST "${DEPLOYER_API}/api/stacks" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"production\",\"stacktype\":\"${_type}\",\"entries\":${_entries}}" 2>/dev/null)
  _ok=$(printf '%s' "$_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('success') else 'false')" 2>/dev/null || echo "false")
  if [ "$_ok" = "true" ]; then
    echo "  Stack ${_stack_id} created."
  else
    echo "  ERROR: Failed to create ${_stack_id} stack"
    echo "  Response: $_resp"
    exit 1
  fi
}

# postgres_production — secrets auto-generated by backend
ensure_stack_exists "postgres" "[]"

# oidc_production — secrets auto-generated, SMTP_PASSWORD is external (user-provided)
ensure_stack_exists "oidc" "[{\"name\":\"SMTP_PASSWORD\",\"value\":\"${SMTP_PASSWORD_ESCAPED}\"}]"

# cloudflare_production — CF_TOKEN is user-provided (external)
ensure_stack_exists "cloudflare" "[{\"name\":\"CF_TOKEN\",\"value\":\"${CF_TOKEN_ESCAPED}\"}]"

# dockermr_production — DOCKER_HUB_PASSWORD is user-provided (external), optional.
# Skipped silently when DOCKER_HUB_PASSWORD is unset, so the registry mirror
# falls back to anonymous pulls (100/6h instead of 200/6h authenticated).
if [ -n "$DOCKER_HUB_PASSWORD" ]; then
  ensure_stack_exists "dockermr" "[{\"name\":\"DOCKER_HUB_PASSWORD\",\"value\":\"${DOCKER_HUB_PASSWORD_ESCAPED}\"}]"
else
  echo "  Skipping dockermr_production stack (DOCKER_HUB_PASSWORD not set — mirror runs anonymously)."
fi

echo ""
echo "=== Setup complete ==="
echo "  Production stacks created (postgres, oidc, cloudflare)."
echo "  Domain suffix set to ${DOMAIN_SUFFIX}"
echo ""
echo "  Next: deploy nginx with addon-acme (wildcard certificate)."
