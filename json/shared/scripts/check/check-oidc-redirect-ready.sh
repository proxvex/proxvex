#!/bin/sh
# Verify the OIDC client + redirect_uri pair is accepted by Zitadel.
# Reconstructs the same redirect_uri conf-setup-oidc-client.sh registered, then
# hits authorization_endpoint with it. Zitadel responds:
#   - 200/302  client + redirect_uri accepted (login page or auth code redirect)
#   - 400 + invalid_client       client_id not registered
#   - 400 + redirect_uri_mismatch redirect_uri not whitelisted
# Output JSON: [{"id":"check_oidc_redirect_ready","value":"ok"|<reason>}]

ZITADEL_HOST="{{ ZITADEL_HOST }}"
ZITADEL_PORT="{{ ZITADEL_PORT }}"
ZITADEL_PROTO="{{ ZITADEL_PROTO }}"
CLIENT_ID="{{ oidc_client_id }}"
HOSTNAME="{{ hostname }}"
DOMAIN_SUFFIX="{{ domain_suffix }}"
CALLBACK_PATH="{{ oidc_callback_path }}"
SSL_MODE="{{ ssl_mode }}"

[ "$ZITADEL_PROTO"  = "NOT_DEFINED" ] && ZITADEL_PROTO="http"
[ "$ZITADEL_PORT"   = "NOT_DEFINED" ] && ZITADEL_PORT="8080"
[ "$DOMAIN_SUFFIX"  = "NOT_DEFINED" ] && DOMAIN_SUFFIX=".local"
[ "$CALLBACK_PATH"  = "NOT_DEFINED" ] && CALLBACK_PATH="/auth/strategy/callback"

if [ -z "$ZITADEL_HOST" ] || [ "$ZITADEL_HOST" = "NOT_DEFINED" ] \
   || [ -z "$CLIENT_ID" ] || [ "$CLIENT_ID" = "NOT_DEFINED" ]; then
  echo "CHECK: oidc_redirect_ready FAILED (ZITADEL_HOST or oidc_client_id missing)" >&2
  printf '[{"id":"check_oidc_redirect_ready","value":"missing inputs"}]'
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  pkg_install curl >&2 || {
    printf '[{"id":"check_oidc_redirect_ready","value":"no curl"}]'
    exit 1
  }
fi

# Match the protocol selection in conf-setup-oidc-client.sh exactly.
APP_PROTO="http"
if [ -n "$SSL_MODE" ] && [ "$SSL_MODE" != "NOT_DEFINED" ] && [ "$SSL_MODE" != "none" ]; then
  APP_PROTO="https"
fi
REDIRECT_URI="${APP_PROTO}://${HOSTNAME}${DOMAIN_SUFFIX}${CALLBACK_PATH}"

# URL-encode the redirect_uri (sed-portable: replace : / with %3A %2F).
ENC_REDIRECT=$(printf '%s' "$REDIRECT_URI" | sed 's|:|%3A|g; s|/|%2F|g')

AUTHZ="${ZITADEL_PROTO}://${ZITADEL_HOST}:${ZITADEL_PORT}/oauth/v2/authorize"
QS="client_id=${CLIENT_ID}&response_type=code&scope=openid&redirect_uri=${ENC_REDIRECT}&state=check"

echo "Probing ${AUTHZ} with redirect_uri=${REDIRECT_URI}" >&2

# -o /dev/null + -w '%{http_code}|%{redirect_url}' so we see status + Location.
RESP=$(curl -s -o /tmp/oidc_check_body -w '%{http_code}|%{redirect_url}' \
       --max-time 15 -H "Host: ${ZITADEL_HOST}" \
       "${AUTHZ}?${QS}" 2>/dev/null)
RC=$?
STATUS=${RESP%%|*}
LOC=${RESP#*|}

if [ $RC -ne 0 ]; then
  echo "CHECK: oidc_redirect_ready FAILED (curl rc=${RC})" >&2
  printf '[{"id":"check_oidc_redirect_ready","value":"unreachable"}]'
  exit 1
fi

# 200/30x = login page rendered or redirect to /login (UI handoff). Both signal
# the request was accepted by Zitadel. 4xx with explicit error tells us why.
case "$STATUS" in
  200|301|302|303)
    echo "CHECK: oidc_redirect_ready PASSED (status=${STATUS}, redirect_uri=${REDIRECT_URI})" >&2
    printf '[{"id":"check_oidc_redirect_ready","value":"ok"}]'
    ;;
  400)
    BODY=$(cat /tmp/oidc_check_body 2>/dev/null)
    if echo "$BODY$LOC" | grep -q "invalid_client"; then
      REASON="invalid_client"
    elif echo "$BODY$LOC" | grep -q "redirect_uri_mismatch"; then
      REASON="redirect_uri_mismatch"
    else
      REASON="bad request"
    fi
    echo "CHECK: oidc_redirect_ready FAILED (${REASON}, redirect_uri=${REDIRECT_URI})" >&2
    printf '[{"id":"check_oidc_redirect_ready","value":"%s"}]' "$REASON"
    rm -f /tmp/oidc_check_body
    exit 1
    ;;
  *)
    echo "CHECK: oidc_redirect_ready FAILED (status=${STATUS})" >&2
    printf '[{"id":"check_oidc_redirect_ready","value":"http %s"}]' "$STATUS"
    rm -f /tmp/oidc_check_body
    exit 1
    ;;
esac

rm -f /tmp/oidc_check_body
