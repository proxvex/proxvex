#!/bin/sh
# Proxmox override: No LXC storage volumes needed for PVE host
#
# Outputs shared_volpath pointing to /etc/pve for certificate deployment.

echo "Proxmox host: no LXC volumes needed" >&2
echo '[{"id":"shared_volpath","value":"/etc/pve"},{"id":"volumes_attached","value":"false"}]'
