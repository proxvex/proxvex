#!/bin/sh
# Disable OIDC for oci-lxc-deployer
#
# Removes OIDC environment variables from the LXC container config.
#
# Template variables:
#   hostname  - Container hostname

HOSTNAME="{{ hostname }}"

echo "Removing OIDC configuration for hostname: $HOSTNAME" >&2

# Find the config file by hostname
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

# Remove all OIDC environment entries
sed -i '/^lxc\.environment:\s*OIDC_/d' "$CONF_FILE"

echo "OIDC environment variables removed from $CONF_FILE" >&2
echo '[{"id":"oidc_app_disabled","value":"true"}]'
