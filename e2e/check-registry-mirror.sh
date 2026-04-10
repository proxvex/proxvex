#!/bin/sh
# Standalone check script for Docker Registry Mirror on PVE host.
#
# Usage:
#   ./check-registry-mirror.sh <deployer-url> <ve-context>
#
# Example:
#   ./check-registry-mirror.sh http://oci-lxc-deployer:3080 ve_pve1.cluster

set -e

DEPLOYER_URL="${1:-}"
VE_CONTEXT="${2:-}"
MIRROR_HOST="docker-registry-mirror"
CA_CERT="/usr/local/share/ca-certificates/oci-lxc-deployer-ca.crt"

if [ -z "$DEPLOYER_URL" ] || [ -z "$VE_CONTEXT" ]; then
  echo "Usage: $0 <deployer-url> <ve-context>" >&2
  echo "Example: $0 http://oci-lxc-deployer:3080 ve_pve1.cluster" >&2
  exit 1
fi

echo "=== Docker Registry Mirror Check ===" >&2
ERRORS=""
add_error() { ERRORS="${ERRORS}${ERRORS:+\n}$1"; }

# 1. DNS: docker-registry-mirror must be reachable
echo "[1/4] Checking DNS for ${MIRROR_HOST}..." >&2
MIRROR_IP=$(nslookup "$MIRROR_HOST" 2>/dev/null | awk '/^Address:/ && !/127\.0\.0\.53/ && !/::1/ {print $2}' | tail -1)
if [ -z "$MIRROR_IP" ]; then
  add_error "DNS: Cannot resolve ${MIRROR_HOST}"
  echo "  FAIL" >&2
else
  echo "  OK: ${MIRROR_HOST} -> ${MIRROR_IP}" >&2
fi

# 2. /etc/hosts: registry-1.docker.io + index.docker.io -> mirror IP
echo "[2/4] Setting /etc/hosts entries..." >&2
MARKER="# oci-lxc-deployer: registry mirror"
if [ -n "$MIRROR_IP" ]; then
  if grep -q "$MARKER" /etc/hosts 2>/dev/null; then
    echo "  OK: Already configured" >&2
  else
    echo "${MIRROR_IP} registry-1.docker.io index.docker.io  ${MARKER}" >> /etc/hosts
    echo "  OK: Added ${MIRROR_IP} -> registry-1.docker.io, index.docker.io" >&2
  fi
else
  echo "  SKIP: No mirror IP" >&2
fi

# 3. CA certificate
echo "[3/4] Checking CA certificate..." >&2
if [ -f "$CA_CERT" ]; then
  echo "  OK: Already installed" >&2
else
  CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"
  if curl -fsSL -k -o "$CA_CERT" "$CA_URL" 2>/dev/null; then
    update-ca-certificates >/dev/null 2>&1
    echo "  OK: Installed from ${CA_URL}" >&2
  else
    add_error "CA: Could not download from ${CA_URL}"
    echo "  FAIL" >&2
  fi
fi

# 4. Skopeo inspect through mirror
echo "[4/4] Testing skopeo inspect..." >&2
if command -v skopeo >/dev/null 2>&1; then
  INSPECT_RESULT=$(skopeo inspect "docker://registry-1.docker.io/library/alpine:latest" 2>&1)
  if echo "$INSPECT_RESULT" | grep -q '"Digest"'; then
    echo "  OK: alpine:latest inspected through mirror" >&2
  else
    add_error "Skopeo: $(echo "$INSPECT_RESULT" | head -2)"
    echo "  FAIL" >&2
  fi
else
  echo "  SKIP: skopeo not installed" >&2
fi

echo "" >&2
if [ -n "$ERRORS" ]; then
  printf "=== FAILED ===\n%b\n" "$ERRORS" >&2
  exit 1
fi
echo "=== PASSED ===" >&2
