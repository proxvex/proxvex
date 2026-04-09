#!/bin/sh
# Configure Gitea to use Zitadel as OIDC authentication source
#
# Runs on the PVE host (execute_on: ve). Uses the gitea CLI inside
# the container to add an OpenID Connect authentication source.

VMID="{{ vm_id }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
AUTH_NAME="zitadel"
DISCOVERY_URL="${OIDC_ISSUER_URL}/.well-known/openid-configuration"

echo "Configuring Gitea OIDC authentication source..." >&2
echo "  VMID:          ${VMID}" >&2
echo "  Issuer URL:    ${OIDC_ISSUER_URL}" >&2
echo "  Discovery URL: ${DISCOVERY_URL}" >&2
echo "  Client ID:     ${OIDC_CLIENT_ID}" >&2

# Detect execution mode: docker-compose (has docker) or OCI-image (direct binary)
HAS_DOCKER=$(pct exec "$VMID" -- sh -c "command -v docker" 2>/dev/null) || true

gitea_exec() {
  if [ -n "$HAS_DOCKER" ]; then
    pct exec "$VMID" -- docker exec gitea gitea "$@"
  else
    # OCI image: pct exec runs as root, but gitea refuses root.
    # Use sh -c with env var to bypass the root check for admin commands.
    pct exec "$VMID" -- sh -c "I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true /usr/local/bin/gitea $*"
  fi
}

# Check if auth source already exists
EXISTING=$(gitea_exec admin auth list 2>/dev/null | grep -w "${AUTH_NAME}" || true)

if [ -n "$EXISTING" ]; then
  echo "OIDC auth source '${AUTH_NAME}' already exists, skipping." >&2
  exit 0
fi

# Add OpenID Connect authentication source
gitea_exec admin auth add-oauth \
  --name "${AUTH_NAME}" \
  --provider openidConnect \
  --key "${OIDC_CLIENT_ID}" \
  --secret "${OIDC_CLIENT_SECRET}" \
  --auto-discover-url "${DISCOVERY_URL}" \
  --scopes "openid email profile" >&2

if [ $? -eq 0 ]; then
  echo "OIDC auth source '${AUTH_NAME}' created successfully" >&2
else
  echo "ERROR: Failed to create OIDC auth source" >&2
  exit 1
fi
