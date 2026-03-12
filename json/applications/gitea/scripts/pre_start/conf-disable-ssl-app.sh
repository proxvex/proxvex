#!/bin/sh
# Disable SSL for Gitea (oci-image)
#
# Removes Gitea HTTPS environment variables from the LXC config,
# reverting to HTTP mode.
set -eu

VM_ID="{{ vm_id }}"
CONFIG_DIR="/etc/pve/lxc"
CONF_FILE="${CONFIG_DIR}/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: LXC config not found: $CONF_FILE" >&2
  echo '[]'
  exit 1
fi

# Remove Gitea HTTPS env vars from LXC config
sed -i '/^lxc\.environment: GITEA__server__PROTOCOL=/d' "$CONF_FILE"
sed -i '/^lxc\.environment: GITEA__server__CERT_FILE=/d' "$CONF_FILE"
sed -i '/^lxc\.environment: GITEA__server__KEY_FILE=/d' "$CONF_FILE"

echo "Gitea HTTPS env vars removed, reverting to HTTP" >&2
echo '[{"id":"ssl_app_disabled","value":"true"}]'
