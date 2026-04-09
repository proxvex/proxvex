#!/bin/sh
# Standalone check script for Docker Registry Mirror on PVE host.
#
# Usage:
#   ./check-registry-mirror.sh <deployer-hostname> <ve-context>
#
# Example:
#   ./check-registry-mirror.sh oci-lxc-deployer ve_pve1
#   ./check-registry-mirror.sh oci-lxc-deployer.local ve_pve1.cluster
#
# The script:
# 1. Checks DNS resolves registry-1.docker.io to a local IP
# 2. Downloads and installs the deployer CA certificate
# 3. Tests skopeo inspect through the mirror

set -e

DEPLOYER_HOST="${1:-oci-lxc-deployer}"
VE_CONTEXT="${2:-}"
DEPLOYER_PORT="${3:-3080}"
REGISTRY_HOST="registry-1.docker.io"
CA_CERT="/usr/local/share/ca-certificates/oci-lxc-deployer-ca.crt"

if [ -z "$VE_CONTEXT" ]; then
  echo "Usage: $0 <deployer-hostname> <ve-context> [deployer-port]" >&2
  echo "Example: $0 oci-lxc-deployer ve_pve1.cluster" >&2
  exit 1
fi

DEPLOYER_URL="http://${DEPLOYER_HOST}:${DEPLOYER_PORT}"
echo "=== Docker Registry Mirror Check ===" >&2
echo "Deployer: ${DEPLOYER_URL}" >&2
echo "VE Context: ${VE_CONTEXT}" >&2
echo "Registry: ${REGISTRY_HOST}" >&2
echo "" >&2

ERRORS=""
add_error() { ERRORS="${ERRORS}${ERRORS:+\n}$1"; }

# 1. DNS check
echo "[1/3] Checking DNS for ${REGISTRY_HOST}..." >&2
RESOLVED_IP=$(nslookup "$REGISTRY_HOST" 2>/dev/null | awk '/^Address:/ && !/127\.0\.0\.53/ && !/::1/ {print $2}' | tail -1)
if [ -z "$RESOLVED_IP" ]; then
  add_error "DNS: Cannot resolve ${REGISTRY_HOST}"
  echo "  FAIL: Cannot resolve ${REGISTRY_HOST}" >&2
else
  case "$RESOLVED_IP" in
    10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*)
      echo "  OK: ${REGISTRY_HOST} -> ${RESOLVED_IP} (local)" >&2
      ;;
    *)
      add_error "DNS: ${REGISTRY_HOST} resolves to ${RESOLVED_IP} (expected local address)"
      echo "  FAIL: ${REGISTRY_HOST} -> ${RESOLVED_IP} (not local!)" >&2
      ;;
  esac
fi

# 2. CA certificate
echo "[2/3] Checking CA certificate..." >&2
if [ -f "$CA_CERT" ]; then
  echo "  OK: CA certificate already installed at ${CA_CERT}" >&2
else
  CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"
  echo "  Downloading from ${CA_URL}..." >&2
  if curl -fsSL -k -o "$CA_CERT" "$CA_URL" 2>/dev/null; then
    update-ca-certificates >/dev/null 2>&1
    echo "  OK: CA certificate installed" >&2
  else
    add_error "CA: Could not download from ${CA_URL}"
    echo "  FAIL: Could not download CA certificate" >&2
  fi
fi

# 3. Skopeo inspect
echo "[3/3] Testing skopeo inspect through mirror..." >&2
if command -v skopeo >/dev/null 2>&1; then
  INSPECT_RESULT=$(skopeo inspect "docker://${REGISTRY_HOST}/library/alpine:latest" 2>&1)
  if echo "$INSPECT_RESULT" | grep -q '"Digest"'; then
    DIGEST=$(echo "$INSPECT_RESULT" | grep '"Digest"' | head -1 | sed 's/.*"Digest": *"//' | sed 's/".*//')
    echo "  OK: alpine:latest inspected (${DIGEST})" >&2
  else
    add_error "Skopeo: Failed to inspect alpine:latest: $(echo "$INSPECT_RESULT" | head -2)"
    echo "  FAIL: $(echo "$INSPECT_RESULT" | head -2)" >&2
  fi
else
  echo "  SKIP: skopeo not installed" >&2
fi

# Result
echo "" >&2
if [ -n "$ERRORS" ]; then
  printf "=== FAILED ===\n%b\n" "$ERRORS" >&2
  exit 1
fi

echo "=== PASSED ===" >&2
