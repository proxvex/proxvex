#!/bin/sh
# Make sure the SSL proxy (nginx + iptables) has the capabilities it needs.
#
# Only relevant for proxy mode on OCI-image containers. Docker containers
# already have all capabilities (lxc.cap.drop =) and do not need this.
#
# An unprivileged container already holds net_admin (and every other
# capability) inside its user namespace: Proxmox's userns.conf resets both
# lxc.cap.drop and lxc.cap.keep. Nothing has to be added.
#
# This script used to append `lxc.cap.keep: net_admin`. lxc.cap.keep means
# "keep ONLY these" — it stripped cap_net_raw (iptables-legacy: "can't
# initialize iptables table: Permission denied"), cap_chown (nginx:
# "chown(/var/lib/nginx/tmp/client_body) failed") and the rest from every
# root process in the container. It now removes such a line instead, so a
# reconfigure repairs containers that still carry it.
#
# Requires:
#   - vm_id: Container VMID
#   - ssl_mode: "proxy", "native", or "certs"
#
# Output: [{"id": "ssl_capabilities_set", "value": "true/false"}]

VM_ID="{{ vm_id }}"
SSL_MODE="{{ ssl_mode }}"

[ "$SSL_MODE" = "NOT_DEFINED" ] && SSL_MODE=""

CONFIG_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

# Remove the restrictive keep-list written by earlier versions (any mode)
if grep -q "^lxc\.cap\.keep:[[:space:]]*net_admin[[:space:]]*$" "$CONFIG_FILE"; then
  echo "Removing obsolete 'lxc.cap.keep: net_admin' from $CONFIG_FILE (it dropped all other capabilities)" >&2
  sed -i '/^lxc\.cap\.keep:[[:space:]]*net_admin[[:space:]]*$/d' "$CONFIG_FILE"
fi

if [ "$SSL_MODE" != "proxy" ]; then
  echo "SSL mode is '$SSL_MODE', no capabilities needed" >&2
  printf '[{"id": "ssl_capabilities_set", "value": "false"}]\n'
  exit 0
fi

if grep -q "^unprivileged:[[:space:]]*1" "$CONFIG_FILE" || grep -q "^lxc\.cap\.drop" "$CONFIG_FILE"; then
  echo "Container already holds net_admin (unprivileged user namespace or lxc.cap.drop =)" >&2
  printf '[{"id": "ssl_capabilities_set", "value": "true"}]\n'
  exit 0
fi

# Privileged container: Proxmox's common.conf drops only mac_admin,
# mac_override, sys_time, sys_module and sys_rawio — net_admin is kept.
echo "Privileged container: net_admin is not in Proxmox's default drop list" >&2
printf '[{"id": "ssl_capabilities_set", "value": "true"}]\n'
