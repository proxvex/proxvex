#!/bin/sh
# Configure Gitea to use Zitadel as OIDC authentication source
#
# Runs inside the container (execute_on: lxc).

OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
AUTH_NAME="zitadel"
DISCOVERY_URL="${OIDC_ISSUER_URL}/.well-known/openid-configuration"

echo "Configuring Gitea OIDC authentication source..." >&2
echo "  Issuer URL:    ${OIDC_ISSUER_URL}" >&2
echo "  Discovery URL: ${DISCOVERY_URL}" >&2
echo "  Client ID:     ${OIDC_CLIENT_ID}" >&2

# Find gitea binary
if command -v gitea >/dev/null 2>&1; then
  GITEA_BIN="gitea"
elif [ -x /usr/local/bin/gitea ]; then
  GITEA_BIN="/usr/local/bin/gitea"
elif [ -x /app/gitea/gitea ]; then
  GITEA_BIN="/app/gitea/gitea"
else
  # Docker-compose: exec into gitea container
  if command -v docker >/dev/null 2>&1; then
    GITEA_BIN="docker exec gitea gitea"
  else
    echo "ERROR: gitea binary not found" >&2
    exit 1
  fi
fi

# Check if auth source already exists
EXISTING=$($GITEA_BIN admin auth list 2>/dev/null | grep -w "${AUTH_NAME}" || true)

if [ -n "$EXISTING" ]; then
  echo "OIDC auth source '${AUTH_NAME}' already exists, skipping." >&2
  exit 0
fi

# Add OpenID Connect authentication source
$GITEA_BIN admin auth add-oauth \
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
