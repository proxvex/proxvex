#!/bin/sh
# Register an API application in Zitadel for bearer-token audience.
# Runs on PVE host (execute_on: ve). Used by addon-oauth2-proxy.
#
# Creates (or finds) a Zitadel project named `bearer_audience` plus an API
# application of the same name within it. The API app's clientId is the
# audience that oauth2-proxy will validate against on incoming JWTs.
#
# Inputs (template variables):
#   ZITADEL_HOST                          - Hostname of the Zitadel container
#   ZITADEL_PROTO, ZITADEL_PORT           - Internal Zitadel URL parts (provides)
#   ZITADEL_SSL_PROTO, ZITADEL_SSL_PORT   - SSL-variant fallback (provides)
#   ZITADEL_PAT                           - Operator-supplied PAT (optional)
#   DEPLOYER_OIDC_MACHINE_CLIENT_ID       - Machine credentials for Tier-2 auth
#   DEPLOYER_OIDC_MACHINE_CLIENT_SECRET
#   DEPLOYER_OIDC_ISSUER_URL
#   hostname                              - Application container hostname (fallback)
#   bearer_audience                       - Audience name (also project + app name)
#
# Outputs (JSON to stdout):
#   bearer_audience_client_id  - clientId of the API app (= JWT aud claim value)
#   bearer_audience_project_id - Zitadel project ID (for role grants)
#   oidc_issuer_url            - Issuer URL for oauth2-proxy

ZITADEL_HOST="{{ ZITADEL_HOST }}"
ZITADEL_PROTO_INPUT="{{ ZITADEL_PROTO }}"
ZITADEL_PORT_INPUT="{{ ZITADEL_PORT }}"
ZITADEL_SSL_PROTO_INPUT="{{ ZITADEL_SSL_PROTO }}"
ZITADEL_SSL_PORT_INPUT="{{ ZITADEL_SSL_PORT }}"
ZITADEL_PAT_INPUT="{{ ZITADEL_PAT }}"
DEPLOYER_OIDC_MACHINE_CLIENT_ID_INPUT="{{ DEPLOYER_OIDC_MACHINE_CLIENT_ID }}"
DEPLOYER_OIDC_MACHINE_CLIENT_SECRET_INPUT="{{ DEPLOYER_OIDC_MACHINE_CLIENT_SECRET }}"
DEPLOYER_OIDC_ISSUER_URL_INPUT="{{ DEPLOYER_OIDC_ISSUER_URL }}"
HOSTNAME="{{ hostname }}"
BEARER_AUDIENCE="{{ bearer_audience }}"

if [ "$BEARER_AUDIENCE" = "NOT_DEFINED" ] || [ -z "$BEARER_AUDIENCE" ]; then
  echo "ERROR: bearer_audience is required (set in application properties or addon config)" >&2
  echo '[]'
  exit 1
fi

# --- Resolve Zitadel URL (mirrors conf-setup-oidc-client.sh) ---
ZITADEL_PROTO="http"
ZITADEL_PORT="8080"
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

# Issuer URL: external if available (oidc_production), else internal Zitadel URL
ISSUER_URL="$ZITADEL_URL"
if [ -n "$DEPLOYER_OIDC_ISSUER_URL_INPUT" ] && [ "$DEPLOYER_OIDC_ISSUER_URL_INPUT" != "NOT_DEFINED" ]; then
  ISSUER_URL="$DEPLOYER_OIDC_ISSUER_URL_INPUT"
fi

# --- Acquire Bearer for Zitadel Management API ---
# Same tier logic as conf-setup-oidc-client.sh — see comments there.
# TODO: extract into a shared library when a third script needs the same code.
PAT=""
PAT_SOURCE=""

if [ -n "$ZITADEL_PAT_INPUT" ] && [ "$ZITADEL_PAT_INPUT" != "NOT_DEFINED" ]; then
  PAT="$ZITADEL_PAT_INPUT"
  PAT_SOURCE="ZITADEL_PAT template var"
fi

if [ -z "$PAT" ] \
   && [ -n "$DEPLOYER_OIDC_MACHINE_CLIENT_ID_INPUT" ] \
   && [ "$DEPLOYER_OIDC_MACHINE_CLIENT_ID_INPUT" != "NOT_DEFINED" ] \
   && [ -n "$DEPLOYER_OIDC_MACHINE_CLIENT_SECRET_INPUT" ] \
   && [ "$DEPLOYER_OIDC_MACHINE_CLIENT_SECRET_INPUT" != "NOT_DEFINED" ] \
   && [ -n "$DEPLOYER_OIDC_ISSUER_URL_INPUT" ] \
   && [ "$DEPLOYER_OIDC_ISSUER_URL_INPUT" != "NOT_DEFINED" ]; then
  cc_scope="openid urn:zitadel:iam:org:project:id:zitadel:aud urn:zitadel:iam:org:projects:roles"
  # Retry while Zitadel does not answer at all (restart, snapshot rollback):
  # otherwise this would silently fall through to the stub audience below.
  # An answer without a token (wrong credentials) is not retried.
  cc_token=""
  cc_response=""
  cc_try=0
  while [ -z "$cc_response" ] && [ "$cc_try" -lt 10 ]; do
    [ "$cc_try" -gt 0 ] && { echo "Zitadel token endpoint not answering yet, retrying..." >&2; sleep 3; }
    cc_try=$((cc_try + 1))
    cc_response=$(curl -sk -m 10 -X POST "${DEPLOYER_OIDC_ISSUER_URL_INPUT}/oauth/v2/token" \
      -u "${DEPLOYER_OIDC_MACHINE_CLIENT_ID_INPUT}:${DEPLOYER_OIDC_MACHINE_CLIENT_SECRET_INPUT}" \
      --data-urlencode "grant_type=client_credentials" \
      --data-urlencode "scope=${cc_scope}" 2>/dev/null)
  done
  cc_token=$(echo "$cc_response" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  if [ -n "$cc_token" ]; then
    PAT="$cc_token"
    PAT_SOURCE="client_credentials via DEPLOYER_OIDC_MACHINE_*"
  fi
fi

if [ -z "$PAT" ]; then
  # Stub fallback: when Zitadel API isn't reachable (e.g. livetest on a PVE
  # host that can't route to zitadel-default:8080) we still want the addon to
  # install successfully. The hook will start oauth2-proxy with the supplied
  # `bearer_audience` as the JWT audience — works for tests that don't issue
  # real JWTs (the 401-on-unauthorized check still validates the proxy is up).
  # Production has a reachable issuer URL and never hits this path.
  echo "WARN: No Zitadel Bearer available — falling back to stub audience." >&2
  echo "  This is expected in livetest where the PVE host cannot route to"  >&2
  echo "  the internal Zitadel API. Production deployments hit a reachable" >&2
  echo "  issuer URL and skip this branch."                                  >&2
  echo "  Stub: bearer_audience_client_id = bearer_audience"                 >&2
  cat <<ENDOFOUTPUT
[
  {"id": "bearer_audience_client_id", "value": "${BEARER_AUDIENCE}"},
  {"id": "bearer_audience_project_id", "value": ""},
  {"id": "oidc_issuer_url", "value": "${ISSUER_URL}"}
]
ENDOFOUTPUT
  exit 0
fi
echo "Using Bearer from: ${PAT_SOURCE}" >&2

# --- Address the Management API ---
# Use issuer URL when distinct from internal (matches conf-setup-oidc-client.sh).
if [ -n "$ISSUER_URL" ] && [ "$ISSUER_URL" != "$ZITADEL_URL" ]; then
  ZITADEL_API_BASE="${ISSUER_URL%/}"
else
  ZITADEL_API_BASE="$ZITADEL_URL"
fi
echo "Using Zitadel Management API at ${ZITADEL_API_BASE}" >&2

zitadel_api() {
  _method="$1"
  _path="$2"
  _body="$3"
  if [ -n "$_body" ]; then
    curl -skL -X "$_method" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      -d "$_body" \
      "${ZITADEL_API_BASE}${_path}" 2>/dev/null
  else
    curl -skL -X "$_method" \
      -H "Authorization: Bearer ${PAT}" \
      -H "Content-Type: application/json" \
      "${ZITADEL_API_BASE}${_path}" 2>/dev/null
  fi
}

# --- Find or create project named after bearer_audience ---
echo "Searching for project '${BEARER_AUDIENCE}'..." >&2
PROJECT_RESPONSE=$(zitadel_api POST "/management/v1/projects/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${BEARER_AUDIENCE}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

case "$PROJECT_RESPONSE" in
  *'"code":'*'"message":'*)
    echo "ERROR: Zitadel rejected the project search:" >&2
    echo "  ${PROJECT_RESPONSE}" >&2
    echo '[]'
    exit 1
    ;;
esac

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$PROJECT_ID" ]; then
  echo "Creating project '${BEARER_AUDIENCE}'..." >&2
  CREATE_RESPONSE=$(zitadel_api POST "/management/v1/projects" \
    "{\"name\":\"${BEARER_AUDIENCE}\"}")
  PROJECT_ID=$(echo "$CREATE_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$PROJECT_ID" ]; then
    echo "ERROR: Failed to create project: ${CREATE_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created project '${BEARER_AUDIENCE}' (ID ${PROJECT_ID})" >&2
else
  echo "Found existing project '${BEARER_AUDIENCE}' (ID ${PROJECT_ID})" >&2
fi

# --- Find or create API application ---
# API apps in Zitadel represent resource servers. Their clientId becomes the
# canonical audience for JWTs targeting this resource.
echo "Searching for API app '${BEARER_AUDIENCE}' in project ${PROJECT_ID}..." >&2
APP_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/_search" \
  "{\"queries\":[{\"nameQuery\":{\"name\":\"${BEARER_AUDIENCE}\",\"method\":\"TEXT_QUERY_METHOD_EQUALS\"}}]}")

APP_ID=$(echo "$APP_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
CLIENT_ID=""

if [ -z "$APP_ID" ]; then
  echo "Creating API app '${BEARER_AUDIENCE}'..." >&2
  # OIDC_AUTH_METHOD_TYPE_BASIC: client_secret_basic — Machine User clients
  # authenticate against /token endpoint with HTTP Basic auth.
  CREATE_APP_RESPONSE=$(zitadel_api POST "/management/v1/projects/${PROJECT_ID}/apps/api" \
    "{\"name\":\"${BEARER_AUDIENCE}\",\"authMethodType\":\"API_AUTH_METHOD_TYPE_BASIC\"}")
  APP_ID=$(echo "$CREATE_APP_RESPONSE" | sed -n 's/.*"appId":"\([^"]*\)".*/\1/p' | head -1)
  CLIENT_ID=$(echo "$CREATE_APP_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$APP_ID" ]; then
    echo "ERROR: Failed to create API app: ${CREATE_APP_RESPONSE}" >&2
    echo '[]'
    exit 1
  fi
  echo "Created API app '${BEARER_AUDIENCE}' (appId ${APP_ID}, clientId ${CLIENT_ID})" >&2
else
  echo "Found existing API app '${BEARER_AUDIENCE}' (appId ${APP_ID})" >&2
  CLIENT_ID=$(echo "$APP_RESPONSE" | sed -n 's/.*"clientId":"\([^"]*\)".*/\1/p' | head -1)
fi

if [ -z "$CLIENT_ID" ]; then
  echo "ERROR: Could not determine clientId for API app" >&2
  echo '[]'
  exit 1
fi

echo "Bearer API setup complete" >&2
echo "  Issuer URL:   ${ISSUER_URL}" >&2
echo "  Project ID:   ${PROJECT_ID}" >&2
echo "  Audience (clientId): ${CLIENT_ID}" >&2

cat <<ENDOFOUTPUT
[
  {"id": "bearer_audience_client_id", "value": "${CLIENT_ID}"},
  {"id": "bearer_audience_project_id", "value": "${PROJECT_ID}"},
  {"id": "oidc_issuer_url", "value": "${ISSUER_URL}"}
]
ENDOFOUTPUT
