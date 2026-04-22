#!/bin/sh
# Disable OIDC for modbus2mqtt
#
# Removes OIDC environment variables from the LXC container config.
# Finds the config file by hostname (pre-start hook may be invoked without vm_id
# in reconfigure flows).
#
# Template variables:
#   hostname  - Container hostname

HOSTNAME="{{ hostname }}"

echo "Removing OIDC configuration for hostname: $HOSTNAME" >&2

CONF_FILE=""
for f in /etc/pve/lxc/*.conf; do
  [ -f "$f" ] || continue
  if grep -q "^hostname:.*${HOSTNAME}" "$f" 2>/dev/null; then
    CONF_FILE="$f"
    break
  fi
done

if [ -z "$CONF_FILE" ]; then
  echo "WARNING: No config file found for hostname $HOSTNAME" >&2
  echo '[{"id":"oidc_app_disabled","value":"false"}]'
  exit 0
fi

echo "Found config: $CONF_FILE" >&2

sed -i '/^lxc\.environment:[[:space:]]*OIDC_/d' "$CONF_FILE"

echo "OIDC environment variables removed from $CONF_FILE" >&2
echo '[{"id":"oidc_app_disabled","value":"true"}]'
