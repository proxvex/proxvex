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
#   oidc_project_name  - Zitadel project name (from addon parameter, defaults to hostname)
#   oidc_issuer_url    - External issuer URL override (optional, defaults to internal Zitadel URL)
#
# Outputs (JSON to stdout):
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret

ZITADEL_HOST="{{ ZITADEL_HOST }}"
ZITADEL_PROTO_INPUT="{{ ZITADEL_PROTO }}"
ZITADEL_PORT_INPUT="{{ ZITADEL_PORT }}"
HOSTNAME="{{ hostname }}"
OIDC_APP_NAME="{{ oidc_app_name }}"
OIDC_CALLBACK_PATH="{{ oidc_callback_path }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
OIDC_PROJECT_NAME="{{ oidc_project_name }}"
OIDC_ISSUER_URL_INPUT="{{ oidc_issuer_url }}"
SSL_MODE="{{ ssl_mode }}"

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

# Build Zitadel internal API URL from provides (proto, port) + hostname
# Provides may use hostname-based prefix (ZITADEL_PROTO or ZITADEL_SSL_PROTO)
# depending on whether the Zitadel instance has SSL enabled
ZITADEL_PROTO="http"
ZITADEL_PORT="8080"
ZITADEL_SSL_PROTO_INPUT="{{ ZITADEL_SSL_PROTO }}"
ZITADEL_SSL_PORT_INPUT="{{ ZITADEL_SSL_PORT }}"
# Try standard provides first, then SSL-variant provides
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

# Use provided issuer URL if set, otherwise default to Zitadel URL
if [ -n "$OIDC_ISSUER_URL_INPUT" ] && [ "$OIDC_ISSUER_URL_INPUT" != "NOT_DEFINED" ]; then
  ISSUER_URL="$OIDC_ISSUER_URL_INPUT"
else
  ISSUER_URL="${ZITADEL_URL}"
fi

# --- Check for pre-provisioned credentials ---
# If the Zitadel bootstrap (340) already created an OIDC app for this application,
# the credentials are stored in deployer-oidc.json. Use them directly without API access.
DEPLOYER_CRED_FILE="$(resolve_host_volume "$ZITADEL_HOST" "bootstrap")/deployer-oidc.json"
if [ -f "$DEPLOYER_CRED_FILE" ] && [ "$OIDC_APP_NAME" = "oci-lxc-deployer" ]; then
  echo "Using pre-provisioned credentials from ${DEPLOYER_CRED_FILE}" >&2
  CRED_ISSUER=$(sed -n 's/.*"issuer_url": *"\([^"]*\)".*/\1/p' "$DEPLOYER_CRED_FILE")
  CRED_CLIENT_ID=$(sed -n 's/.*"client_id": *"\([^"]*\)".*/\1/p' "$DEPLOYER_CRED_FILE")
  CRED_CLIENT_SECRET=$(sed -n 's/.*"client_secret": *"\([^"]*\)".*/\1/p' "$DEPLOYER_CRED_FILE")
  if [ -n "$CRED_CLIENT_ID" ] && [ -n "$CRED_CLIENT_SECRET" ]; then
    echo "OIDC client setup complete (pre-provisioned)" >&2
    echo "  Issuer URL: ${CRED_ISSUER}" >&2
    echo "  Client ID:  ${CRED_CLIENT_ID}" >&2
    cat <<ENDOFOUTPUT
[
  {"id": "oidc_issuer_url", "value": "${CRED_ISSUER}"},
  {"id": "oidc_client_id", "value": "${CRED_CLIENT_ID}"},
  {"id": "oidc_client_secret", "value": "${CRED_CLIENT_SECRET}"}
]
ENDOFOUTPUT
    exit 0
  fi
  echo "WARNING: Pre-provisioned credentials incomplete, falling back to API" >&2
fi

# --- Read PAT ---
# Priority: 1) Template variable (injected by backend in zero-secret mode)
#           2) File on PVE host (legacy mode)
ZITADEL_PAT_INPUT="{{ ZITADEL_PAT }}"
PAT=""

if [ -n "$ZITADEL_PAT_INPUT" ] && [ "$ZITADEL_PAT_INPUT" != "NOT_DEFINED" ]; then
  PAT="$ZITADEL_PAT_INPUT"
  echo "PAT provided via template variable (zero-secret mode)" >&2
else
  PAT_FILE="$(resolve_host_volume "$ZITADEL_HOST" "bootstrap")/admin-client.pat"
  if [ -f "$PAT_FILE" ]; then
    PAT=$(cat "$PAT_FILE")
    if [ -n "$PAT" ]; then
      echo "PAT loaded from ${PAT_FILE} (legacy mode)" >&2
    fi
  fi
fi

if [ -z "$PAT" ]; then
  echo "ERROR: No Zitadel PAT available." >&2
  echo "Either ZITADEL_PAT must be set or admin-client.pat must exist at:" >&2
  echo "  $(resolve_host_volume "$ZITADEL_HOST" "bootstrap")/admin-client.pat" >&2
  echo '[]'
  exit 1
fi

echo "Using Zitadel at ${ZITADEL_URL}" >&2

# --- Wait for Zitadel ready ---
echo "Waiting for Zitadel to be ready..." >&2
RETRIES=60
while [ $RETRIES -gt 0 ]; do
  _ready_host_hdr=""
  if [ -n "$ZITADEL_HOST_HEADER" ]; then _ready_host_hdr="-H Host:${ZITADEL_HOST_HEADER}"; fi
  STATUS=$(curl -sk -o /dev/null -w "%{http_code}" $_ready_host_hdr "${ZITADEL_URL}/debug/ready" 2>/dev/null)
  if [ "$STATUS" = "200" ]; then
    echo "Zitadel is ready" >&2
    break
  fi
  # 301/302 means Traefik is redirecting HTTP→HTTPS — extract target from Location header
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
# Uses Host header matching Zitadel's ExternalDomain when connecting via internal URL
ZITADEL_HOST_HEADER=""
if [ -n "$ISSUER_URL" ] && [ "$ISSUER_URL" != "$ZITADEL_URL" ]; then
  # Extract hostname from issuer URL for Host header
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

# --- Create roles from oidc_roles (skip all if any exist) ---
OIDC_ROLES='{{ oidc_roles }}'
if [ -n "$OIDC_ROLES" ] && [ "$OIDC_ROLES" != "NOT_DEFINED" ]; then
  ROLES_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles/_search" "{}")
  EXISTING_ROLE=$(echo "$ROLES_RESPONSE" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p' | head -1)

  if [ -z "$EXISTING_ROLE" ]; then
    echo "Creating roles from oidc_roles..." >&2
    # Parse JSON array: extract each object and create role
    echo "$OIDC_ROLES" | sed 's/^\[//;s/\]$//;s/},{/}\n{/g' | while IFS= read -r role; do
      [ -z "$role" ] && continue
      ROLE_KEY=$(echo "$role" | sed -n 's/.*"key" *: *"\([^"]*\)".*/\1/p')
      ROLE_DISPLAY=$(echo "$role" | sed -n 's/.*"display_name" *: *"\([^"]*\)".*/\1/p')
      ROLE_GROUP=$(echo "$role" | sed -n 's/.*"group" *: *"\([^"]*\)".*/\1/p')
      if [ -n "$ROLE_KEY" ] && [ -n "$ROLE_DISPLAY" ]; then
        ROLE_BODY="{\"roleKey\":\"${ROLE_KEY}\",\"displayName\":\"${ROLE_DISPLAY}\"}"
        [ -n "$ROLE_GROUP" ] && ROLE_BODY="{\"roleKey\":\"${ROLE_KEY}\",\"displayName\":\"${ROLE_DISPLAY}\",\"group\":\"${ROLE_GROUP}\"}"
        zitadel_api POST "/management/v1/projects/${PROJECT_ID}/roles" "$ROLE_BODY" >/dev/null 2>&1
        echo "  Created role: ${ROLE_KEY}" >&2
      fi
    done
  else
    echo "Roles already exist (found: ${EXISTING_ROLE}), skipping role creation" >&2
  fi
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

  # Detect protocol based on SSL addon
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

# --- Client secret handling (create-only: never regenerate for existing apps) ---
OIDC_CRED_FILE="$(resolve_host_volume "$ZITADEL_HOST" "bootstrap")/${OIDC_APP_NAME}.oidc.json"

if [ -z "$CLIENT_SECRET" ]; then
  # Try to read from stored credentials first (create-only: don't regenerate)
  if [ -f "$OIDC_CRED_FILE" ]; then
    CLIENT_SECRET=$(sed -n 's/.*"client_secret" *: *"\([^"]*\)".*/\1/p' "$OIDC_CRED_FILE")
    if [ -n "$CLIENT_SECRET" ]; then
      echo "Client secret loaded from stored credentials" >&2
    fi
  fi
fi

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

# Store credentials for future create-only access
if [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  CRED_DIR=$(dirname "$OIDC_CRED_FILE")
  if [ -d "$CRED_DIR" ]; then
    cat > "$OIDC_CRED_FILE" <<ENDOFCRED
{
  "client_id": "${CLIENT_ID}",
  "client_secret": "${CLIENT_SECRET}",
  "project_id": "${PROJECT_ID}"
}
ENDOFCRED
    chmod 0600 "$OIDC_CRED_FILE"
    echo "Credentials stored at ${OIDC_CRED_FILE}" >&2
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
