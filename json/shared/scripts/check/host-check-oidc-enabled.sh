#!/bin/sh
# Check that OIDC is enabled on the deployer instance.
#
# Template variables:
#   vm_id - Container VM ID
#
# Checks /api/auth/config endpoint returns oidcEnabled: true.
# Exit 1 on failure, exit 0 on success.

VM_ID="{{ vm_id }}"

IP=$(pct exec "$VM_ID" -- ip -4 addr show eth0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)

if [ -z "$IP" ]; then
    echo "CHECK: oidc_enabled FAILED (cannot determine container IP)" >&2
    printf '[{"id":"check_oidc_enabled_result","value":"no IP"}]'
    exit 1
fi

RESULT=$(curl -sf --connect-timeout 5 "http://${IP}:3080/api/auth/config" 2>/dev/null)

if echo "$RESULT" | grep -q '"oidcEnabled":true'; then
    echo "CHECK: oidc_enabled PASSED" >&2
    printf '[{"id":"check_oidc_enabled_result","value":"ok"}]'
else
    echo "CHECK: oidc_enabled FAILED (response: ${RESULT})" >&2
    printf '[{"id":"check_oidc_enabled_result","value":"failed"}]'
    exit 1
fi
