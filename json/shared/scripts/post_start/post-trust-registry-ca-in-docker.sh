#!/bin/sh
# Install deployer CA certificate and /etc/hosts entries for Docker
# to trust and route to a local registry mirror (docker-registry-mirror).
#
# Docker looks for CA certs in /etc/docker/certs.d/<registry>/ca.crt.
# Skipped if no local mirror is detected.

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"
MIRROR_HOST="docker-registry-mirror"

[ "$DEPLOYER_URL" = "NOT_DEFINED" ] && DEPLOYER_URL=""
[ "$VE_CONTEXT" = "NOT_DEFINED" ] && VE_CONTEXT=""

if [ -z "$DEPLOYER_URL" ] || [ -z "$VE_CONTEXT" ]; then
  echo "No deployer URL available, skipping registry mirror setup" >&2
  exit 0
fi

# Check if docker-registry-mirror is reachable
MIRROR_IP=$(nslookup "$MIRROR_HOST" 2>/dev/null | awk '/^Address:/ && !/127\.0\.0\.53/ && !/::1/ {print $2}' | tail -1)
if [ -z "$MIRROR_IP" ]; then
  echo "No registry mirror found (${MIRROR_HOST} not resolvable), skipping" >&2
  exit 0
fi
echo "Registry mirror detected at ${MIRROR_IP}" >&2

# 1. Add /etc/hosts entries so Docker resolves Docker Hub hostnames to mirror
MARKER="# oci-lxc-deployer: registry mirror"
if ! grep -q "$MARKER" /etc/hosts 2>/dev/null; then
  echo "${MIRROR_IP} registry-1.docker.io index.docker.io  ${MARKER}" >> /etc/hosts
  echo "Added /etc/hosts entries for registry mirror" >&2
fi

# 2. Download CA certificate from deployer
CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"

if ! command -v curl > /dev/null 2>&1; then
  apk add --no-cache curl >&2 2>&1 || apt-get install -y -qq curl >&2 2>&1
fi

CERT_DIR="/etc/docker/certs.d/registry-1.docker.io"
mkdir -p "$CERT_DIR"
if curl -fsSL -k -o "${CERT_DIR}/ca.crt" "$CA_URL" 2>/dev/null; then
  echo "CA certificate installed at ${CERT_DIR}/ca.crt" >&2
else
  echo "Warning: Could not download CA certificate from ${CA_URL}" >&2
fi
