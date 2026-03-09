#!/bin/sh
# Enable SSL/TLS for Zitadel docker-compose application
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# 1. Outputs env_file (base64-encoded .env) so template 320 writes it
#    into the container at /opt/docker-compose/<project>/.env
#    The compose file uses ${VAR:-default} Docker env substitution.
#
# 2. Fixes cert file permissions for the Zitadel docker user (non-root).
#    The cert directory is created with 0700/root ownership for the LXC
#    container, but Zitadel runs as non-root inside docker.
#    We make the certs world-readable so the docker user can access them.
set -eu

SHARED_VOLPATH="{{ shared_volpath }}"
HOSTNAME="{{ hostname }}"

# Build .env content and base64-encode it for the env_file output
ENV_CONTENT="ZITADEL_TLS_MODE=enabled
ZITADEL_EXTERNALSECURE=true
POSTGRES_SSL_MODE=require"

ENV_FILE_B64=$(printf '%s\n' "$ENV_CONTENT" | base64 | tr -d '\n')

# Fix cert permissions for non-root docker user
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
CERT_DIR="${SHARED_VOLPATH}/volumes/${SAFE_HOST}/certs"

if [ -d "$CERT_DIR" ]; then
  chmod 0755 "$CERT_DIR" 2>/dev/null || true
  chmod 0644 "$CERT_DIR"/*.pem 2>/dev/null || true
  echo "Cert permissions relaxed for non-root docker user" >&2
fi

echo "SSL enabled: ZITADEL_TLS_MODE=enabled, ZITADEL_EXTERNALSECURE=true, POSTGRES_SSL_MODE=require" >&2
echo "[{\"id\":\"ssl_app_enabled\",\"value\":\"true\"},{\"id\":\"env_file\",\"value\":\"$ENV_FILE_B64\"}]"
