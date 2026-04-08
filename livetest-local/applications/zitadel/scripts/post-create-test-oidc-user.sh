#!/bin/sh
# Create a machine user with ORG_OWNER role for test OIDC operations.
#
# Runs inside the Zitadel LXC container (execute_on: lxc) before the
# hardening step (360). Uses the ephemeral admin PAT to create:
#   1. Machine user "test-deployer" with client_credentials support
#   2. IAM ORG_OWNER role grant (allows creating projects and OIDC apps)
#
# Stores credentials in /bootstrap/test-deployer.json for the livetest runner.
# The runner uses these credentials with --oidc-client-id/--oidc-client-secret
# to authenticate CLI sessions. The deployer forwards the resulting access token
# as ZITADEL_PAT to conf-setup-oidc-client.sh (delegated access).
#
# Inputs:
#   hostname       - Zitadel hostname
#   compose_project - Docker Compose project name
#   domain_suffix  - Domain suffix
#   ssl_mode       - SSL mode for protocol detection

HOSTNAME="{{ hostname }}"
COMPOSE_PROJECT="{{ compose_project }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
SSL_MODE="{{ ssl_mode }}"

[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=""
[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""

CRED_FILE="/bootstrap/test-deployer.json"

# --- Skip if credentials already exist ---
if [ -f "$CRED_FILE" ]; then
  echo "Test deployer credentials already exist at ${CRED_FILE}, skipping" >&2
  echo '[]'
  exit 0
fi

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
  if [ -n "$CONTAINER_PID" ] && [ -f "/proc/${CONTAINER_PID}/root/zitadel/tmp/admin-client.pat" ]; then
    PAT=$(cat "/proc/${CONTAINER_PID}/root/zitadel/tmp/admin-client.pat" 2>/dev/null)
  fi
fi

if [ -z "$PAT" ]; then
  echo "ERROR: No admin PAT available (already hardened?)" >&2
  echo '[]'
  exit 1
fi
echo "Admin PAT obtained" >&2

# --- Build Zitadel API URL (use container IP to bypass Traefik) ---
ZITADEL_URL="http://localhost:8080"
ZITADEL_HOST="${HOSTNAME}"
if [ -n "$ZITADEL_CONTAINER_ID" ]; then
  GO_IP_FMT=$(printf '%srange .NetworkSettings.Networks%s%s.IPAddress%s%send%s' \
    '{{' '}}' '{{' '}}' '{{' '}}')
  ZITADEL_API_IP=$(docker inspect -f "$GO_IP_FMT" "$ZITADEL_CONTAINER_ID" 2>/dev/null)
  if [ -n "$ZITADEL_API_IP" ]; then
    ZITADEL_URL="http://${ZITADEL_API_IP}:8080"
  fi
fi
echo "Zitadel API URL: ${ZITADEL_URL} (Host: ${ZITADEL_HOST})" >&2

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

# --- 1. Create machine user "test-deployer" ---
echo "Creating machine user 'test-deployer'..." >&2
MACHINE_RESPONSE=$(zitadel_api POST "/management/v1/users/machine" \
  '{"userName":"test-deployer","name":"Test Deployer Service Account","accessTokenType":"ACCESS_TOKEN_TYPE_JWT"}')
MACHINE_USER_ID=$(echo "$MACHINE_RESPONSE" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$MACHINE_USER_ID" ]; then
  # User might already exist
  SEARCH=$(zitadel_api POST "/management/v1/users/_search" \
    '{"queries":[{"userNameQuery":{"userName":"test-deployer","method":"TEXT_QUERY_METHOD_EQUALS"}}]}')
  MACHINE_USER_ID=$(echo "$SEARCH" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
fi

if [ -z "$MACHINE_USER_ID" ]; then
  echo "ERROR: Cannot create/find machine user 'test-deployer'" >&2
  echo '[]'
  exit 1
fi
echo "Machine user 'test-deployer': ${MACHINE_USER_ID}" >&2

# --- 2. Grant ORG_OWNER role at IAM level ---
echo "Granting ORG_OWNER role..." >&2
zitadel_api POST "/admin/v1/members" \
  "{\"userId\":\"${MACHINE_USER_ID}\",\"roles\":[\"IAM_ORG_OWNER\"]}" > /dev/null 2>&1
echo "ORG_OWNER role granted" >&2

# --- 3. Generate client credentials ---
echo "Generating client credentials..." >&2
SECRET_RESPONSE=$(zitadel_api PUT "/management/v1/users/${MACHINE_USER_ID}/secret")
CLIENT_ID=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
CLIENT_SECRET=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "ERROR: Failed to generate client credentials" >&2
  echo "Response: ${SECRET_RESPONSE}" >&2
  echo '[]'
  exit 1
fi
echo "Client credentials generated" >&2

# --- 4. Build issuer URL ---
PROTOCOL="http"
if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "none" ]; then
  PROTOCOL="https"
fi
ISSUER_URL="${PROTOCOL}://${HOSTNAME}${DOMAIN_SUFFIX}"

# --- 5. Store credentials ---
cat > "$CRED_FILE" <<ENDOFCRED
{
  "user_id": "${MACHINE_USER_ID}",
  "client_id": "${CLIENT_ID}",
  "client_secret": "${CLIENT_SECRET}",
  "issuer_url": "${ISSUER_URL}"
}
ENDOFCRED
chmod 0600 "$CRED_FILE"
echo "Test deployer credentials stored in ${CRED_FILE}" >&2

# --- Output ---
cat <<ENDOFOUTPUT
[
  {"id": "test_deployer_client_id", "value": "${CLIENT_ID}"},
  {"id": "test_deployer_client_secret", "value": "${CLIENT_SECRET}"}
]
ENDOFOUTPUT
