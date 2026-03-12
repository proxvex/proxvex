#!/bin/sh
# Enable native HTTPS for Gitea (oci-image)
#
# Overrides the shared no-op script.
# Adds Gitea HTTPS environment variables to the LXC config.
# Certs are mounted by the SSL addon at /etc/ssl/addon/.
set -eu

VM_ID="{{ vm_id }}"
HTTPS_PORT="{{ https_port }}"
CONFIG_DIR="/etc/pve/lxc"
CONF_FILE="${CONFIG_DIR}/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: LXC config not found: $CONF_FILE" >&2
  echo '[]'
  exit 1
fi

# Add Gitea HTTPS env vars to LXC config
{
  echo "lxc.environment: GITEA__server__PROTOCOL=https"
  echo "lxc.environment: GITEA__server__CERT_FILE=/etc/ssl/addon/fullchain.pem"
  echo "lxc.environment: GITEA__server__KEY_FILE=/etc/ssl/addon/privkey.pem"
  echo "lxc.environment: GITEA__server__HTTP_PORT=${HTTPS_PORT:-3000}"
} >> "$CONF_FILE"

echo "Gitea native HTTPS enabled (port ${HTTPS_PORT:-3000}, certs from /etc/ssl/addon/)" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
