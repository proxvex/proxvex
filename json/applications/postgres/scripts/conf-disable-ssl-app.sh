#!/bin/sh
# Disable SSL in PostgreSQL configuration
#
# Overrides the shared no-op script.
# Removes the SSL configuration block from postgresql.conf
# when the SSL addon is disabled.
set -eu

HOSTNAME="{{ hostname }}"

# Sanitize hostname for volume path
SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

PG_CONF="$(resolve_host_volume "$SAFE_HOST" "data")/pgdata/postgresql.conf"

SSL_START="# oci-lxc-deployer SSL start"
SSL_END="# oci-lxc-deployer SSL end"

if [ ! -f "$PG_CONF" ]; then
  echo "postgresql.conf not found, nothing to disable" >&2
  echo '[{"id":"ssl_app_disabled","value":"false"}]'
  exit 0
fi

if grep -q "$SSL_START" "$PG_CONF"; then
  sed -i "/${SSL_START}/,/${SSL_END}/d" "$PG_CONF"
  echo "SSL configuration removed from postgresql.conf" >&2
  echo '[{"id":"ssl_app_disabled","value":"true"}]'
else
  echo "No SSL configuration found in postgresql.conf" >&2
  echo '[{"id":"ssl_app_disabled","value":"false"}]'
fi
