#!/bin/sh
# Disable OIDC application-specific configuration (no-op default)
#
# This script is called when the OIDC addon is disabled.
# Applications can override this script in their own scripts/
# directory to perform application-specific OIDC cleanup
# (e.g., removing OIDC settings from configuration files).

echo "No application-specific OIDC cleanup needed" >&2
echo '[{"id":"oidc_app_disabled","value":"false"}]'
