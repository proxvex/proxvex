#!/bin/sh
# Setup proxvex project, OIDC app, and roles in Zitadel.
#
# Runs inside the Zitadel LXC container (execute_on: lxc) after docker
# compose start. Uses the ephemeral admin PAT from Docker tmpfs to create:
#   1. Project "proxvex" with projectRoleAssertion
#   2. Roles from oidc_roles (admin)
#   3. OIDC app "proxvex" with callback URLs
#   4. Stores credentials in /bootstrap/deployer-oidc.json
#
# The admin PAT is only available during first start (start-from-init)
# and will be invalidated by the hardening step (360).
#
# Inputs:
#   hostname          - Zitadel hostname
#   project_domain_suffix     - Domain suffix for URLs
#   compose_project   - Docker compose project name
#   ssl_mode          - SSL mode for protocol detection
#
# Outputs:
#   oidc_issuer_url   - Zitadel issuer URL
#   zitadel_project_id - Project ID
#   oidc_client_id    - OIDC client ID
#   oidc_client_secret - OIDC client secret

HOSTNAME="{{ hostname }}"
PROJECT_DOMAIN_SUFFIX="{{ project_domain_suffix }}"
COMPOSE_PROJECT="{{ compose_project }}"
SSL_MODE="{{ ssl_mode }}"
ZITADEL_EXTERNALDOMAIN="{{ ZITADEL_EXTERNALDOMAIN }}"

[ "$PROJECT_DOMAIN_SUFFIX" = "NOT_DEFINED" ] && PROJECT_DOMAIN_SUFFIX=""
[ "$COMPOSE_PROJECT" = "NOT_DEFINED" ] && COMPOSE_PROJECT=""
[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""
[ "$ZITADEL_EXTERNALDOMAIN" = "NOT_DEFINED" ] && ZITADEL_EXTERNALDOMAIN=""

PROJECT_NAME="proxvex"
OIDC_APP_NAME="proxvex"
CRED_FILE="/bootstrap/deployer-oidc.json"

# --- Ensure curl is available ---
if ! command -v curl > /dev/null 2>&1; then
  echo "Installing curl..." >&2
  if ! pkg_install curl; then
    echo "ERROR: failed to install curl — Zitadel API wait would silently time out." >&2
    echo '[]'
    exit 1
  fi
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

# Build Host header and issuer URL. Zitadel registers the instance under its
# configured ExternalDomain — API calls must send that as Host or Zitadel
# returns "Instanz nicht gefunden". If ZITADEL_EXTERNALDOMAIN is set (public
# FQDN like auth.example.com), prefer it; otherwise fall back to the container
# hostname (+ project_domain_suffix), which matches the bare-LXC use case.
PROTOCOL="http"
if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "none" ]; then
  PROTOCOL="https"
fi
if [ -n "$ZITADEL_EXTERNALDOMAIN" ]; then
  ZITADEL_HOST="$ZITADEL_EXTERNALDOMAIN"
  ISSUER_URL="${PROTOCOL}://${ZITADEL_EXTERNALDOMAIN}"
else
  ZITADEL_HOST="${HOSTNAME}"
  ISSUER_URL="${PROTOCOL}://${HOSTNAME}${PROJECT_DOMAIN_SUFFIX}"
fi

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

# Ensure projectRoleAssertion is enabled. Zitadel's CreateProject does not
# reliably honor this field; UpdateProject is the only way to guarantee it.
# Without this, role claims (urn:zitadel:iam:org:project:roles) are missing
# from the ID token and proxvex's role check rejects every login with
# "missing role 'admin'". Idempotent — safe on re-runs.
echo "Ensuring projectRoleAssertion=true on project ${PROJECT_ID}..." >&2
zitadel_api PUT "/management/v1/projects/${PROJECT_ID}" \
  "{\"name\":\"${PROJECT_NAME}\",\"projectRoleAssertion\":true}" >/dev/null

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
  # Default deployer URL — matches proxvex/application.json oidc_redirect_uri
  # default. The actual deployer hostname/port is unknown at Zitadel-bootstrap
  # time (proxvex isn't deployed yet); user adjusts in Zitadel UI if non-standard.
  CALLBACK_URL="https://proxvex:3443/api/auth/callback"
  LOGOUT_URL="https://proxvex:3443"

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

# --- 4. Find or create machine user "deployer-cli" for client_credentials ---
# The OIDC app above is a Web app (auth_code flow) used by the browser login.
# Zitadel rejects client_credentials against it ("client not found"), so the
# CLI needs a separate Machine User. Without this, every CLI call to the
# OIDC-enforced deployer fails with HTTP 401 / "Authentication required".
MACHINE_USERNAME="deployer-cli"
echo "Searching for machine user '${MACHINE_USERNAME}'..." >&2
MACHINE_SEARCH=$(zitadel_api POST "/management/v1/users/_search" \
  "{\"queries\":[{\"userNameQuery\":{\"userName\":\"${MACHINE_USERNAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")
MACHINE_USER_ID=$(echo "$MACHINE_SEARCH" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$MACHINE_USER_ID" ]; then
  echo "Creating machine user '${MACHINE_USERNAME}'..." >&2
  MACHINE_RESPONSE=$(zitadel_api POST "/management/v1/users/machine" \
    "{\"userName\":\"${MACHINE_USERNAME}\",\"name\":\"Deployer CLI\",\"accessTokenType\":\"ACCESS_TOKEN_TYPE_JWT\"}")
  MACHINE_USER_ID=$(echo "$MACHINE_RESPONSE" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$MACHINE_USER_ID" ]; then
    echo "ERROR: Failed to create machine user '${MACHINE_USERNAME}'" >&2
    echo "Response: ${MACHINE_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created machine user with ID ${MACHINE_USER_ID}" >&2
else
  echo "Found machine user with ID ${MACHINE_USER_ID}" >&2
fi

# Generate (or rotate) the client secret. PUT /secret returns clientId+clientSecret.
# On re-runs this rotates the secret — fine, since deployer-oidc.json is the
# single source of truth and gets overwritten below.
echo "Generating client secret for machine user..." >&2
MACHINE_SECRET_RESPONSE=$(zitadel_api PUT "/management/v1/users/${MACHINE_USER_ID}/secret")
MACHINE_CLIENT_ID=$(echo "$MACHINE_SECRET_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
MACHINE_CLIENT_SECRET=$(echo "$MACHINE_SECRET_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$MACHINE_CLIENT_ID" ] || [ -z "$MACHINE_CLIENT_SECRET" ]; then
  echo "ERROR: Failed to generate machine user secret" >&2
  echo "Response: ${MACHINE_SECRET_RESPONSE}" >&2
  echo '[]'
  exit 1
fi

# Grant the project's "admin" role so the JWT carries
# urn:zitadel:iam:org:project:${PROJECT_ID}:roles.admin — the deployer's
# auth middleware (webapp-auth-middleware.mts) requires this role.
# Idempotent: 409/AlreadyExists on re-run is fine.
echo "Granting 'admin' role on project ${PROJECT_ID} to machine user..." >&2
zitadel_api POST "/management/v1/users/${MACHINE_USER_ID}/grants" \
  "{\"projectId\":\"${PROJECT_ID}\",\"roleKeys\":[\"admin\"]}" >/dev/null 2>&1 || true

# --- 5. Store credentials in bootstrap volume ---
# Schema:
#   client_id/client_secret           — Web app (browser auth_code flow)
#   machine_client_id/machine_client_secret — Machine user (CLI client_credentials)
echo "Storing credentials in ${CRED_FILE}..." >&2
cat > "$CRED_FILE" <<ENDOFCRED
{
  "issuer_url": "${ISSUER_URL}",
  "project_id": "${PROJECT_ID}",
  "client_id": "${CLIENT_ID}",
  "client_secret": "${CLIENT_SECRET}",
  "machine_client_id": "${MACHINE_CLIENT_ID}",
  "machine_client_secret": "${MACHINE_CLIENT_SECRET}"
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
  {"id": "oidc_client_secret", "value": "${CLIENT_SECRET}"},
  {"id": "oidc_machine_client_id", "value": "${MACHINE_CLIENT_ID}"},
  {"id": "oidc_machine_client_secret", "value": "${MACHINE_CLIENT_SECRET}"}
]
ENDOFOUTPUT
