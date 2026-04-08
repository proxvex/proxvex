#!/bin/sh
# Setup test project, test user, and machine user in Zitadel.
#
# Runs inside the Zitadel LXC container (execute_on: lxc) before the
# hardening step (360). Uses the ephemeral admin PAT to create:
#   1. Project "proxmox" with projectRoleAssertion
#   2. Role "admin"
#   3. Human test user "testadmin" with admin role
#   4. Machine user "oidc-test-machine" with client credentials and admin role
#
# Stores test credentials in /bootstrap/test-oidc.json for downstream checks.
#
# Inputs:
#   hostname      - Zitadel hostname
#   domain_suffix - Domain suffix
#   ssl_mode      - SSL mode for protocol detection

HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
SSL_MODE="{{ ssl_mode }}"

[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=""
[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""

# Build Host header: must match ZITADEL_EXTERNALDOMAIN (= hostname, without domain_suffix)
PROTOCOL="http"
ZITADEL_HOST="${HOSTNAME}"
if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "none" ]; then
  PROTOCOL="https"
fi
ZITADEL_URL="http://localhost:8080"
CRED_FILE="/bootstrap/test-oidc.json"

# --- Ensure curl is available ---
if ! command -v curl > /dev/null 2>&1; then
  echo "Installing curl..." >&2
  apk add --no-cache curl >&2
fi

# --- Read admin PAT via /proc (distroless image has no shell tools) ---
echo "Reading admin PAT..." >&2
ZITADEL_CONTAINER_ID=$(docker ps -q -f name=zitadel-api 2>/dev/null | head -1)
PAT=""
if [ -n "$ZITADEL_CONTAINER_ID" ]; then
  GO_PID_FMT=$(printf '%s.State.Pid%s' '{{' '}}')
  CONTAINER_PID=$(docker inspect -f "$GO_PID_FMT" "$ZITADEL_CONTAINER_ID" 2>/dev/null)
  if [ -n "$CONTAINER_PID" ] && [ -f "/proc/${CONTAINER_PID}/root/zitadel/bootstrap/admin-client.pat" ]; then
    PAT=$(cat "/proc/${CONTAINER_PID}/root/zitadel/bootstrap/admin-client.pat" 2>/dev/null)
  fi
fi

# Use container IP for API calls (bypasses Traefik)
if [ -n "$ZITADEL_CONTAINER_ID" ]; then
  GO_IP_FMT=$(printf '%srange .NetworkSettings.Networks%s%s.IPAddress%s%send%s' \
    '{{' '}}' '{{' '}}' '{{' '}}')
  ZITADEL_API_IP=$(docker inspect -f "$GO_IP_FMT" "$ZITADEL_CONTAINER_ID" 2>/dev/null)
  if [ -n "$ZITADEL_API_IP" ]; then
    ZITADEL_URL="http://${ZITADEL_API_IP}:8080"
  fi
fi
echo "Zitadel API URL: ${ZITADEL_URL} (Host: ${ZITADEL_HOST})" >&2

if [ -z "$PAT" ]; then
  if [ -f "$CRED_FILE" ]; then
    echo "Admin PAT not available but test credentials exist, skipping" >&2
    echo '[]'
    exit 0
  fi
  echo "ERROR: No admin PAT available (already hardened?)" >&2
  echo '[]'
  exit 1
fi
echo "Admin PAT obtained" >&2

# --- Helper: API call with Host header ---
zitadel_api() {
  _method="$1"
  _path="$2"
  _body="$3"
  if [ -n "$_body" ]; then
    curl -sk -X "$_method" \
      -H "Host: ${ZITADEL_HOST}" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      -d "$_body" \
      "${ZITADEL_URL}${_path}" 2>/dev/null
  else
    curl -sk -X "$_method" \
      -H "Host: ${ZITADEL_HOST}" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      "${ZITADEL_URL}${_path}" 2>/dev/null
  fi
}

# --- 1. Create project "proxmox" ---
echo "Creating project 'proxmox'..." >&2
PROJECT_RESPONSE=$(zitadel_api POST "/management/v1/projects" \
  '{"name":"proxmox","projectRoleAssertion":true}')
PROJECT_ID=$(echo "$PROJECT_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$PROJECT_ID" ]; then
  # Project might already exist
  SEARCH=$(zitadel_api POST "/management/v1/projects/_search" \
    '{"queries":[{"nameQuery":{"name":"proxmox","method":"TEXT_QUERY_METHOD_EQUALS"}}]}')
  PROJECT_ID=$(echo "$SEARCH" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
fi

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: Cannot create/find project 'proxmox'" >&2
  echo "Response: ${PROJECT_RESPONSE}" >&2
  echo '[]'
  exit 1
fi

# Ensure projectRoleAssertion is enabled
zitadel_api PUT "/management/v1/projects/${PROJECT_ID}" \
  '{"name":"proxmox","projectRoleAssertion":true}' > /dev/null
echo "Project 'proxmox': ${PROJECT_ID}" >&2

# --- 2. Create role "admin" ---
zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles" \
  '{"roleKey":"admin","displayName":"Admin","group":"deployer"}' > /dev/null 2>&1
echo "Role 'admin' ensured" >&2

# --- 3. Create human test user ---
echo "Creating test user 'testadmin'..." >&2
USER_RESPONSE=$(zitadel_api POST "/v2/users/human" \
  "{\"username\":\"testadmin\",\"profile\":{\"givenName\":\"Test\",\"familyName\":\"Admin\"},\"email\":{\"email\":\"testadmin@${ZITADEL_HOST}\",\"isVerified\":true},\"password\":{\"password\":\"TestAdmin-1234\",\"changeRequired\":false}}")
TEST_USER_ID=$(echo "$USER_RESPONSE" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$TEST_USER_ID" ]; then
  # User might already exist
  SEARCH=$(zitadel_api POST "/management/v1/users/_search" \
    '{"queries":[{"userNameQuery":{"userName":"testadmin","method":"TEXT_QUERY_METHOD_EQUALS"}}]}')
  TEST_USER_ID=$(echo "$SEARCH" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
fi

if [ -z "$TEST_USER_ID" ]; then
  echo "WARNING: Cannot create/find test user 'testadmin'" >&2
else
  echo "Test user 'testadmin': ${TEST_USER_ID}" >&2
  # Grant admin role
  zitadel_api POST "/management/v1/users/${TEST_USER_ID}/grants" \
    "{\"projectId\":\"${PROJECT_ID}\",\"roleKeys\":[\"admin\"]}" > /dev/null 2>&1
  echo "Test user granted 'admin' role" >&2
fi

# --- 4. Create machine user for OIDC client credentials flow ---
echo "Creating machine user 'oidc-test-machine'..." >&2
MACHINE_RESPONSE=$(zitadel_api POST "/management/v1/users/machine" \
  '{"userName":"oidc-test-machine","name":"OIDC Test Machine","accessTokenType":"ACCESS_TOKEN_TYPE_JWT"}')
MACHINE_USER_ID=$(echo "$MACHINE_RESPONSE" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$MACHINE_USER_ID" ]; then
  # User might already exist
  SEARCH=$(zitadel_api POST "/management/v1/users/_search" \
    '{"queries":[{"userNameQuery":{"userName":"oidc-test-machine","method":"TEXT_QUERY_METHOD_EQUALS"}}]}')
  MACHINE_USER_ID=$(echo "$SEARCH" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
fi

MACHINE_CLIENT_ID=""
MACHINE_CLIENT_SECRET=""
if [ -n "$MACHINE_USER_ID" ]; then
  echo "Machine user: ${MACHINE_USER_ID}" >&2

  # Generate client secret
  SECRET_RESPONSE=$(zitadel_api PUT "/management/v1/users/${MACHINE_USER_ID}/secret")
  MACHINE_CLIENT_ID=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
  MACHINE_CLIENT_SECRET=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

  # Grant admin role
  zitadel_api POST "/management/v1/users/${MACHINE_USER_ID}/grants" \
    "{\"projectId\":\"${PROJECT_ID}\",\"roleKeys\":[\"admin\"]}" > /dev/null 2>&1
  echo "Machine user granted 'admin' role" >&2
else
  echo "WARNING: Cannot create/find machine user" >&2
fi

# --- 5. Build issuer URL ---
PROTOCOL="http"
if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "none" ]; then
  PROTOCOL="https"
fi
ISSUER_URL="${PROTOCOL}://${ZITADEL_HOST}"

# --- 6. Store test credentials ---
cat > "$CRED_FILE" <<ENDOFCRED
{
  "issuer_url": "${ISSUER_URL}",
  "project_id": "${PROJECT_ID}",
  "test_user_id": "${TEST_USER_ID}",
  "machine_client_id": "${MACHINE_CLIENT_ID}",
  "machine_client_secret": "${MACHINE_CLIENT_SECRET}"
}
ENDOFCRED
chmod 0600 "$CRED_FILE"
echo "Test credentials stored in ${CRED_FILE}" >&2

# --- Output ---
cat <<ENDOFOUTPUT
[
  {"id": "test_project_id", "value": "${PROJECT_ID}"},
  {"id": "test_user_id", "value": "${TEST_USER_ID}"},
  {"id": "test_machine_client_id", "value": "${MACHINE_CLIENT_ID}"},
  {"id": "test_machine_client_secret", "value": "${MACHINE_CLIENT_SECRET}"}
]
ENDOFOUTPUT
