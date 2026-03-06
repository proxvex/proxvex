#!/bin/sh
# Enable SSL/TLS for Zitadel docker-compose application
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# Sets ZITADEL_TLS_MODE=enabled and ZITADEL_EXTERNALSECURE=true
# in the docker-compose .env file so Zitadel starts with TLS.
# The compose file references these via ${ZITADEL_TLS_MODE:-disabled}.
set -eu

SHARED_VOLPATH="{{ shared_volpath }}"
HOSTNAME="{{ hostname }}"

# Sanitize hostname for volume path
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

# The compose volume is at compose/  within the volumes directory.
# Inside it, the project dir uses the hostname as project name.
COMPOSE_PROJECT="$SAFE_HOST"
ENV_FILE="${SHARED_VOLPATH}/volumes/${SAFE_HOST}/compose/${COMPOSE_PROJECT}/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo ".env file not found at $ENV_FILE (fresh install, will be set on first compose upload)" >&2
  echo '[{"id":"ssl_app_enabled","value":"false"}]'
  exit 0
fi

# Remove existing TLS-related entries (idempotent)
sed -i '/^ZITADEL_TLS_MODE=/d' "$ENV_FILE"
sed -i '/^ZITADEL_EXTERNALSECURE=/d' "$ENV_FILE"

# Append TLS configuration
cat >> "$ENV_FILE" <<EOF
ZITADEL_TLS_MODE=enabled
ZITADEL_EXTERNALSECURE=true
EOF

echo "SSL enabled: ZITADEL_TLS_MODE=enabled, ZITADEL_EXTERNALSECURE=true" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
