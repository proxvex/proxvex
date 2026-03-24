#!/bin/sh
# Proxmox override: No additional SSL app configuration needed
# Certificate deployment is handled in conf-generate-certificates.sh

echo "Proxmox host: SSL deployment handled during certificate generation" >&2
echo '[{"id":"ssl_app_enabled","value":"true"}]'
