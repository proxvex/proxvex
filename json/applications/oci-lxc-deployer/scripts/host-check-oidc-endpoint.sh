#!/bin/sh
# Check OIDC endpoint is reachable and API is protected.
#
# Template variables:
#   vm_id - Container VM ID
#   http_port - HTTP port of the deployer
#
# Outputs JSON array with check results.
# Exit 1 on failure, exit 0 on success.

VM_ID="{{ vm_id }}"
HTTP_PORT="{{ http_port }}"

# Get container IP
IP=$(pct exec "$VM_ID" -- ip -4 addr show eth0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)

if [ -z "$IP" ]; then
    echo "CHECK: oidc_endpoint FAILED (cannot determine container IP)" >&2
    printf '[{"id":"check_oidc","value":"no IP"}]'
    exit 1
fi

# Check if OIDC-protected API returns 401
status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://${IP}:${HTTP_PORT}/api/applications" 2>/dev/null || true)

if [ "$status" = "401" ]; then
    echo "CHECK: oidc_endpoint PASSED (API returns 401 - protected)" >&2
    printf '[{"id":"check_oidc","value":"ok (401 protected)"}]'
elif [ "$status" = "200" ]; then
    echo "CHECK: oidc_endpoint WARNING (API returns 200 - not protected)" >&2
    printf '[{"id":"check_oidc","value":"warning (200 unprotected)"}]'
else
    echo "CHECK: oidc_endpoint FAILED (HTTP status: $status)" >&2
    printf '[{"id":"check_oidc","value":"failed (HTTP %s)"}]' "$status"
    exit 1
fi
