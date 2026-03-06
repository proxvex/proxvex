#!/bin/sh
# Disable SSL/TLS for Zitadel docker-compose application
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# Removes ZITADEL_TLS_MODE and ZITADEL_EXTERNALSECURE from .env
# so Zitadel falls back to defaults (disabled/false).
set -eu

SHARED_VOLPATH="{{ shared_volpath }}"
HOSTNAME="{{ hostname }}"

# Sanitize hostname for volume path
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

COMPOSE_PROJECT="$SAFE_HOST"
ENV_FILE="${SHARED_VOLPATH}/volumes/${SAFE_HOST}/compose/${COMPOSE_PROJECT}/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo ".env file not found, nothing to disable" >&2
  echo '[{"id":"ssl_app_disabled","value":"false"}]'
  exit 0
fi

if grep -q 'ZITADEL_TLS_MODE=' "$ENV_FILE"; then
  sed -i '/^ZITADEL_TLS_MODE=/d' "$ENV_FILE"
  sed -i '/^ZITADEL_EXTERNALSECURE=/d' "$ENV_FILE"
  echo "SSL disabled: removed ZITADEL_TLS_MODE and ZITADEL_EXTERNALSECURE from .env" >&2
  echo '[{"id":"ssl_app_disabled","value":"true"}]'
else
  echo "No SSL configuration found in .env" >&2
  echo '[{"id":"ssl_app_disabled","value":"false"}]'
fi
