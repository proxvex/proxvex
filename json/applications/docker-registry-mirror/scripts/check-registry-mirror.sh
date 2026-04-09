#!/bin/sh
# Verify the Docker Registry Mirror is working as a pull-through proxy.
#
# Runs on the PVE host (execute_on: ve) and:
# 1. Checks DNS resolves registry-1.docker.io to local IP
# 2. Ensures deployer CA is trusted (for skopeo)
# 3. Tests skopeo inspect through the mirror
#
# Can also be run standalone on a PVE host:
#   DEPLOYER_URL=http://oci-lxc-deployer:3080 ./check-registry-mirror.sh

DEPLOYER_URL="{{ deployer_base_url }}"
VE_CONTEXT="{{ ve_context_key }}"
REGISTRY_HOST="{{ hostname }}"

# Allow standalone usage via environment variables
[ "$DEPLOYER_URL" = "NOT_DEFINED" ] || [ -z "$DEPLOYER_URL" ] && DEPLOYER_URL="${DEPLOYER_URL_OVERRIDE:-}"
[ "$VE_CONTEXT" = "NOT_DEFINED" ] || [ -z "$VE_CONTEXT" ] && VE_CONTEXT="${VE_CONTEXT_OVERRIDE:-}"
[ "$REGISTRY_HOST" = "NOT_DEFINED" ] || [ -z "$REGISTRY_HOST" ] && REGISTRY_HOST="registry-1.docker.io"

ERRORS=""
add_error() { ERRORS="${ERRORS}${ERRORS:+\n}$1"; }

# 1. DNS check: registry-1.docker.io must resolve to a local address
echo "Checking DNS for ${REGISTRY_HOST}..." >&2
RESOLVED_IP=$(nslookup "$REGISTRY_HOST" 2>/dev/null | awk '/^Address:/ && !/127\.0\.0\.53/ && !/::1/ {print $2}' | tail -1)
if [ -z "$RESOLVED_IP" ]; then
  add_error "DNS: Cannot resolve ${REGISTRY_HOST}"
else
  case "$RESOLVED_IP" in
    10.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|192.168.*)
      echo "DNS: ${REGISTRY_HOST} -> ${RESOLVED_IP} (local)" >&2
      ;;
    *)
      add_error "DNS: ${REGISTRY_HOST} resolves to ${RESOLVED_IP} (expected local address)"
      ;;
  esac
fi

# 2. Ensure CA certificate is trusted
CA_CERT="/usr/local/share/ca-certificates/oci-lxc-deployer-ca.crt"
if [ ! -f "$CA_CERT" ]; then
  if [ -n "$DEPLOYER_URL" ] && [ -n "$VE_CONTEXT" ]; then
    CA_URL="${DEPLOYER_URL}/api/${VE_CONTEXT}/ve/certificates/ca/download"
  elif [ -n "$DEPLOYER_URL" ]; then
    # Standalone mode: try without VE context (list contexts first)
    CA_URL=""
    echo "No VE context provided, trying to discover..." >&2
  else
    CA_URL=""
  fi

  if [ -n "$CA_URL" ]; then
    echo "Installing CA certificate from ${CA_URL}..." >&2
    if curl -fsSL -k -o "$CA_CERT" "$CA_URL" 2>/dev/null; then
      update-ca-certificates >/dev/null 2>&1
      echo "CA certificate installed" >&2
    else
      add_error "CA: Could not download certificate from ${CA_URL}"
    fi
  fi
fi

if [ ! -f "$CA_CERT" ]; then
  add_error "CA: Deployer CA certificate not installed at ${CA_CERT}"
fi

# 3. Skopeo inspect through the mirror
echo "Testing skopeo inspect through mirror..." >&2
if command -v skopeo >/dev/null 2>&1; then
  INSPECT_RESULT=$(skopeo inspect "docker://${REGISTRY_HOST}/library/alpine:latest" 2>&1)
  if echo "$INSPECT_RESULT" | grep -q '"Digest"'; then
    echo "Skopeo: Successfully inspected alpine:latest through mirror" >&2
  else
    add_error "Skopeo: Failed to inspect alpine:latest: $(echo "$INSPECT_RESULT" | head -3)"
  fi
else
  echo "Skopeo not available, skipping inspect test" >&2
fi

# Report result
if [ -n "$ERRORS" ]; then
  printf "Registry mirror check FAILED:\n%b\n" "$ERRORS" >&2
  echo '[]'
  exit 1
fi

echo "Registry mirror check PASSED" >&2
echo '[]'
