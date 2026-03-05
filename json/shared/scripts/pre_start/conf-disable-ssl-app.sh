#!/bin/sh
# Disable SSL application-specific configuration (no-op default)
#
# This script is called when the SSL addon is disabled.
# Applications can override this script in their own scripts/
# directory to perform application-specific SSL cleanup
# (e.g., removing SSL settings from configuration files).
#
# Override example: examples/applications/postgres/scripts/conf-disable-ssl-app.sh

echo "No application-specific SSL cleanup needed" >&2
echo '[{"id":"ssl_app_disabled","value":"false"}]'
