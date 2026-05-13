#!/bin/sh
# Grant every existing project's roles to the test-deployer machine user.
#
# Background: post-create-test-oidc-user.sh creates the test-deployer machine
# user with the IAM-level ORG_OWNER role. That permits administrative API
# operations (create projects, register OIDC apps, …) but does NOT translate
# into application-level OIDC roles. When proxvex/gitea/etc. issue an OIDC
# access token for the test-deployer, the project-role claims would be empty
# — so the deployer-oidc dev-session bypass works (it only validates the
# token), but apps that enforce a `OIDC_REQUIRED_ROLE` would still reject
# the user.
#
# This script closes the gap: for every Zitadel project that exists at the
# moment of invocation, it discovers all defined project roles and issues a
# UserGrant binding all of them to the test-deployer. After this, the access
# token carries the full role set, and the role check in
# populateSessionFromAccessToken() / hasRole() succeeds.
#
# Idempotent: existing UserGrants are detected (HTTP 409 ALREADY_EXISTS) and
# skipped. Safe to re-run after each new application deployment that creates
# its own OIDC project — the livetest runner invokes it before any
# playwright_spec.
#
# Inputs (template params):
#   hostname              - Zitadel hostname (for Host header)
#   project_domain_suffix - Optional domain suffix
#   ssl_mode              - Optional; controls http/https issuer URL
#
# Requires /bootstrap/test-deployer.json (produced by
# post-create-test-oidc-user.sh) and the ephemeral admin PAT
# (/zitadel/bootstrap/admin-client.pat inside the Zitadel container).

HOSTNAME="{{ hostname }}"
PROJECT_DOMAIN_SUFFIX="{{ project_domain_suffix }}"
SSL_MODE="{{ ssl_mode }}"

[ "$PROJECT_DOMAIN_SUFFIX" = "NOT_DEFINED" ] && PROJECT_DOMAIN_SUFFIX=""
[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""

CRED_FILE="/bootstrap/test-deployer.json"

# --- Pre-conditions ---
if [ ! -f "$CRED_FILE" ]; then
  echo "ERROR: ${CRED_FILE} not found — run post-create-test-oidc-user first" >&2
  echo '[]'
  exit 1
fi

MACHINE_USER_ID=$(sed -n 's/.*"user_id":[[:space:]]*"\([^"]*\)".*/\1/p' "$CRED_FILE" | head -1)
if [ -z "$MACHINE_USER_ID" ]; then
  echo "ERROR: cannot parse user_id from ${CRED_FILE}" >&2
  echo '[]'
  exit 1
fi
echo "test-deployer user_id: ${MACHINE_USER_ID}" >&2

if ! command -v curl > /dev/null 2>&1; then
  echo "Installing curl..." >&2
  apk add --no-cache curl >&2
fi

# --- Read admin PAT from running Zitadel container ---
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

if [ -z "$PAT" ]; then
  echo "ERROR: No admin PAT available (zitadel already hardened?)" >&2
  echo '[]'
  exit 1
fi

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
      "${ZITADEL_URL}${_path}"
  else
    curl -sk -X "$_method" \
      -H "Host: ${ZITADEL_HOST}" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      "${ZITADEL_URL}${_path}"
  fi
}

# --- Helper: extract a list of project IDs from JSON response ---
# Zitadel returns: {"result":[{"id":"123","name":"foo",...},{"id":"456",...}]}
extract_project_ids() {
  sed -n 's/.*"id":"\([^"]*\)".*/\1/gp' \
    | tr ',' '\n' \
    | grep -v '^$' \
    | sort -u
}

# --- 1. List all projects ---
echo "Listing projects..." >&2
PROJECTS_JSON=$(zitadel_api POST "/management/v1/projects/_search" '{"queries":[]}')
PROJECT_IDS=$(echo "$PROJECTS_JSON" \
  | tr '{' '\n' \
  | sed -n 's/.*"id":"\([0-9]\{6,\}\)".*"name":"\([^"]*\)".*/\1 \2/p')

if [ -z "$PROJECT_IDS" ]; then
  echo "No projects found — nothing to grant" >&2
  echo '[]'
  exit 0
fi

GRANTED_COUNT=0
SKIPPED_COUNT=0
FAILED_COUNT=0

echo "$PROJECT_IDS" | while IFS=' ' read -r PID PNAME; do
  [ -z "$PID" ] && continue
  echo "Project ${PID} (${PNAME})..." >&2

  # 2. List roles for this project
  ROLES_JSON=$(zitadel_api POST "/management/v1/projects/${PID}/roles/_search" '{"queries":[]}')
  ROLE_KEYS=$(echo "$ROLES_JSON" \
    | tr '{' '\n' \
    | sed -n 's/.*"key":"\([^"]*\)".*/"\1"/p' \
    | sort -u \
    | paste -sd, -)

  if [ -z "$ROLE_KEYS" ]; then
    echo "  no roles defined — skipping" >&2
    continue
  fi
  echo "  roles: ${ROLE_KEYS}" >&2

  # 3. Create UserGrant (idempotent: ALREADY_EXISTS returns 409)
  RESP=$(zitadel_api POST "/management/v1/users/${MACHINE_USER_ID}/grants" \
    "{\"projectId\":\"${PID}\",\"roleKeys\":[${ROLE_KEYS}]}")
  if echo "$RESP" | grep -q '"userGrantId"'; then
    echo "  granted" >&2
    GRANTED_COUNT=$((GRANTED_COUNT + 1))
  elif echo "$RESP" | grep -qE 'AlreadyExists|already.*exists'; then
    echo "  already granted — patching role set" >&2
    # Find existing grant id and PATCH it with the full role set
    SEARCH=$(zitadel_api POST "/management/v1/users/${MACHINE_USER_ID}/grants/_search" \
      "{\"queries\":[{\"projectIdQuery\":{\"projectId\":\"${PID}\"}}]}")
    GRANT_ID=$(echo "$SEARCH" | sed -n 's/.*"id":"\([0-9]\{6,\}\)".*"projectId":"'"${PID}"'".*/\1/p' | head -1)
    if [ -n "$GRANT_ID" ]; then
      zitadel_api PUT "/management/v1/users/${MACHINE_USER_ID}/grants/${GRANT_ID}" \
        "{\"roleKeys\":[${ROLE_KEYS}]}" > /dev/null
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    fi
  else
    echo "  FAILED: ${RESP}" >&2
    FAILED_COUNT=$((FAILED_COUNT + 1))
  fi
done

echo "Summary: granted=${GRANTED_COUNT} updated=${SKIPPED_COUNT} failed=${FAILED_COUNT}" >&2
echo '[]'
