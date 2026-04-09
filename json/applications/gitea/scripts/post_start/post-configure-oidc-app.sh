#!/bin/sh
# Configure Gitea to use Zitadel as OIDC authentication source
#
# Runs on the PVE host (execute_on: ve). Uses the Gitea REST API
# to create the OIDC auth source — no CLI needed, no root issues.

VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
OIDC_ISSUER_URL="{{ oidc_issuer_url }}"
OIDC_CLIENT_ID="{{ oidc_client_id }}"
OIDC_CLIENT_SECRET="{{ oidc_client_secret }}"
GITEA_ADMIN_USER="admin"
GITEA_ADMIN_PASS="{{ GITEA_ADMIN_PASSWORD }}"
AUTH_NAME="zitadel"
DISCOVERY_URL="${OIDC_ISSUER_URL}/.well-known/openid-configuration"

echo "Configuring Gitea OIDC authentication source via REST API..." >&2
echo "  VMID:          ${VMID}" >&2
echo "  Hostname:      ${HOSTNAME}" >&2
echo "  Issuer URL:    ${OIDC_ISSUER_URL}" >&2
echo "  Discovery URL: ${DISCOVERY_URL}" >&2
echo "  Client ID:     ${OIDC_CLIENT_ID}" >&2

# Use container hostname directly (dnsmasq resolves it)
GITEA_URL="http://${HOSTNAME}:3000"
echo "  Gitea API:     ${GITEA_URL}" >&2

# Wait for Gitea API to be ready
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "${GITEA_URL}/api/v1/version" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "Gitea API ready" >&2
    break
  fi
  RETRIES=$((RETRIES - 1))
  sleep 2
done
if [ $RETRIES -eq 0 ]; then
  echo "ERROR: Gitea API not ready" >&2
  exit 1
fi

# Create admin user via Gitea CLI if not exists
ADMIN_USER="$GITEA_ADMIN_USER"
ADMIN_PASS="$GITEA_ADMIN_PASS"

# Check if admin user exists (try basic auth)
AUTH_CHECK=$(curl -sk -o /dev/null -w "%{http_code}" -u "${ADMIN_USER}:${ADMIN_PASS}" "${GITEA_URL}/api/v1/user" 2>/dev/null)
if [ "$AUTH_CHECK" != "200" ]; then
  echo "Admin user not found, creating via CLI..." >&2
  pct exec "$VMID" -- sh -c "I_AM_BEING_UNSAFE_RUNNING_AS_ROOT=true gitea admin user create --admin --username '${ADMIN_USER}' --password '${ADMIN_PASS}' --email 'admin@localhost' --must-change-password=false" >&2 2>&1
  sleep 2
fi

# Get or create API token
TOKEN=$(curl -sk -X POST "${GITEA_URL}/api/v1/users/${ADMIN_USER}/tokens" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
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

# Create OIDC authentication source via REST API
# type 6 = OAuth2, see https://docs.gitea.com/development/oauth2-provider
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
  AUTH_ID=$(echo "$RESULT" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  echo "OIDC auth source '${AUTH_NAME}' created (id: ${AUTH_ID})" >&2
else
  echo "ERROR: Failed to create OIDC auth source" >&2
  echo "Response: ${RESULT}" >&2
  exit 1
fi
