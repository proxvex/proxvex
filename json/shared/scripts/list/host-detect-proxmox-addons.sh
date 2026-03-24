#!/bin/sh
# Detect which addons are active on PVE host
#
# Checks the actual PVE state to determine which addons have been configured:
# - SSL: Custom CA-signed certificate exists at /etc/pve/local/pve-ssl.pem
# - OIDC: An openid realm is configured in pveum
#
# Output: pve_addons = comma-separated notes_key values (e.g. "ssl,oidc")

ADDONS=""

# SSL: Check for custom CA-signed certificate
if [ -f /etc/pve/pve-root-ca.pem ] && [ -f /etc/pve/local/pve-ssl.pem ]; then
  ADDONS="ssl"
fi

# OIDC: Check for openid realm
if pveum realm list --output-format json 2>/dev/null | grep -q '"type".*:.*"openid"'; then
  if [ -n "$ADDONS" ]; then ADDONS="$ADDONS,oidc"; else ADDONS="oidc"; fi
fi

echo "[{\"id\":\"pve_addons\",\"value\":\"$ADDONS\"}]"
