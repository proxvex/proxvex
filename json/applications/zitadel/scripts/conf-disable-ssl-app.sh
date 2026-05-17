#!/bin/sh
# Disable SSL/TLS for Zitadel docker-compose application
#
# Overrides the shared no-op script.
# Runs on PVE host during pre_start phase.
#
# The compose_file from application.json is already the HTTP version, so no
# compose transformation is needed. But the zitadel.yaml on the persistent
# `config` volume may still carry Database SSL Mode: require from a previous
# SSL-enabled deploy (the volume survives the reconfigure clone). Revert it
# to disable so Zitadel connects to a non-TLS Postgres again.
set -eu

HOSTNAME="{{ hostname }}"
VM_ID="{{ vm_id }}"

SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

if [ -n "$VM_ID" ] && [ "$VM_ID" != "NOT_DEFINED" ]; then
  CONFIG_DIR=$(resolve_host_volume "$SAFE_HOST" "config" "$VM_ID" 2>/dev/null || true)
  if [ -n "${CONFIG_DIR:-}" ] && [ -f "$CONFIG_DIR/zitadel.yaml" ]; then
    sed -i 's/^\([[:space:]]*\)Mode: require/\1Mode: disable/g' "$CONFIG_DIR/zitadel.yaml"
    echo "Reverted zitadel.yaml Database SSL Mode -> disable" >&2
  fi
fi

echo "SSL disabled: using HTTP compose (no transformation needed)" >&2
echo '[{"id":"ssl_app_disabled","value":"true"}]'
