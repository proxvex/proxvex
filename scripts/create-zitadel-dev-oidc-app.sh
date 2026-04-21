#!/bin/sh
# Create (or reuse) a Zitadel OIDC app for local dev and — optionally — a
# human user with ORG_OWNER + project-admin grants. Prints a VSCode
# launch-config entry ready to paste into oci-lxc-deployer-green.code-workspace.
#
# The admin PAT is fetched via SSH from the PVE host that runs the Zitadel
# LXC (reads /rpool/data/subvol-*-zitadel-bootstrap/admin-client.pat).
#
# Re-runs are idempotent: if the app already exists the client_id is returned
# from Zitadel; the client_secret can only be retrieved at creation time — if
# you need a new secret, delete the app in the Zitadel console first. Same
# pattern for users: existing users are detected and role grants are ensured.
#
# Requirements on the local machine:
#   - ssh (key-based login to ${PVE_HOST})
#   - curl, sed, openssl
#
# Usage:
#   # defaults — creates app + test user (username=test / password=Test123!)
#   ./scripts/create-zitadel-dev-oidc-app.sh
#
#   # with custom user:
#   DEV_USERNAME=volkmar DEV_EMAIL=volkmar@ohnewarum.de \
#     ./scripts/create-zitadel-dev-oidc-app.sh
#
#   # skip user creation entirely:
#   DEV_USERNAME= ./scripts/create-zitadel-dev-oidc-app.sh
#
# Environment overrides:
#   PVE_HOST          default: pve1.cluster
#   ZITADEL_URL       default: https://auth.ohnewarum.de
#   PROJECT_NAME      default: oci-lxc-deployer
#   OIDC_APP_NAME     default: oci-lxc-deployer-dev
#   CALLBACK_URL      default: http://localhost:3201/api/auth/callback
#   POST_LOGOUT_URL   default: http://localhost:4301
#   PAT_GLOB          default: /rpool/data/subvol-*-zitadel-bootstrap/admin-client.pat
#   ADMIN_PAT         if set, SSH lookup is skipped
#
# User creation (skip by setting DEV_USERNAME= i.e. empty):
#   DEV_USERNAME      default: test
#   DEV_EMAIL         default: ${DEV_USERNAME}@example.com (email is marked verified)
#   DEV_PASSWORD      default: Test123!
#   DEV_FIRSTNAME     default: Dev
#   DEV_LASTNAME      default: Admin
#   PROJECT_ROLE      default: admin (role key that exists on PROJECT_NAME)
#   ORG_ROLES         default: ORG_OWNER (space-separated list)

set -eu

PVE_HOST="${PVE_HOST:-pve1.cluster}"
ZITADEL_URL="${ZITADEL_URL:-https://auth.ohnewarum.de}"
PROJECT_NAME="${PROJECT_NAME:-oci-lxc-deployer}"
OIDC_APP_NAME="${OIDC_APP_NAME:-oci-lxc-deployer-dev}"
CALLBACK_URL="${CALLBACK_URL:-http://localhost:3201/api/auth/callback}"
POST_LOGOUT_URL="${POST_LOGOUT_URL:-http://localhost:4301}"
PAT_GLOB="${PAT_GLOB:-/rpool/data/subvol-*-zitadel-bootstrap/admin-client.pat}"

PROJECT_ROLE="${PROJECT_ROLE:-admin}"
ORG_ROLES="${ORG_ROLES:-ORG_OWNER}"

log() { echo ">> $*" >&2; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- 1. Fetch admin PAT ---
if [ -n "${ADMIN_PAT:-}" ]; then
  log "Using ADMIN_PAT from environment (${#ADMIN_PAT} chars)"
else
  log "Fetching admin PAT from ${PVE_HOST} (${PAT_GLOB}) ..."
  ADMIN_PAT=$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes "root@${PVE_HOST}" \
    "ls ${PAT_GLOB} 2>/dev/null | head -1 | xargs -r cat" 2>/dev/null || true)
  if [ -z "$ADMIN_PAT" ]; then
    die "Admin PAT not found on ${PVE_HOST} at ${PAT_GLOB}. Either the Zitadel container was already hardened (PAT removed) or the path is different — set PAT_GLOB or pass an existing PAT via ADMIN_PAT env var."
  fi
  log "   PAT obtained (${#ADMIN_PAT} chars)"
fi

zitadel_api() {
  _method="$1"
  _path="$2"
  _body="${3:-}"
  if [ -n "$_body" ]; then
    curl -sS -X "$_method" \
      -H "Authorization: Bearer ${ADMIN_PAT}" \
      -H "Content-Type: application/json" \
      -d "$_body" \
      "${ZITADEL_URL}${_path}"
  else
    curl -sS -X "$_method" \
      -H "Authorization: Bearer ${ADMIN_PAT}" \
      -H "Content-Type: application/json" \
      "${ZITADEL_URL}${_path}"
  fi
}

json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

# --- 2. Find project ---
log "Searching for project '${PROJECT_NAME}' ..."
PROJECT_RESPONSE=$(zitadel_api POST "/management/v1/projects/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${PROJECT_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")
PROJECT_ID=$(echo "$PROJECT_RESPONSE" | json_field id)
[ -n "$PROJECT_ID" ] || die "Project '${PROJECT_NAME}' not found. Response: ${PROJECT_RESPONSE}"
log "   Project ID: ${PROJECT_ID}"

# --- 3. Check if OIDC app exists ---
log "Searching for OIDC app '${OIDC_APP_NAME}' ..."
APP_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${OIDC_APP_NAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")
APP_ID=$(echo "$APP_RESPONSE" | json_field id)

if [ -n "$APP_ID" ]; then
  CLIENT_ID=$(echo "$APP_RESPONSE" | json_field clientId)
  log "   App exists (ID=${APP_ID}, client_id=${CLIENT_ID})"
  log "   Zitadel only shows client_secret at creation — regenerate in the console if you need it."
  CLIENT_SECRET="<regenerate-in-zitadel-console>"
else
  # --- 4. Create OIDC app ---
  log "Creating OIDC app '${OIDC_APP_NAME}' ..."
  CREATE_PAYLOAD=$(cat <<PAYLOAD
{
  "name": "${OIDC_APP_NAME}",
  "redirectUris": ["${CALLBACK_URL}"],
  "responseTypes": ["OIDC_RESPONSE_TYPE_CODE"],
  "grantTypes": ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
  "appType": "OIDC_APP_TYPE_WEB",
  "authMethodType": "OIDC_AUTH_METHOD_TYPE_BASIC",
  "postLogoutRedirectUris": ["${POST_LOGOUT_URL}"],
  "devMode": true
}
PAYLOAD
)
  CREATE_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/oidc" "$CREATE_PAYLOAD")
  APP_ID=$(echo "$CREATE_RESPONSE" | json_field appId)
  CLIENT_ID=$(echo "$CREATE_RESPONSE" | json_field clientId)
  CLIENT_SECRET=$(echo "$CREATE_RESPONSE" | json_field clientSecret)
  if [ -z "$APP_ID" ] || [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
    die "Failed to create app. Response: ${CREATE_RESPONSE}"
  fi
  log "   App ID:       ${APP_ID}"
  log "   Client ID:    ${CLIENT_ID}"
  log "   Client Secret captured (shown below; Zitadel won't show it again)"
fi

# --- 5. Optional: create dev user (default on; set DEV_USERNAME= to skip) ---
USER_INFO=""
DEV_USERNAME="${DEV_USERNAME-test}"
if [ -n "$DEV_USERNAME" ]; then
  DEV_EMAIL="${DEV_EMAIL:-${DEV_USERNAME}@example.com}"
  DEV_FIRSTNAME="${DEV_FIRSTNAME:-Dev}"
  DEV_LASTNAME="${DEV_LASTNAME:-Admin}"
  DEV_PASSWORD="${DEV_PASSWORD:-Test123!}"

  log "Searching for user '${DEV_USERNAME}' ..."
  USER_SEARCH=$(zitadel_api POST "/management/v1/users/_search" \
    "{\"queries\":[{\"userNameQuery\":{\"userName\":\"${DEV_USERNAME}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")
  USER_ID=$(echo "$USER_SEARCH" | json_field id)

  if [ -z "$USER_ID" ]; then
    log "   Creating human user '${DEV_USERNAME}' ..."
    USER_PAYLOAD=$(cat <<PAYLOAD
{
  "userName": "${DEV_USERNAME}",
  "profile": {
    "firstName": "${DEV_FIRSTNAME}",
    "lastName": "${DEV_LASTNAME}",
    "displayName": "${DEV_FIRSTNAME} ${DEV_LASTNAME}",
    "preferredLanguage": "en"
  },
  "email": {
    "email": "${DEV_EMAIL}",
    "isEmailVerified": true
  },
  "password": "${DEV_PASSWORD}",
  "passwordChangeRequired": false
}
PAYLOAD
)
    CREATE_USER=$(zitadel_api POST "/management/v1/users/human/_import" "$USER_PAYLOAD")
    USER_ID=$(echo "$CREATE_USER" | json_field userId)
    [ -n "$USER_ID" ] || die "Failed to create user. Response: ${CREATE_USER}"
    log "   User ID: ${USER_ID}"
  else
    log "   User exists (ID=${USER_ID}) — skipping creation, ensuring grants below"
    DEV_PASSWORD="<unchanged>"
  fi

  # --- 6. Grant ORG roles ---
  for ROLE in ${ORG_ROLES}; do
    log "   Ensuring org role '${ROLE}' for user ${USER_ID} ..."
    # Try to add as org member — Zitadel returns ALREADY_EXISTS if present;
    # upgrade via update if already a member with different roles.
    ADD_MEMBER=$(zitadel_api POST "/management/v1/orgs/me/members" \
      "{\"userId\":\"${USER_ID}\",\"roles\":[\"${ROLE}\"]}" || true)
    if echo "$ADD_MEMBER" | grep -q '"code":"ALREADY_EXISTS"\|"code":6\|already exists'; then
      zitadel_api PUT "/management/v1/orgs/me/members/${USER_ID}" \
        "{\"roles\":[\"${ROLE}\"]}" >/dev/null 2>&1 || true
      log "     (was already member — roles updated)"
    fi
  done

  # --- 7. Grant project role ---
  log "   Ensuring project role '${PROJECT_ROLE}' on '${PROJECT_NAME}' for user ${USER_ID} ..."
  GRANT_SEARCH=$(zitadel_api POST "/management/v1/users/${USER_ID}/grants/_search" \
    "{\"queries\":[{\"projectIdQuery\":{\"projectId\":\"${PROJECT_ID}\"}}]}")
  GRANT_ID=$(echo "$GRANT_SEARCH" | json_field id)

  if [ -n "$GRANT_ID" ]; then
    zitadel_api PUT "/management/v1/users/${USER_ID}/grants/${GRANT_ID}" \
      "{\"roleKeys\":[\"${PROJECT_ROLE}\"]}" >/dev/null 2>&1 || true
    log "     (grant ${GRANT_ID} already existed — roles updated)"
  else
    zitadel_api POST "/management/v1/users/${USER_ID}/grants" \
      "{\"projectId\":\"${PROJECT_ID}\",\"roleKeys\":[\"${PROJECT_ROLE}\"]}" >/dev/null
    log "     Grant created"
  fi

  USER_INFO=$(cat <<INFO

# --- Dev user ---
#   Username:       ${DEV_USERNAME}
#   Email:          ${DEV_EMAIL} (verified)
#   Password:       ${DEV_PASSWORD}
#   Org roles:      ${ORG_ROLES}
#   Project role:   ${PROJECT_ROLE} on ${PROJECT_NAME}
INFO
)
fi

# --- 8. Generate session secret ---
SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -d '/+=' | cut -c1-64)

# --- 9. Emit launch-config JSON entry ---
cat <<JSON

# --- Paste the following into "launch.configurations" in ---
# ---   oci-lxc-deployer-green.code-workspace              ---
${USER_INFO}

      {
        "name": "Launch OIDC Backend",
        "program": "\${workspaceFolder:backend}/dist/oci-lxc-deployer.mjs",
        "preLaunchTask": "build backend",
        "request": "launch",
        "sourceMaps": true,
        "cwd": "\${workspaceFolder:backend}",
        "console": "integratedTerminal",
        "args": [
          "--local",
          "\${workspaceFolder:backend}/../livetest-local",
          "--storageContextFilePath",
          "\${workspaceFolder:backend}/../storagecontext.json",
          "--secretsFilePath",
          "\${workspaceFolder:backend}/../secret.txt"
        ],
        "env": {
          "DEPLOYER_PORT": "3201",
          "OIDC_ENABLED": "true",
          "OIDC_ISSUER_URL": "${ZITADEL_URL}",
          "OIDC_CLIENT_ID": "${CLIENT_ID}",
          "OIDC_CLIENT_SECRET": "${CLIENT_SECRET}",
          "OIDC_CALLBACK_URL": "${CALLBACK_URL}",
          "OIDC_SESSION_SECRET": "${SESSION_SECRET}"
        },
        "trace": true,
        "outFiles": [
          "\${workspaceFolder:backend}/dist/**/*.mjs",
          "\${workspaceFolder:backend}/dist/**/*.mjs.map"
        ],
        "skipFiles": ["<node_internals>/**"],
        "type": "node"
      },
JSON
