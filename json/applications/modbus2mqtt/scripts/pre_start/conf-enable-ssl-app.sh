#!/bin/sh
# Enable native HTTPS for modbus2mqtt (oci-image)
#
# Overrides the shared no-op script.
# Writes env vars so the container entrypoint points modbus2mqtt at the certs
# mounted by the SSL addon at /etc/ssl/addon/. modbus2mqtt itself auto-detects
# HTTPS when fullchain.pem + privkey.pem exist in its SSL directory and
# MODBUS2MQTT_HTTPS_PORT is set.
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

# Remove any leftover SSL env entries from a previous run
sed -i '/^lxc\.environment:\s*MODBUS2MQTT_HTTPS_PORT=/d' "$CONF_FILE"
sed -i '/^lxc\.environment:\s*MODBUS2MQTT_SSL_DIR=/d' "$CONF_FILE"

# Write modbus2mqtt HTTPS env vars
{
  echo "lxc.environment: MODBUS2MQTT_HTTPS_PORT=${HTTPS_PORT:-3443}"
  echo "lxc.environment: MODBUS2MQTT_SSL_DIR=/etc/ssl/addon"
} >> "$CONF_FILE"

echo "modbus2mqtt native HTTPS enabled (port ${HTTPS_PORT:-3443}, certs from /etc/ssl/addon/)" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
