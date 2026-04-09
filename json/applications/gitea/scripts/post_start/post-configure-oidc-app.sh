#!/bin/sh
# Configure Gitea to use Zitadel as OIDC authentication source
#
# Runs inside the container as the application user (execute_on: lxc with uid/gid).
# Uses Gitea CLI to create admin user and REST API for OIDC auth source.

HOSTNAME="{{ hostname }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
GITEA_ADMIN_USER="admin"
GITEA_ADMIN_PASS="{{ GITEA_ADMIN_PASSWORD }}"
AUTH_NAME="zitadel"
DISCOVERY_URL="${OIDC_ISSUER_URL}/.well-known/openid-configuration"
GITEA_URL="http://localhost:3000"

echo "Configuring Gitea OIDC authentication source..." >&2
echo "  Issuer URL:    ${OIDC_ISSUER_URL}" >&2
echo "  Discovery URL: ${DISCOVERY_URL}" >&2
echo "  Client ID:     ${OIDC_CLIENT_ID}" >&2

# Create admin user if not exists (runs as gitea user via uid/gid)
EXISTING_USER=$(gitea admin user list 2>/dev/null | grep -w "${GITEA_ADMIN_USER}" || true)
if [ -z "$EXISTING_USER" ]; then
  echo "Creating admin user..." >&2
  gitea admin user create --admin --username "${GITEA_ADMIN_USER}" --password "${GITEA_ADMIN_PASS}" --email "admin@localhost" --must-change-password=false >&2 2>&1
fi

# Wait for Gitea API
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "${GITEA_URL}/api/v1/version" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then break; fi
  RETRIES=$((RETRIES - 1))
  sleep 2
done
if [ $RETRIES -eq 0 ]; then
  echo "ERROR: Gitea API not ready" >&2
  exit 1
fi
echo "Gitea API ready" >&2

# Get API token
TOKEN=$(curl -sk -X POST "${GITEA_URL}/api/v1/users/${GITEA_ADMIN_USER}/tokens" \
  -u "${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASS}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"oidc-setup-$(date +%s)\",\"scopes\":[\"all\"]}" 2>/dev/null \
  | sed -n 's/.*"sha1":"\([^"]*\)".*/\1/p')

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not create admin API token" >&2
  exit 1
fi
echo "Admin API token obtained" >&2

# Check if auth source already exists
EXISTING=$(curl -sk -H "Authorization: token ${TOKEN}" \
  "${GITEA_URL}/api/v1/admin/auths" 2>/dev/null \
  | grep -o "\"name\":\"${AUTH_NAME}\"" || true)

if [ -n "$EXISTING" ]; then
  echo "OIDC auth source '${AUTH_NAME}' already exists, skipping." >&2
  exit 0
fi

# Create OIDC authentication source (type 6 = OAuth2)
RESULT=$(curl -sk -X POST "${GITEA_URL}/api/v1/admin/auths" \
  -H "Authorization: token ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": 6,
    \"name\": \"${AUTH_NAME}\",
    \"is_active\": true,
    \"oauth2_config\": {
      \"provider\": \"openidConnect\",
      \"client_id\": \"${OIDC_CLIENT_ID}\",
      \"client_secret\": \"${OIDC_CLIENT_SECRET}\",
      \"open_id_connect_auto_discovery_url\": \"${DISCOVERY_URL}\",
      \"scopes\": [\"openid\", \"email\", \"profile\"]
    }
  }" 2>/dev/null)

if echo "$RESULT" | grep -q "\"id\""; then
  echo "OIDC auth source '${AUTH_NAME}' created successfully" >&2
else
  echo "ERROR: Failed to create OIDC auth source" >&2
  echo "Response: ${RESULT}" >&2
  exit 1
fi
