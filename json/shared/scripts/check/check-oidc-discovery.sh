#!/bin/sh
# Check that the consumer container can reach Zitadel's OIDC discovery doc.
# Output JSON: [{"id":"check_oidc_discovery","value":"ok"|<error>}]

ZITADEL_HOST="{{ ZITADEL_HOST }}"
ZITADEL_PORT="{{ ZITADEL_PORT }}"
ZITADEL_PROTO="{{ ZITADEL_PROTO }}"

[ "$ZITADEL_PROTO" = "NOT_DEFINED" ] && ZITADEL_PROTO="http"
[ "$ZITADEL_PORT"  = "NOT_DEFINED" ] && ZITADEL_PORT="8080"

if [ -z "$ZITADEL_HOST" ] || [ "$ZITADEL_HOST" = "NOT_DEFINED" ]; then
  echo "CHECK: oidc_discovery FAILED (ZITADEL_HOST not provided by stack)" >&2
  printf '[{"id":"check_oidc_discovery","value":"no host"}]'
  exit 1
fi

# Make sure curl is available — many minimal Alpine images skip it.
if ! command -v curl >/dev/null 2>&1; then
  pkg_install curl >&2 || {
    echo "CHECK: oidc_discovery FAILED (curl not installable)" >&2
    printf '[{"id":"check_oidc_discovery","value":"no curl"}]'
    exit 1
  }
fi

URL="${ZITADEL_PROTO}://${ZITADEL_HOST}:${ZITADEL_PORT}/.well-known/openid-configuration"
echo "Probing ${URL}" >&2

BODY=$(curl -sf --max-time 10 -H "Host: ${ZITADEL_HOST}" "$URL" 2>/dev/null)
RC=$?
if [ $RC -ne 0 ] || [ -z "$BODY" ]; then
  echo "CHECK: oidc_discovery FAILED (curl rc=${RC}, ${URL} unreachable)" >&2
  printf '[{"id":"check_oidc_discovery","value":"unreachable"}]'
  exit 1
fi

# Required endpoints — without these, a redirect roundtrip cannot complete.
for field in authorization_endpoint token_endpoint userinfo_endpoint; do
  if ! echo "$BODY" | grep -q "\"${field}\""; then
    echo "CHECK: oidc_discovery FAILED (discovery doc missing ${field})" >&2
    printf '[{"id":"check_oidc_discovery","value":"missing %s"}]' "$field"
    exit 1
  fi
done

echo "CHECK: oidc_discovery PASSED (${URL})" >&2
printf '[{"id":"check_oidc_discovery","value":"ok"}]'
