#!/bin/sh
# Bootstrap Zitadel project for oci-lxc-deployer
#
# One-time initialization: Creates a Zitadel project, service account,
# OIDC app, and assigns PROJECT_OWNER role. Invalidates the admin PAT
# as the very last step (zero-persistent-secret design).
#
# Runs on PVE host (execute_on: ve).
#
# Inputs (template variables):
#   ZITADEL_HOST           - Hostname of the Zitadel container
#   hostname               - Hostname of this PVE node (used for project name)
#   shared_volpath         - Shared volume path on PVE host
#   domain_suffix          - Domain suffix for URL construction
#   oidc_issuer_url        - External issuer URL override (optional)
#   oidc_callback_path     - OIDC callback path (default: /api/auth/callback)
#   ssl_mode               - SSL mode for protocol detection
#
# Outputs (JSON to stdout):
#   oidc_issuer_url           - Zitadel issuer URL
#   oidc_client_id            - OIDC client ID
#   oidc_client_secret        - OIDC client secret
#   zitadel_svc_client_id     - Service account client ID
#   zitadel_svc_client_secret - Service account client secret
#   zitadel_project_id        - Zitadel project ID

ZITADEL_HOST="{{ ZITADEL_HOST }}"
ZITADEL_PROTO_INPUT="{{ ZITADEL_PROTO }}"
ZITADEL_PORT_INPUT="{{ ZITADEL_PORT }}"
HOSTNAME="{{ hostname }}"
SHARED_VOLPATH="{{ shared_volpath }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
OIDC_ISSUER_URL_INPUT="{{ oidc_issuer_url }}"
OIDC_CALLBACK_PATH="{{ oidc_callback_path }}"
SSL_MODE="{{ ssl_mode }}"

# Guard against NOT_DEFINED
if [ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ]; then DOMAIN_SUFFIX=""; fi
if [ "$OIDC_CALLBACK_PATH" = "NOT_DEFINED" ]; then OIDC_CALLBACK_PATH="/api/auth/callback"; fi

# Default callback path
if [ -z "$OIDC_CALLBACK_PATH" ]; then
  OIDC_CALLBACK_PATH="/api/auth/callback"
fi

PROJECT_NAME="pve-${HOSTNAME}"
SVC_USERNAME="deployer-svc-${HOSTNAME}"

# --- Build Zitadel URL ---
ZITADEL_PROTO="http"
ZITADEL_PORT="8080"
ZITADEL_SSL_PROTO_INPUT="{{ ZITADEL_SSL_PROTO }}"
ZITADEL_SSL_PORT_INPUT="{{ ZITADEL_SSL_PORT }}"
if [ -n "$ZITADEL_PROTO_INPUT" ] && [ "$ZITADEL_PROTO_INPUT" != "NOT_DEFINED" ]; then
  ZITADEL_PROTO="$ZITADEL_PROTO_INPUT"
elif [ -n "$ZITADEL_SSL_PROTO_INPUT" ] && [ "$ZITADEL_SSL_PROTO_INPUT" != "NOT_DEFINED" ]; then
  ZITADEL_PROTO="$ZITADEL_SSL_PROTO_INPUT"
fi
if [ -n "$ZITADEL_PORT_INPUT" ] && [ "$ZITADEL_PORT_INPUT" != "NOT_DEFINED" ]; then
  ZITADEL_PORT="$ZITADEL_PORT_INPUT"
elif [ -n "$ZITADEL_SSL_PORT_INPUT" ] && [ "$ZITADEL_SSL_PORT_INPUT" != "NOT_DEFINED" ]; then
  ZITADEL_PORT="$ZITADEL_SSL_PORT_INPUT"
fi
ZITADEL_URL="${ZITADEL_PROTO}://${ZITADEL_HOST}:${ZITADEL_PORT}"

# Issuer URL
if [ -n "$OIDC_ISSUER_URL_INPUT" ] && [ "$OIDC_ISSUER_URL_INPUT" != "NOT_DEFINED" ]; then
  ISSUER_URL="$OIDC_ISSUER_URL_INPUT"
else
  ISSUER_URL="${ZITADEL_URL}"
fi

# --- Read admin PAT from bootstrap volume ---
PAT_FILE="$(resolve_host_volume "$SHARED_VOLPATH" "$ZITADEL_HOST" "bootstrap")/admin-client.pat"

if [ ! -f "$PAT_FILE" ]; then
  echo "ERROR: Admin PAT file not found at ${PAT_FILE}" >&2
  echo '[]'
  exit 1
fi

PAT=$(cat "$PAT_FILE")
if [ -z "$PAT" ]; then
  echo "ERROR: Admin PAT file is empty (already bootstrapped?)" >&2
  echo '[]'
  exit 1
fi

echo "Bootstrap: Using Zitadel at ${ZITADEL_URL}" >&2
echo "Bootstrap: Project name: ${PROJECT_NAME}" >&2

# --- Wait for Zitadel ready ---
echo "Waiting for Zitadel to be ready..." >&2
RETRIES=60
while [ $RETRIES -gt 0 ]; do
  _ready_host_hdr=""
  ZITADEL_HOST_HEADER=""
  if [ -n "$ISSUER_URL" ] && [ "$ISSUER_URL" != "$ZITADEL_URL" ]; then
    ZITADEL_HOST_HEADER=$(echo "$ISSUER_URL" | sed 's|https\?://||; s|/.*||; s|:.*||')
    _ready_host_hdr="-H Host:${ZITADEL_HOST_HEADER}"
  fi
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" $_ready_host_hdr "${ZITADEL_URL}/debug/ready" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "Zitadel is ready" >&2
    break
  fi
  if [ "$STATUS" = "301" ] || [ "$STATUS" = "302" ]; then
    REDIRECT_LOC=$(curl -sk -D - -o /dev/null $_ready_host_hdr "${ZITADEL_URL}/debug/ready" 2>/dev/null | grep -i "^location:" | tr -d '\r')
    REDIRECT_PORT=$(echo "$REDIRECT_LOC" | sed -n 's|.*://[^:/]*:\([0-9]*\).*|\1|p')
    ZITADEL_PROTO="https"
    [ -n "$REDIRECT_PORT" ] && ZITADEL_PORT="$REDIRECT_PORT"
    ZITADEL_URL="${ZITADEL_PROTO}://${ZITADEL_HOST}:${ZITADEL_PORT}"
    echo "Detected redirect, switching to ${ZITADEL_URL}" >&2
    continue
  fi
  RETRIES=$((RETRIES - 1))
  echo "Zitadel not ready yet (HTTP ${STATUS}), retrying... (${RETRIES} left)" >&2
  sleep 2
done

if [ $RETRIES -eq 0 ]; then
  echo "ERROR: Zitadel did not become ready" >&2
  echo '[]'
  exit 1
fi

# --- Helper: API call ---
ZITADEL_HOST_HEADER=""
if [ -n "$ISSUER_URL" ] && [ "$ISSUER_URL" != "$ZITADEL_URL" ]; then
  ZITADEL_HOST_HEADER=$(echo "$ISSUER_URL" | sed 's|https\?://||; s|/.*||; s|:.*||')
fi

zitadel_api() {
  _method="$1"
  _path="$2"
  _body="$3"
  _host_hdr=""
  if [ -n "$ZITADEL_HOST_HEADER" ]; then
    _host_hdr="-H Host:${ZITADEL_HOST_HEADER}"
  fi

  if [ -n "$_body" ]; then
    curl -skL -X "$_method" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      $_host_hdr \
      -d "$_body" \
      "${ZITADEL_URL}${_path}" 2>/dev/null
  else
    curl -skL -X "$_method" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      $_host_hdr \
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
    echo "Response: ${CREATE_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created project '${PROJECT_NAME}' with ID ${PROJECT_ID}" >&2
else
  echo "Found project '${PROJECT_NAME}' with ID ${PROJECT_ID}" >&2
  # Ensure projectRoleAssertion is enabled
  zitadel_api PUT "/management/v1/projects/${PROJECT_ID}" \
    "{\"name\":\"${PROJECT_NAME}\",\"projectRoleAssertion\":true}" >/dev/null
fi

# --- 2. Create roles ---
echo "Creating roles on project..." >&2
zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles" \
  "{\"roleKey\":\"PROJECT_OWNER\",\"displayName\":\"Project Owner\"}" >/dev/null 2>&1
zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles" \
  "{\"roleKey\":\"ORG_OWNER\",\"displayName\":\"Organization Owner\"}" >/dev/null 2>&1
echo "Roles ensured: PROJECT_OWNER, ORG_OWNER" >&2

# --- 3. Find or create service account ---
echo "Searching for service account '${SVC_USERNAME}'..." >&2
SVC_RESPONSE=$(zitadel_api POST "/management/v1/users/_search" \
  "{\"queries\":[{\"userNameQuery\":{\"userName\":\"${SVC_USERNAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

SVC_USER_ID=$(echo "$SVC_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
SVC_CLIENT_ID=""
SVC_CLIENT_SECRET=""

if [ -z "$SVC_USER_ID" ]; then
  echo "Creating service account '${SVC_USERNAME}'..." >&2
  CREATE_SVC_RESPONSE=$(zitadel_api POST "/v2/users/machine" \
    "{\"userName\":\"${SVC_USERNAME}\",\"name\":\"Deployer Service Account (${HOSTNAME})\",\"accessTokenType\":\"ACCESS_TOKEN_TYPE_JWT\"}")
  SVC_USER_ID=$(echo "$CREATE_SVC_RESPONSE" | sed -n 's/.*"userId":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$SVC_USER_ID" ]; then
    echo "ERROR: Failed to create service account" >&2
    echo "Response: ${CREATE_SVC_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created service account with ID ${SVC_USER_ID}" >&2
else
  echo "Found service account '${SVC_USERNAME}' with ID ${SVC_USER_ID}" >&2
fi

# --- 4. Generate client credentials for service account ---
echo "Generating client credentials..." >&2
CRED_RESPONSE=$(zitadel_api PUT "/v2/users/${SVC_USER_ID}/secret" "{}")
SVC_CLIENT_ID=$(echo "$CRED_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
SVC_CLIENT_SECRET=$(echo "$CRED_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$SVC_CLIENT_ID" ] || [ -z "$SVC_CLIENT_SECRET" ]; then
  echo "ERROR: Failed to generate client credentials" >&2
  echo "Response: ${CRED_RESPONSE}" >&2
  echo '[]'
  exit 1
fi
echo "Client credentials generated" >&2

# --- 5. Grant PROJECT_OWNER role to service account ---
echo "Granting PROJECT_OWNER to service account..." >&2
GRANT_RESPONSE=$(zitadel_api POST "/management/v1/users/${SVC_USER_ID}/grants" \
  "{\"projectId\":\"${PROJECT_ID}\",\"roleKeys\":[\"PROJECT_OWNER\"]}")
echo "Role granted" >&2

# --- 6. Create OIDC app (same as conf-setup-oidc-client.sh) ---
OIDC_APP_NAME="${HOSTNAME}"
echo "Searching for OIDC app '${OIDC_APP_NAME}' in project ${PROJECT_ID}..." >&2
APP_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${OIDC_APP_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

APP_ID=$(echo "$APP_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
CLIENT_ID=""
CLIENT_SECRET=""

if [ -z "$APP_ID" ]; then
  echo "Creating OIDC app '${OIDC_APP_NAME}'..." >&2
  PROTOCOL="http"
  if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "NOT_DEFINED" ] && [ "$SSL_MODE" != "none" ]; then
    PROTOCOL="https"
  fi
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

# Generate client secret if needed
if [ -z "$CLIENT_SECRET" ]; then
  echo "Generating client secret for app ${APP_ID}..." >&2
  SECRET_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/${APP_ID}/oidc_config/_generate_client_secret" "{}")
  CLIENT_SECRET=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$CLIENT_SECRET" ]; then
    echo "ERROR: Failed to generate client secret" >&2
    echo '[]'
    exit 1
  fi
fi

# --- 7. Invalidate admin PAT (LAST STEP!) ---
echo "Invalidating admin PAT..." >&2

# Find admin-client user
ADMIN_RESPONSE=$(zitadel_api POST "/management/v1/users/_search" \
  "{\"queries\":[{\"userNameQuery\":{\"userName\":\"admin-client\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")
ADMIN_USER_ID=$(echo "$ADMIN_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -n "$ADMIN_USER_ID" ]; then
  # List and delete all PATs for admin-client
  PAT_LIST=$(zitadel_api POST "/management/v1/users/${ADMIN_USER_ID}/pats/_search" "{}")
  # Extract all PAT IDs
  PAT_IDS=$(echo "$PAT_LIST" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

  for pat_id in $PAT_IDS; do
    echo "  Deleting PAT ${pat_id}..." >&2
    zitadel_api DELETE "/management/v1/users/${ADMIN_USER_ID}/pats/${pat_id}" >/dev/null 2>&1
  done
  echo "Admin PAT invalidated" >&2
else
  echo "WARNING: admin-client user not found, PAT may already be invalidated" >&2
fi

# --- Output ---
echo "Bootstrap complete" >&2
cat <<ENDOFOUTPUT
[
  {"id": "oidc_issuer_url", "value": "${ISSUER_URL}"},
  {"id": "oidc_client_id", "value": "${CLIENT_ID}"},
  {"id": "oidc_client_secret", "value": "${CLIENT_SECRET}"},
  {"id": "zitadel_svc_client_id", "value": "${SVC_CLIENT_ID}"},
  {"id": "zitadel_svc_client_secret", "value": "${SVC_CLIENT_SECRET}"},
  {"id": "zitadel_project_id", "value": "${PROJECT_ID}"}
]
ENDOFOUTPUT
