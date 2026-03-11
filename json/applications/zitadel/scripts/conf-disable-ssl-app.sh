#!/bin/sh
# Disable SSL/TLS for Zitadel docker-compose application
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# No transformation needed — the original compose_file from
# application.json is already the HTTP version.
# This script simply signals that SSL is disabled.
set -eu

echo "SSL disabled: using HTTP compose (no transformation needed)" >&2
echo '[{"id":"ssl_app_disabled","value":"true"}]'
