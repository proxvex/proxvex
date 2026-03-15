#!/bin/sh
# Setup OIDC client in Zitadel
#
# Creates or retrieves an OIDC client application in Zitadel.
# Runs on PVE host (execute_on: ve).
#
# Inputs (template variables):
#   ZITADEL_HOST       - Hostname of the Zitadel container
#   hostname           - Hostname of the application container
#   shared_volpath     - Shared volume path on PVE host
#   oidc_app_name      - Name of the OIDC app in Zitadel (optional, defaults to hostname)
#   oidc_callback_path - OIDC callback path (default: /auth/strategy/callback)
#   domain_suffix      - Domain suffix for URL construction
#   OIDC_PROJECT_NAME  - Zitadel project name (from addon parameter, defaults to hostname)
#
# Outputs (JSON to stdout):
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret

ZITADEL_HOST="{{ ZITADEL_HOST }}"
HOSTNAME="{{ hostname }}"
SHARED_VOLPATH="{{ shared_volpath }}"
OIDC_APP_NAME="{{ oidc_app_name }}"
OIDC_CALLBACK_PATH="{{ oidc_callback_path }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
OIDC_PROJECT_NAME="{{ OIDC_PROJECT_NAME }}"

# Guard against NOT_DEFINED
if [ "$DOMAIN_SUFFIX" = "NOT_DEFINED" ]; then DOMAIN_SUFFIX=""; fi
if [ "$OIDC_APP_NAME" = "NOT_DEFINED" ]; then OIDC_APP_NAME=""; fi
if [ "$OIDC_PROJECT_NAME" = "NOT_DEFINED" ]; then OIDC_PROJECT_NAME=""; fi

# Default project name to hostname if not set
if [ -z "$OIDC_PROJECT_NAME" ]; then
  OIDC_PROJECT_NAME="$HOSTNAME"
fi

# Default app name to hostname if not set
if [ -z "$OIDC_APP_NAME" ]; then
  OIDC_APP_NAME="$HOSTNAME"
fi

ZITADEL_URL="http://${ZITADEL_HOST}${DOMAIN_SUFFIX}:8080"
ISSUER_URL="${ZITADEL_URL}"

# --- Read PAT ---
# NOTE: PAT path is an open issue. Zitadel writes the PAT to the container's
# docker-compose working directory, which is NOT mapped to a PVE-host volume.
# This needs to be fixed in the Zitadel docker-compose configuration first.
# For now, we look in the expected volume path.
PAT_FILE="${SHARED_VOLPATH}/volumes/${ZITADEL_HOST}/bootstrap/admin-client.pat"

if [ ! -f "$PAT_FILE" ]; then
  echo "ERROR: PAT file not found at ${PAT_FILE}" >&2
  echo "Zitadel PAT must be accessible from PVE host." >&2
  echo "Check that the Zitadel docker-compose maps the PAT directory as a volume." >&2
  echo '[]'
  exit 1
fi

PAT=$(cat "$PAT_FILE")
if [ -z "$PAT" ]; then
  echo "ERROR: PAT file is empty" >&2
  echo '[]'
  exit 1
fi

echo "Using Zitadel at ${ZITADEL_URL}" >&2
echo "PAT loaded from ${PAT_FILE}" >&2

# --- Wait for Zitadel ready ---
echo "Waiting for Zitadel to be ready..." >&2
RETRIES=30
while [ $RETRIES -gt 0 ]; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${ZITADEL_URL}/debug/ready" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "Zitadel is ready" >&2
    break
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
zitadel_api() {
  _method="$1"
  _path="$2"
  _body="$3"

  if [ -n "$_body" ]; then
    curl -s -X "$_method" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      -d "$_body" \
      "${ZITADEL_URL}${_path}" 2>/dev/null
  else
    curl -s -X "$_method" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      "${ZITADEL_URL}${_path}" 2>/dev/null
  fi
}

# --- Find or create project ---
echo "Searching for project '${OIDC_PROJECT_NAME}'..." >&2
PROJECT_RESPONSE=$(zitadel_api POST "/management/v1/projects/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${OIDC_PROJECT_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$PROJECT_ID" ]; then
  echo "Project not found, creating '${OIDC_PROJECT_NAME}'..." >&2
  CREATE_RESPONSE=$(zitadel_api POST "/management/v1/projects" \
    "{\"name\":\"${OIDC_PROJECT_NAME}\"}")
  PROJECT_ID=$(echo "$CREATE_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$PROJECT_ID" ]; then
    echo "ERROR: Failed to create project" >&2
    echo "Response: ${CREATE_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created project '${OIDC_PROJECT_NAME}' with ID ${PROJECT_ID}" >&2
else
  echo "Found project '${OIDC_PROJECT_NAME}' with ID ${PROJECT_ID}" >&2
fi

# --- Find or create OIDC app ---
echo "Searching for OIDC app '${OIDC_APP_NAME}' in project ${PROJECT_ID}..." >&2
APP_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${OIDC_APP_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

APP_ID=$(echo "$APP_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
CLIENT_ID=""
CLIENT_SECRET=""

if [ -z "$APP_ID" ]; then
  echo "OIDC app not found, creating '${OIDC_APP_NAME}'..." >&2

  CALLBACK_URL="http://${HOSTNAME}${DOMAIN_SUFFIX}${OIDC_CALLBACK_PATH}"
  LOGOUT_URL="http://${HOSTNAME}${DOMAIN_SUFFIX}"

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
  echo "Created OIDC app '${OIDC_APP_NAME}' with ID ${APP_ID}" >&2
else
  echo "Found OIDC app '${OIDC_APP_NAME}' with ID ${APP_ID}" >&2
  # Extract clientId from the existing app's oidcConfig
  CLIENT_ID=$(echo "$APP_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
fi

if [ -z "$CLIENT_ID" ]; then
  echo "ERROR: Could not determine client ID" >&2
  echo '[]'
  exit 1
fi

# --- Generate client secret (only needed for existing apps) ---
if [ -z "$CLIENT_SECRET" ]; then
  echo "Generating client secret for app ${APP_ID}..." >&2
  SECRET_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/${APP_ID}/oidc_config/_generate_client_secret" "{}")

  CLIENT_SECRET=$(echo "$SECRET_RESPONSE" | sed -n 's/.*"clientSecret":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$CLIENT_SECRET" ]; then
    echo "ERROR: Failed to generate client secret" >&2
    echo "Response: ${SECRET_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
fi

echo "OIDC client setup complete" >&2
echo "  Issuer URL: ${ISSUER_URL}" >&2
echo "  Client ID:  ${CLIENT_ID}" >&2

# --- Output ---
cat <<ENDOFOUTPUT
[
  {"id": "oidc_issuer_url", "value": "${ISSUER_URL}"},
  {"id": "oidc_client_id", "value": "${CLIENT_ID}"},
  {"id": "oidc_client_secret", "value": "${CLIENT_SECRET}"}
]
ENDOFOUTPUT
