#!/bin/sh
# Disable SSL for modbus2mqtt (oci-image)
#
# Removes the HTTPS env vars from the LXC config, reverting to plain HTTP.
set -eu

VM_ID="{{ vm_id }}"
CONFIG_DIR="/etc/pve/lxc"
CONF_FILE="${CONFIG_DIR}/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  echo "ERROR: LXC config not found: $CONF_FILE" >&2
  echo '[]'
  exit 1
fi

sed -i '/^lxc\.environment:\s*MODBUS2MQTT_HTTPS_PORT=/d' "$CONF_FILE"
sed -i '/^lxc\.environment:\s*MODBUS2MQTT_SSL_DIR=/d' "$CONF_FILE"

echo "modbus2mqtt HTTPS env vars removed, reverting to HTTP" >&2
echo '[{"id":"ssl_app_disabled","value":"true"}]'
