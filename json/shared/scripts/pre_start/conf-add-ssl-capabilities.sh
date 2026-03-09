#!/bin/sh
# Add net_admin capability to LXC container for SSL proxy (iptables).
#
# Only needed for proxy mode on OCI-image containers.
# Docker containers already have all capabilities (lxc.cap.drop =)
# and do not need this.
#
# Requires:
#   - vm_id: Container VMID
#   - ssl.mode: "proxy", "native", or "certs"
#
# Output: [{"id": "ssl_capabilities_set", "value": "true/false"}]

VM_ID="{{ vm_id }}"
SSL_MODE="{{ ssl.mode }}"

[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""

CONFIG_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

# Native mode: no capabilities needed
if [ "$SSL_MODE" != "proxy" ]; then
  echo "SSL mode is '$SSL_MODE', no capabilities needed" >&2
  printf '[{"id": "ssl_capabilities_set", "value": "false"}]\n'
  exit 0
fi

# Docker containers already have all capabilities (lxc.cap.drop: )
if grep -q "^lxc\.cap\.drop" "$CONFIG_FILE"; then
  echo "Docker container detected (lxc.cap.drop =), capabilities already present" >&2
  printf '[{"id": "ssl_capabilities_set", "value": "true"}]\n'
  exit 0
fi

# Check if net_admin is already present
if grep -q "lxc.cap.keep.*net_admin" "$CONFIG_FILE"; then
  echo "net_admin capability already configured" >&2
  printf '[{"id": "ssl_capabilities_set", "value": "true"}]\n'
  exit 0
fi

# Add net_admin capability
echo "Adding lxc.cap.keep: net_admin to $CONFIG_FILE" >&2
echo "lxc.cap.keep: net_admin" >> "$CONFIG_FILE"

printf '[{"id": "ssl_capabilities_set", "value": "true"}]\n'
