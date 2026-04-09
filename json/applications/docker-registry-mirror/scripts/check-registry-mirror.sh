#!/bin/sh
# Verify the Docker Registry Mirror is working as a pull-through proxy.
#
# Runs on the PVE host (execute_on: ve) and:
# 1. Checks docker-registry-mirror is reachable
# 2. Adds /etc/hosts entries for registry-1.docker.io + index.docker.io
# 3. Ensures deployer CA is trusted (for skopeo)
# 4. Tests skopeo inspect through the mirror
#
# Can also be run standalone:
#   ./check-registry-mirror.sh <deployer-url> <ve-context>

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"
MIRROR_HOST="{{ hostname }}"

# Allow standalone usage via positional args
[ "$DEPLOYER_URL" = "NOT_DEFINED" ] || [ -z "$DEPLOYER_URL" ] && DEPLOYER_URL="${1:-}"
[ "$VE_CONTEXT" = "NOT_DEFINED" ] || [ -z "$VE_CONTEXT" ] && VE_CONTEXT="${2:-}"
[ "$MIRROR_HOST" = "NOT_DEFINED" ] || [ -z "$MIRROR_HOST" ] && MIRROR_HOST="docker-registry-mirror"

ERRORS=""
add_error() { ERRORS="${ERRORS}${ERRORS:+\n}$1"; }

# 1. DNS check: docker-registry-mirror must resolve to a local address
echo "Checking DNS for ${MIRROR_HOST}..." >&2
MIRROR_IP=$(nslookup "$MIRROR_HOST" 2>/dev/null | awk '/^Address:/ && !/127\.0\.0\.53/ && !/::1/ {print $2}' | tail -1)
if [ -z "$MIRROR_IP" ]; then
  add_error "DNS: Cannot resolve ${MIRROR_HOST}"
else
  case "$MIRROR_IP" in
    10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*)
      echo "DNS: ${MIRROR_HOST} -> ${MIRROR_IP} (local)" >&2
      ;;
    *)
      add_error "DNS: ${MIRROR_HOST} resolves to ${MIRROR_IP} (expected local address)"
      ;;
  esac
fi

# 2. Add /etc/hosts entries for Docker Hub hostnames -> mirror IP
MARKER="# oci-lxc-deployer: registry mirror"
if [ -n "$MIRROR_IP" ] && ! grep -q "$MARKER" /etc/hosts 2>/dev/null; then
  echo "${MIRROR_IP} registry-1.docker.io index.docker.io  ${MARKER}" >> /etc/hosts
  echo "Added /etc/hosts: ${MIRROR_IP} -> registry-1.docker.io, index.docker.io" >&2
fi

# 3. Ensure CA certificate is trusted
CA_CERT="/usr/local/share/ca-certificates/oci-lxc-deployer-ca.crt"
if [ ! -f "$CA_CERT" ] && [ -n "$DEPLOYER_URL" ] && [ -n "$VE_CONTEXT" ]; then
  CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"
  echo "Installing CA certificate from ${CA_URL}..." >&2
  if curl -fsSL -k -o "$CA_CERT" "$CA_URL" 2>/dev/null; then
    update-ca-certificates >/dev/null 2>&1
    echo "CA certificate installed" >&2
  else
    add_error "CA: Could not download from ${CA_URL}"
  fi
fi

if [ ! -f "$CA_CERT" ]; then
  add_error "CA: Deployer CA certificate not installed at ${CA_CERT}"
fi

# 4. Skopeo inspect through the mirror (using registry-1.docker.io which now points to mirror)
echo "Testing skopeo inspect through mirror..." >&2
if command -v skopeo >/dev/null 2>&1; then
  INSPECT_RESULT=$(skopeo inspect "docker://registry-1.docker.io/library/alpine:latest" 2>&1)
  if echo "$INSPECT_RESULT" | grep -q '"Digest"'; then
    DIGEST=$(echo "$INSPECT_RESULT" | grep '"Digest"' | head -1 | sed 's/.*"Digest": *"//' | sed 's/".*//')
    echo "Skopeo: alpine:latest inspected through mirror (${DIGEST})" >&2
  else
    add_error "Skopeo: Failed to inspect alpine:latest: $(echo "$INSPECT_RESULT" | head -3)"
  fi
else
  echo "Skopeo not available, skipping inspect test" >&2
fi

# Report result
if [ -n "$ERRORS" ]; then
  printf "Registry mirror check FAILED:\n%b\n" "$ERRORS" >&2
  exit 1
fi

echo "Registry mirror check PASSED" >&2
