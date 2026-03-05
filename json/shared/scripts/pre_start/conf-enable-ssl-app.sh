#!/bin/sh
# Enable SSL application-specific configuration (no-op default)
#
# This script is called when the SSL addon is enabled (installation/reconfigure).
# Applications can override this script in their own scripts/
# directory to perform application-specific SSL setup
# (e.g., adding SSL settings to configuration files).
#
# Override example: examples/applications/postgres/scripts/conf-enable-ssl-app.sh

echo "No application-specific SSL configuration needed" >&2
echo '[{"id":"ssl_app_enabled","value":"false"}]'
