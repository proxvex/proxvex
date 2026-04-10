#!/bin/sh
# Setup oci-lxc-deployer project, OIDC app, and roles in Zitadel.
#
# Runs inside the Zitadel LXC container (execute_on: lxc) after docker
# compose start. Uses the ephemeral admin PAT from Docker tmpfs to create:
#   1. Project "oci-lxc-deployer" with projectRoleAssertion
#   2. Roles from oidc_roles (admin)
#   3. OIDC app "oci-lxc-deployer" with callback URLs
#   4. Stores credentials in /bootstrap/deployer-oidc.json
#
# The admin PAT is only available during first start (start-from-init)
# and will be invalidated by the hardening step (360).
#
# Inputs:
#   hostname          - Zitadel hostname
#   domain_suffix     - Domain suffix for URLs
#   compose_project   - Docker compose project name
#   ssl_mode          - SSL mode for protocol detection
#
# Outputs:
#   oidc_issuer_url   - Zitadel issuer URL
#   zitadel_project_id - Project ID
#   oidc_client_id    - OIDC client ID
#   oidc_client_secret - OIDC client secret

HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
COMPOSE_PROJECT="{{ compose_project }}"
SSL_MODE="{{ ssl_mode }}"

[ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ] && DOMAIN_SUFFIX=""
[ "$COMPOSE_PROJECT" = "NOT_DEFINED" ] && COMPOSE_PROJECT=""
[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""

PROJECT_NAME="oci-lxc-deployer"
OIDC_APP_NAME="oci-lxc-deployer"
OIDC_CALLBACK_PATH="/api/auth/callback"
CRED_FILE="/bootstrap/deployer-oidc.json"

# --- Ensure curl is available ---
if ! command -v curl > /dev/null 2>&1; then
  echo "Installing curl..." >&2
  apk add --no-cache curl >&2
fi

# --- Read admin PAT from Docker tmpfs ---
# The PAT is in the zitadel-api container at /zitadel/bootstrap/admin-client.pat
echo "Reading admin PAT from Docker container..." >&2

# Detect docker compose command
if command -v docker > /dev/null 2>&1 && docker compose version > /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose > /dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: docker compose not found" >&2
  echo '[]'
  exit 1
fi

COMPOSE_DIR="/opt/docker-compose/${COMPOSE_PROJECT}"
if [ -n "$COMPOSE_PROJECT" ] && [ -d "$COMPOSE_DIR" ]; then
  cd "$COMPOSE_DIR"
fi

# Read PAT via /proc filesystem — the Zitadel distroless image has no shell tools
# (no cat, no sh), so docker exec cannot be used to read files.
ZITADEL_CONTAINER_ID=$(docker ps -q -f name=zitadel-api 2>/dev/null | head -1)
if [ -n "$ZITADEL_CONTAINER_ID" ]; then
  GO_PID_FMT=$(printf '%s.State.Pid%s' '{{' '}}')
  CONTAINER_PID=$(docker inspect -f "$GO_PID_FMT" "$ZITADEL_CONTAINER_ID" 2>/dev/null)
  if [ -n "$CONTAINER_PID" ] && [ -f "/proc/${CONTAINER_PID}/root/zitadel/bootstrap/admin-client.pat" ]; then
    PAT=$(cat "/proc/${CONTAINER_PID}/root/zitadel/bootstrap/admin-client.pat" 2>/dev/null)
  fi
fi

if [ -z "$PAT" ]; then
  echo "Admin PAT not available (already bootstrapped or container not ready)" >&2
  # Check if credentials already exist from a previous run
  if [ -f "$CRED_FILE" ]; then
    echo "Credentials already exist at ${CRED_FILE}, skipping" >&2
    echo '[]'
    exit 0
  fi
  echo "ERROR: No admin PAT and no existing credentials" >&2
  echo '[]'
  exit 1
fi

echo "Admin PAT obtained" >&2

# --- Build Zitadel URL ---
# Connect to the zitadel-api Docker container directly (bypasses Traefik).
# The /debug/ready endpoint doesn't need domain validation.
# For management API calls, we set the Host header to match Zitadel's external domain+port.
GO_PID_FMT=$(printf '%srange .NetworkSettings.Networks%s%s.IPAddress%s%send%s' \
  '{{' '}}' '{{' '}}' '{{' '}}')
ZITADEL_API_IP=$(docker inspect -f "$GO_PID_FMT" "$ZITADEL_CONTAINER_ID" 2>/dev/null)

if [ -n "$ZITADEL_API_IP" ]; then
  ZITADEL_URL="http://${ZITADEL_API_IP}:8080"
else
  ZITADEL_URL="http://localhost:8080"
fi

# Build Host header: must match ZITADEL_EXTERNALDOMAIN (= hostname, without domain_suffix).
# Zitadel registers the instance under EXTERNALDOMAIN only, not hostname+suffix.
PROTOCOL="http"
ZITADEL_HOST="${HOSTNAME}"
if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "none" ]; then
  PROTOCOL="https"
fi
ISSUER_URL="${PROTOCOL}://${HOSTNAME}${DOMAIN_SUFFIX}"

echo "Zitadel API URL: ${ZITADEL_URL} (Host: ${ZITADEL_HOST})" >&2

# --- Wait for Zitadel ready ---
echo "Waiting for Zitadel API..." >&2
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" "${ZITADEL_URL}/debug/ready" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "Zitadel API ready" >&2
    break
  fi
  RETRIES=$((RETRIES - 1))
  sleep 2
done

if [ $RETRIES -eq 0 ]; then
  echo "ERROR: Zitadel did not become ready" >&2
  echo '[]'
  exit 1
fi

# --- Helper: API call ---
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

# --- 1. Find or create project ---
echo "Searching for project '${PROJECT_NAME}'..." >&2
PROJECT_RESPONSE=$(zitadel_api POST "/management/v1/projects/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${PROJECT_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$PROJECT_ID" ]; then
  echo "Creating project '${PROJECT_NAME}'..." >&2
  CREATE_RESPONSE=$(zitadel_api POST "/management/v1/projects" \
    "{\"name\":\"${PROJECT_NAME}\",\"projectRoleAssertion\":true}")
  PROJECT_ID=$(echo "$CREATE_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$PROJECT_ID" ]; then
    echo "ERROR: Failed to create project" >&2
    echo "Response: ${CREATE_BODY_RESP}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created project with ID ${PROJECT_ID}" >&2
else
  echo "Found project with ID ${PROJECT_ID}" >&2
fi

# --- 2. Create roles (skip all if any exist) ---
echo "Checking existing roles..." >&2
ROLES_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles/_search" "{}")
EXISTING_ROLE=$(echo "$ROLES_RESPONSE" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$EXISTING_ROLE" ]; then
  echo "Creating roles..." >&2
  zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles" \
    "{\"roleKey\":\"admin\",\"displayName\":\"Administrator\",\"group\":\"deployer\"}" >/dev/null 2>&1
  echo "  Created role: admin" >&2
else
  echo "Roles already exist (found: ${EXISTING_ROLE}), skipping" >&2
fi

# --- 3. Find or create OIDC app ---
echo "Searching for OIDC app '${OIDC_APP_NAME}'..." >&2
APP_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${OIDC_APP_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

APP_ID=$(echo "$APP_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
CLIENT_ID=""
CLIENT_SECRET=""

if [ -z "$APP_ID" ]; then
  echo "Creating OIDC app '${OIDC_APP_NAME}'..." >&2
  CALLBACK_URL="${PROTOCOL}://${HOSTNAME}${DOMAIN_SUFFIX}${OIDC_CALLBACK_PATH}"
  LOGOUT_URL="${PROTOCOL}://${HOSTNAME}${DOMAIN_SUFFIX}"

  CREATE_APP_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/oidc" \
    "{\"name\":\"${OIDC_APP_NAME}\",\"redirectUris\":[\"${CALLBACK_URL}\"],\"responseTypes\":[\"OIDC_RESPONSE_TYPE_CODE\"],\"grantTypes\":[\"OIDC_GRANT_TYPE_AUTHORIZATION_CODE\"],\"appType\":\"OIDC_APP_TYPE_WEB\",\"authMethodType\":\"OIDC_AUTH_METHOD_TYPE_BASIC\",\"postLogoutRedirectUris\":[\"${LOGOUT_URL}\"]}")

  APP_ID=$(echo "$CREATE_APP_RESPONSE" | sed -n 's/.*"appId":"\([^"]*\)".*/\1/p' | head -1)
  CLIENT_ID=$(echo "$CREATE_APP_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
  CLIENT_SECRET=$(echo "$CREATE_APP_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$APP_ID" ]; then
    echo "ERROR: Failed to create OIDC app" >&2
    echo "Response: ${CREATE_APP_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created OIDC app with ID ${APP_ID}" >&2
else
  echo "Found OIDC app with ID ${APP_ID}" >&2
  CLIENT_ID=$(echo "$APP_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
fi

if [ -z "$CLIENT_ID" ]; then
  echo "ERROR: Could not determine client ID" >&2
  echo '[]'
  exit 1
fi

# Generate client secret if needed (new app or no secret yet)
if [ -z "$CLIENT_SECRET" ]; then
  echo "Generating client secret..." >&2
  SECRET_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/${APP_ID}/oidc_config/_generate_client_secret" "{}")
  CLIENT_SECRET=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$CLIENT_SECRET" ]; then
    echo "ERROR: Failed to generate client secret" >&2
    echo '[]'
    exit 1
  fi
fi

# --- 4. Store credentials in bootstrap volume ---
echo "Storing credentials in ${CRED_FILE}..." >&2
cat > "$CRED_FILE" <<ENDOFCRED
{
  "issuer_url": "${ISSUER_URL}",
  "project_id": "${PROJECT_ID}",
  "client_id": "${CLIENT_ID}",
  "client_secret": "${CLIENT_SECRET}"
}
ENDOFCRED
chmod 0600 "$CRED_FILE"
echo "Credentials stored" >&2

# --- Output ---
echo "Deployer setup complete" >&2
cat <<ENDOFOUTPUT
[
  {"id": "oidc_issuer_url", "value": "${ISSUER_URL}"},
  {"id": "zitadel_project_id", "value": "${PROJECT_ID}"},
  {"id": "oidc_client_id", "value": "${CLIENT_ID}"},
  {"id": "oidc_client_secret", "value": "${CLIENT_SECRET}"}
]
ENDOFOUTPUT
