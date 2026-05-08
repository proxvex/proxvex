#!/bin/sh
# Publish SSL connection info as stack provides.
# Outputs provides_proto, provides_port, and provides_url based on ssl_mode.
#
# Template variables:
#   ssl_mode     - proxy, native, or certs
#   hostname     - Container hostname
#   project_domain_suffix - FQDN suffix (default: .local)
#   http_port    - Application HTTP port (optional)
#   local_https_port   - Application HTTPS port (optional)

SSL_MODE="{{ ssl_mode }}"
HOSTNAME="{{ hostname }}"
PROJECT_DOMAIN_SUFFIX="{{ project_domain_suffix }}"
HTTP_PORT="{{ http_port }}"
LOCAL_HTTPS_PORT="{{ local_https_port }}"

[ "$PROJECT_DOMAIN_SUFFIX" = "NOT_DEFINED" ] && PROJECT_DOMAIN_SUFFIX=".local"
[ "$HTTP_PORT" = "NOT_DEFINED" ] && HTTP_PORT=""
[ "$LOCAL_HTTPS_PORT" = "NOT_DEFINED" ] && LOCAL_HTTPS_PORT=""

FQDN="${HOSTNAME}${PROJECT_DOMAIN_SUFFIX}"

# Determine protocol and port based on ssl_mode
case "$SSL_MODE" in
  proxy)
    PROTO="https"
    PORT="${LOCAL_HTTPS_PORT:-443}"
    ;;
  native)
    PROTO="https"
    PORT="${LOCAL_HTTPS_PORT:-443}"
    ;;
  certs)
    # certs mode: app uses its own SSL config
    PROTO="https"
    PORT="${LOCAL_HTTPS_PORT:-${HTTP_PORT:-443}}"
    ;;
  *)
    # No SSL or unknown mode
    PROTO="http"
    PORT="${HTTP_PORT:-80}"
    ;;
esac

URL="${PROTO}://${FQDN}:${PORT}"

# Use uppercase hostname as prefix for provides (e.g. ZITADEL_PROTO, POSTGRES_PORT)
PREFIX=$(echo "$HOSTNAME" | tr '[:lower:]-' '[:upper:]_')

echo "Publishing SSL provides: ${PREFIX}_PROTO=${PROTO} ${PREFIX}_PORT=${PORT} ${PREFIX}_URL=${URL}" >&2

printf '[{"id":"provides_%s_proto","value":"%s"},{"id":"provides_%s_port","value":"%s"},{"id":"provides_%s_url","value":"%s"}]' \
  "$PREFIX" "$PROTO" "$PREFIX" "$PORT" "$PREFIX" "$URL"
