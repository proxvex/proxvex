#!/bin/sh
# REST Configure Common Library
#
# Provides functions for post_start configuration of applications via their
# own REST API. Handles readiness polling, OIDC client_credentials fallback
# when an endpoint requires authentication, and idempotent POSTs.
#
# Main functions:
#   1. rest_wait_for_ready URL TIMEOUT_SEC
#        Polls URL until HTTP 200/204 or timeout. Accepts self-signed certs.
#   2. rest_get_oidc_token ISSUER CLIENT_ID CLIENT_SECRET
#        client_credentials against ${ISSUER}/oauth/v2/token, echoes access_token.
#        Cached in /tmp/rest-oidc-token.${CLIENT_ID} until 30s before expiry.
#   3. rest_post URL PATH PAYLOAD_B64 [CONTENT_TYPE]
#        POST with base64-decoded payload. Tries unauthenticated first; on 401
#        fetches an OIDC token (env: REST_OIDC_ISSUER / REST_OIDC_CLIENT_ID /
#        REST_OIDC_CLIENT_SECRET) and retries with Authorization: Bearer.
#        Idempotent: 200/201/204/409 = success; other 4xx/5xx = error (exit 1).
#
# Required tools in container: curl, base64. Optional: jq (token parsing falls
# back to grep+sed if jq missing).
#
# This library is automatically prepended to scripts that declare
# library: "rest-configure-common.sh" in their template.

# ============================================================================
# CONFIGURATION CONSTANTS
# ============================================================================
REST_POLL_INTERVAL=2          # Seconds between readiness polls
REST_TOKEN_REFRESH_BUFFER=30  # Refresh token if it expires in <N seconds

# ============================================================================
# 1. rest_wait_for_ready URL TIMEOUT_SEC
# Poll URL until HTTP 200/204 or timeout. Accepts self-signed (-k).
# Returns 0 on success, 1 on timeout.
# ============================================================================
rest_wait_for_ready() {
  _url="$1"
  _timeout="${2:-60}"
  _start=$(date +%s)
  _deadline=$((_start + _timeout))

  echo "rest_wait_for_ready: polling $_url (timeout ${_timeout}s)" >&2
  while [ "$(date +%s)" -lt "$_deadline" ]; do
    _code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$_url" 2>/dev/null || echo 000)
    case "$_code" in
      200|204)
        _elapsed=$(( $(date +%s) - _start ))
        echo "rest_wait_for_ready: ready after ${_elapsed}s (HTTP $_code)" >&2
        return 0
        ;;
    esac
    sleep "$REST_POLL_INTERVAL"
  done
  echo "rest_wait_for_ready: timeout after ${_timeout}s waiting for $_url (last HTTP $_code)" >&2
  return 1
}

# ============================================================================
# 2. rest_get_oidc_token ISSUER CLIENT_ID CLIENT_SECRET
# client_credentials grant against ${ISSUER}/oauth/v2/token. Echoes the
# access_token to stdout. Cached on disk until REST_TOKEN_REFRESH_BUFFER
# seconds before expiry.
# Returns 0 on success, 1 on failure.
# ============================================================================
rest_get_oidc_token() {
  _issuer="$1"
  _client_id="$2"
  _client_secret="$3"

  if [ -z "$_issuer" ] || [ -z "$_client_id" ] || [ -z "$_client_secret" ]; then
    echo "rest_get_oidc_token: ISSUER/CLIENT_ID/CLIENT_SECRET required" >&2
    return 1
  fi

  _cache="/tmp/rest-oidc-token.${_client_id}"
  if [ -r "$_cache" ]; then
    _exp=$(sed -n '1p' "$_cache" 2>/dev/null)
    _now=$(date +%s)
    if [ -n "$_exp" ] && [ "$_exp" -gt "$((_now + REST_TOKEN_REFRESH_BUFFER))" ] 2>/dev/null; then
      sed -n '2p' "$_cache"
      return 0
    fi
  fi

  _token_url="${_issuer%/}/oauth/v2/token"
  _resp=$(curl -sk --max-time 10 \
    -u "${_client_id}:${_client_secret}" \
    -d 'grant_type=client_credentials' \
    -d 'scope=openid' \
    "$_token_url" 2>/dev/null) || {
    echo "rest_get_oidc_token: curl to $_token_url failed" >&2
    return 1
  }

  if command -v jq >/dev/null 2>&1; then
    _access=$(echo "$_resp" | jq -r '.access_token // empty')
    _expires=$(echo "$_resp" | jq -r '.expires_in // empty')
  else
    _access=$(echo "$_resp" | grep -o '"access_token"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
    _expires=$(echo "$_resp" | grep -o '"expires_in"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')
  fi

  if [ -z "$_access" ]; then
    echo "rest_get_oidc_token: no access_token in response from $_token_url" >&2
    return 1
  fi

  _expires="${_expires:-3600}"
  _exp=$(( $(date +%s) + _expires ))
  printf '%s\n%s\n' "$_exp" "$_access" > "$_cache"
  chmod 600 "$_cache" 2>/dev/null || true
  echo "$_access"
}

# ============================================================================
# 3. rest_post URL PATH PAYLOAD_B64 [CONTENT_TYPE]
# POST base64-decoded payload to URL+PATH.
# - First attempt: no Authorization header.
# - On 401: fetches OIDC token via env vars REST_OIDC_ISSUER / REST_OIDC_CLIENT_ID
#   / REST_OIDC_CLIENT_SECRET and retries with Authorization: Bearer.
# - 200/201/204/409 = success (409 = already configured, idempotent).
# Returns 0 on success, 1 on error.
# ============================================================================
rest_post() {
  _url="$1"
  _path="$2"
  _payload_b64="$3"
  _content_type="${4:-application/json}"

  if [ -z "$_url" ] || [ -z "$_path" ]; then
    echo "rest_post: URL and PATH required" >&2
    return 1
  fi

  _full="${_url%/}${_path}"
  _body_file=$(mktemp)
  _resp_file=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$_body_file' '$_resp_file'" RETURN 2>/dev/null || true

  if [ -n "$_payload_b64" ] && [ "$_payload_b64" != "NOT_DEFINED" ]; then
    echo "$_payload_b64" | base64 -d > "$_body_file" 2>/dev/null || {
      echo "rest_post: failed to base64-decode payload for $_full" >&2
      rm -f "$_body_file" "$_resp_file"
      return 1
    }
  else
    : > "$_body_file"
  fi

  echo "rest_post: POST $_full (content-type: $_content_type)" >&2
  _code=$(curl -sk -o "$_resp_file" -w '%{http_code}' \
    -X POST -H "Content-Type: $_content_type" \
    --data-binary "@$_body_file" \
    "$_full" 2>/dev/null || echo 000)

  case "$_code" in
    200|201|204|409)
      echo "rest_post: $_full -> HTTP $_code (success)" >&2
      rm -f "$_body_file" "$_resp_file"
      return 0
      ;;
    401)
      echo "rest_post: $_full -> HTTP 401, retrying with OIDC token" >&2
      ;;
    *)
      echo "rest_post: $_full -> HTTP $_code (error)" >&2
      sed -e 's/^/  /' "$_resp_file" >&2 2>/dev/null || true
      rm -f "$_body_file" "$_resp_file"
      return 1
      ;;
  esac

  _token=$(rest_get_oidc_token "$REST_OIDC_ISSUER" "$REST_OIDC_CLIENT_ID" "$REST_OIDC_CLIENT_SECRET") || {
    echo "rest_post: failed to obtain OIDC token, cannot retry" >&2
    rm -f "$_body_file" "$_resp_file"
    return 1
  }

  _code=$(curl -sk -o "$_resp_file" -w '%{http_code}' \
    -X POST -H "Content-Type: $_content_type" \
    -H "Authorization: Bearer $_token" \
    --data-binary "@$_body_file" \
    "$_full" 2>/dev/null || echo 000)

  rm -f "$_body_file" "$_resp_file"

  case "$_code" in
    200|201|204|409)
      echo "rest_post: $_full -> HTTP $_code (success, with bearer)" >&2
      return 0
      ;;
    *)
      echo "rest_post: $_full -> HTTP $_code (error after bearer retry)" >&2
      return 1
      ;;
  esac
}
