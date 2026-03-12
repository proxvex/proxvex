#!/bin/sh
# Configure OIDC in application (no-op default)
#
# This script is called after the OIDC client has been created in Zitadel.
# Applications override this script in their own scripts/ directory
# to configure themselves as OIDC consumers.
#
# Available template variables:
#   hostname          - Application hostname
#   oidc_issuer_url   - Zitadel issuer URL
#   oidc_client_id    - OIDC client ID
#   oidc_client_secret - OIDC client secret
#   domain_suffix     - Domain suffix

echo "No application-specific OIDC configuration needed" >&2
echo '[]'
