#!/bin/bash
# Register a PVE host with the proxvex deployer.
#
# What it does:
#   1. Reads the deployer LXC's public SSH key (id_ed25519.pub or id_rsa.pub).
#   2. Appends it to root@<pve-host>:/root/.ssh/authorized_keys (idempotent).
#   3. POSTs the host to the deployer's /api/sshconfig so that VE-context
#      lookups (`ve_<host>`) succeed for subsequent deploy.sh calls.
#
# Usage:
#   ./setup-pve-host.sh <pve-host> [<ssh-port>]
#
# Env:
#   DEPLOYER_HOST      default: proxvex
#   DEPLOYER_PVE_HOST  PVE host that hosts the deployer LXC (used to read the
#                      deployer's SSH pubkey via `ssh root@<host> pct exec`
#                      when this script runs from a control machine that
#                      cannot reach the deployer LXC directly).
#                      Default: same as $1 (target PVE host) — works when the
#                      deployer is on the very host being registered.
#
# Idempotent: re-running on a host that's already set up is a no-op.

set -e

PVE_HOST="${1:?usage: $0 <pve-host> [ssh-port]}"
SSH_PORT="${2:-22}"
DEPLOYER_HOST="${DEPLOYER_HOST:-proxvex}"
DEPLOYER_PVE_HOST="${DEPLOYER_PVE_HOST:-$PVE_HOST}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Shared helpers: auth_curl + init_admin_pat. /api/sshconfig, /api/sshconfigs
# and the CA download endpoint are OIDC-protected after Step 11. The PAT
# lives on the Zitadel LXC's bootstrap volume; init_admin_pat resolves the
# correct host (DEPLOYER_PVE_HOST hosts the deployer; Zitadel sits there too).
. "$SCRIPT_DIR/_lib.sh"
init_admin_pat "$DEPLOYER_PVE_HOST"

# Auto-detect deployer endpoint (HTTPS first, HTTP fallback)
if curl -sk --connect-timeout 3 "https://${DEPLOYER_HOST}:3443/api/applications" >/dev/null 2>&1; then
  DEPLOYER_URL="https://${DEPLOYER_HOST}:3443"
elif curl -sf --connect-timeout 3 "http://${DEPLOYER_HOST}:3080/api/applications" >/dev/null 2>&1; then
  DEPLOYER_URL="http://${DEPLOYER_HOST}:3080"
else
  echo "ERROR: deployer not reachable at ${DEPLOYER_HOST}:3080 or :3443" >&2
  exit 1
fi
echo "  Deployer:  $DEPLOYER_URL"
echo "  PVE host:  $PVE_HOST (port $SSH_PORT)"

# Step 1: Find the deployer container so we can read its SSH key.
#   Three attempt paths in order:
#     1. Local `pct list` (this script runs on the deployer's PVE host).
#     2. `ssh root@$DEPLOYER_PVE_HOST pct exec` (this script runs on a control
#        machine — Mac/laptop — but can SSH to the PVE host that owns the
#        deployer LXC). This is the typical setup-production.sh path.
#     3. `ssh root@$DEPLOYER_HOST` directly (control machine has direct SSH
#        access to the deployer LXC — works in dev but not in default prod).
DEPLOYER_PUBKEY=""
# install-proxvex.sh stores the deployer's SSH keypair under
# `${secure_volume_path}/.ssh` (= /secure/.ssh inside the container, see
# install-proxvex.sh:860). /root/.ssh stays as fallback for manually-keyed
# deployers and as last resort.
PUBKEY_CMD='cat /secure/.ssh/id_ed25519.pub 2>/dev/null \
    || cat /root/.ssh/id_ed25519.pub 2>/dev/null \
    || cat /root/.ssh/id_rsa.pub 2>/dev/null'

# Pick the FIRST running LXC matching $DEPLOYER_HOST. There can be multiple
# entries (stale stopped clones, abandoned migration stubs) — only the
# running one is the live deployer. `awk … exit` ensures a single VMID.
PCT_PICK_VMID="awk -v h='${DEPLOYER_HOST}' '\$2==\"running\" && \$NF==h{print \$1; exit}'"

if command -v pct >/dev/null 2>&1; then
  DEPLOYER_VMID=$(pct list 2>/dev/null | eval "$PCT_PICK_VMID")
  if [ -n "$DEPLOYER_VMID" ]; then
    DEPLOYER_PUBKEY=$(pct exec "$DEPLOYER_VMID" -- sh -c "$PUBKEY_CMD")
  fi
fi
if [ -z "$DEPLOYER_PUBKEY" ]; then
  DEPLOYER_VMID=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${DEPLOYER_PVE_HOST}" \
    "pct list 2>/dev/null | $PCT_PICK_VMID" 2>/dev/null || true)
  if [ -n "$DEPLOYER_VMID" ]; then
    DEPLOYER_PUBKEY=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${DEPLOYER_PVE_HOST}" \
      "pct exec ${DEPLOYER_VMID} -- sh -c \"${PUBKEY_CMD}\"" 2>/dev/null || true)
  fi
fi
if [ -z "$DEPLOYER_PUBKEY" ]; then
  DEPLOYER_PUBKEY=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${DEPLOYER_HOST}" \
    "$PUBKEY_CMD" 2>/dev/null || true)
fi
if [ -z "$DEPLOYER_PUBKEY" ]; then
  echo "ERROR: could not read deployer's SSH public key" >&2
  echo "  Tried:" >&2
  echo "    1. local pct exec" >&2
  echo "    2. ssh root@${DEPLOYER_PVE_HOST} 'pct exec <deployer-vmid>'" >&2
  echo "    3. ssh root@${DEPLOYER_HOST}" >&2
  echo "  Hints:" >&2
  echo "    - Set DEPLOYER_PVE_HOST=<host> if the deployer LXC lives on a" >&2
  echo "      different PVE host than ${PVE_HOST}." >&2
  echo "    - Verify: ssh root@${DEPLOYER_PVE_HOST} 'pct list | grep ${DEPLOYER_HOST}'" >&2
  exit 1
fi
echo "  Deployer pubkey: $(echo "$DEPLOYER_PUBKEY" | awk '{print $1, substr($2,1,16)"…"}')"

# Step 2: Install pubkey on the target PVE host (idempotent — skip if present).
echo "  Installing deployer pubkey on ${PVE_HOST}..."
ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" "root@${PVE_HOST}" \
  "mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
   grep -qF '$DEPLOYER_PUBKEY' /root/.ssh/authorized_keys 2>/dev/null && echo '  already present' || \
   { echo '$DEPLOYER_PUBKEY' >> /root/.ssh/authorized_keys && \
     chmod 600 /root/.ssh/authorized_keys && \
     echo '  added'; }" || {
  echo "ERROR: failed to install pubkey on ${PVE_HOST}" >&2
  exit 1
}

# Step 3: Register the PVE host in the deployer's SSH config.
# auth_curl injects the Zitadel admin PAT as Bearer when set (post-OIDC).
echo "  Registering ${PVE_HOST} in deployer..."
http_code=$(auth_curl -sk --max-time 10 -X POST "${DEPLOYER_URL}/api/sshconfig" \
  -H "Content-Type: application/json" \
  -d "{\"host\":\"${PVE_HOST}\",\"port\":${SSH_PORT}}" \
  -o /tmp/sshconfig-resp.json -w '%{http_code}' 2>/dev/null || echo "000")
if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
  echo "ERROR: POST /api/sshconfig failed — HTTP $http_code" >&2
  cat /tmp/sshconfig-resp.json 2>/dev/null >&2
  echo "" >&2
  exit 1
fi
echo "  Registered (HTTP $http_code)"

# Step 4: Verify by reading it back via /api/sshconfigs.
if auth_curl -sk --max-time 10 "${DEPLOYER_URL}/api/sshconfigs" 2>/dev/null \
   | grep -q "\"host\":\"${PVE_HOST}\""; then
  echo "  Verified: ${PVE_HOST} known to deployer"
else
  echo "WARN: ${PVE_HOST} not visible in /api/sshconfigs after POST" >&2
fi

# Step 5: Install the deployer CA in the target PVE host's system trust store.
#   Idempotent: only writes when the cert content changes.
#   Once installed, all TLS clients on that host (skopeo, curl, …) trust the
#   deployer CA. The cert is also pushed into each newly-created LXC container
#   by template 108-host-push-ca-to-container so Docker daemons inside also
#   pick it up via the system-trust fallback.
echo "  Installing deployer CA on ${PVE_HOST}..."
CA_TMP=$(mktemp)
trap 'rm -f "$CA_TMP"' EXIT
CA_DOWNLOAD_URL="${DEPLOYER_URL}/api/ve_${PVE_HOST}/ve/certificates/ca/download"
if auth_curl -fsSL -k --max-time 10 -o "$CA_TMP" "$CA_DOWNLOAD_URL" && [ -s "$CA_TMP" ]; then
  CA_B64=$(base64 < "$CA_TMP" | tr -d '\n')
  ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" "root@${PVE_HOST}" \
    "CA_TARGET=/usr/local/share/ca-certificates/proxvex-ca.crt; \
     mkdir -p /usr/local/share/ca-certificates; \
     CA_TMP=\$(mktemp); \
     printf '%s' '${CA_B64}' | base64 -d > \"\$CA_TMP\"; \
     if [ -f \"\$CA_TARGET\" ] && cmp -s \"\$CA_TMP\" \"\$CA_TARGET\"; then \
       echo '  CA unchanged'; rm -f \"\$CA_TMP\"; \
     else \
       mv \"\$CA_TMP\" \"\$CA_TARGET\" && update-ca-certificates >/dev/null 2>&1 && echo '  CA installed'; \
     fi" || echo "WARN: failed to install CA on ${PVE_HOST}" >&2
else
  echo "WARN: could not download CA from ${CA_DOWNLOAD_URL} — skipping CA install" >&2
fi

echo "  Done."
