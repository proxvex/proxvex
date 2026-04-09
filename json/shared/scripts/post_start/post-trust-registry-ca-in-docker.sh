#!/bin/sh
# Install deployer CA certificate for Docker to trust a local registry mirror.
#
# Docker looks for CA certs in /etc/docker/certs.d/<registry>/ca.crt.
# This script downloads the deployer CA and installs it for registry-1.docker.io.
#
# Skipped if no deployer CA is available (no registry mirror configured).

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"
REGISTRY_HOST="registry-1.docker.io"
CERT_DIR="/etc/docker/certs.d/${REGISTRY_HOST}"

[ "$DEPLOYER_URL" = "NOT_DEFINED" ] && DEPLOYER_URL=""
[ "$VE_CONTEXT" = "NOT_DEFINED" ] && VE_CONTEXT=""

if [ -z "$DEPLOYER_URL" ] || [ -z "$VE_CONTEXT" ]; then
  echo "No deployer URL available, skipping CA trust setup" >&2
  echo '[]'
  exit 0
fi

# Check if registry-1.docker.io resolves to a local address
# If it resolves to the real Docker Hub, there's no local mirror
RESOLVED_IP=$(nslookup "$REGISTRY_HOST" 2>/dev/null | awk '/^Address:/ && !/127\.0\.0\.53/ && !/::1/ {print $2}' | tail -1)
if [ -z "$RESOLVED_IP" ]; then
  echo "Cannot resolve ${REGISTRY_HOST}, skipping CA trust" >&2
  echo '[]'
  exit 0
fi

# Check if the resolved IP is a private/local address
case "$RESOLVED_IP" in
  10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*)
    echo "Local registry mirror detected at ${RESOLVED_IP}" >&2
    ;;
  *)
    echo "${REGISTRY_HOST} resolves to ${RESOLVED_IP} (not local), skipping CA trust" >&2
    echo '[]'
    exit 0
    ;;
esac

# Download CA certificate from deployer
CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"
echo "Downloading CA certificate from deployer..." >&2

if ! command -v curl > /dev/null 2>&1; then
  apk add --no-cache curl >&2 2>&1 || apt-get install -y -qq curl >&2 2>&1
fi

mkdir -p "$CERT_DIR"
if curl -fsSL -k -o "${CERT_DIR}/ca.crt" "$CA_URL" 2>/dev/null; then
  echo "CA certificate installed at ${CERT_DIR}/ca.crt" >&2
else
  echo "Warning: Could not download CA certificate from ${CA_URL}" >&2
fi

echo '[]'
