#!/bin/sh
# Enable native HTTPS for pgAdmin (oci-image)
#
# Overrides the shared no-op script.
# Sets pgAdmin TLS config via LXC environment variables.
# Certs are mounted by the SSL addon at /certs/.
set -eu

VM_ID="{{ vm_id }}"
LOCAL_HTTPS_PORT="{{ local_https_port }}"
CONFIG_DIR="/etc/pve/lxc"
CONF_FILE="${CONFIG_DIR}/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: LXC config not found: $CONF_FILE" >&2
  echo '[]'
  exit 1
fi

# pgAdmin uses PGADMIN_CONFIG_ prefix for Python config overrides
{
  echo "lxc.environment: PGADMIN_CONFIG_ENABLE_TLS=True"
  echo "lxc.environment: PGADMIN_CONFIG_SERVER_CERT=/certs/server.cert"
  echo "lxc.environment: PGADMIN_CONFIG_SERVER_KEY=/certs/server.key"
  echo "lxc.environment: PGADMIN_LISTEN_PORT=${LOCAL_HTTPS_PORT:-5443}"
} >> "$CONF_FILE"

echo "pgAdmin native HTTPS enabled (port ${LOCAL_HTTPS_PORT:-5443}, certs from /certs/)" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
