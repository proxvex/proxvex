#!/bin/sh
# Configure Gitea to use Zitadel as OIDC authentication source
#
# This script overrides the shared no-op post-configure-oidc-app.sh.
# It runs on the PVE host (execute_on: ve) and uses the gitea CLI
# inside the container to add an OpenID Connect authentication source.
#
# Inputs (template variables):
#   vm_id              - VMID of the Gitea container
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret

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
    # OCI-image: gitea refuses to run as root, use env to bypass
    pct exec "$VMID" -- env GITEA_ALLOW_ROOT=true /app/gitea/gitea "$@"
  fi
}

# Check if auth source already exists
EXISTING=$(gitea_exec admin auth list 2>/dev/null \
  | grep -w "${AUTH_NAME}" || true)

if [ -n "$EXISTING" ]; then
  echo "OIDC auth source '${AUTH_NAME}' already exists, skipping." >&2
  echo '[]'
  exit 0
fi

# Add OpenID Connect authentication source via gitea CLI
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
  echo '[]'
  exit 1
fi

echo '[]'
