#!/bin/sh
# Configure OIDC in application before start (no-op default)
#
# This script is called before the container starts.
# Applications that need config file changes (e.g. Node-RED settings.js)
# override this script in their own scripts/ directory.
#
# Available template variables:
#   vm_id              - Container VMID
#   hostname           - Container hostname
#   shared_volpath     - Shared volume path
#   oidc_issuer_url    - Zitadel issuer URL
#   oidc_client_id     - OIDC client ID
#   oidc_client_secret - OIDC client secret

echo "No application-specific OIDC pre-start configuration needed" >&2
echo '[]'
