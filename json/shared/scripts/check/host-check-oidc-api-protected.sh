#!/bin/sh
# Check that the deployer API requires authentication (returns 401).
#
# Template variables:
#   vm_id - Container VM ID
#
# Retries up to 30s to allow for deployer restart after OIDC configuration.
# Exit 1 on failure, exit 0 on success.

VM_ID="{{ vm_id }}"
RETRY_TIMEOUT=30

IP=$(pct exec "$VM_ID" -- ip -4 addr show eth0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)

if [ -z "$IP" ]; then
    echo "CHECK: oidc_api_protected FAILED (cannot determine container IP)" >&2
    printf '[{"id":"check_oidc_api_protected_result","value":"no IP"}]'
    exit 1
fi

STATUS_CODE="000"
elapsed=0
while [ "$elapsed" -lt "$RETRY_TIMEOUT" ]; do
    # IP may change after OIDC reboot (DHCP)
    IP=$(pct exec "$VM_ID" -- ip -4 addr show eth0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
    if [ -n "$IP" ]; then
        STATUS_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "http://${IP}:3080/api/applications" 2>/dev/null)
        if [ "$STATUS_CODE" = "401" ]; then
            break
        fi
    fi
    echo "CHECK: oidc_api_protected waiting (status=${STATUS_CODE}, ${elapsed}s/${RETRY_TIMEOUT}s)" >&2
    sleep 5
    elapsed=$((elapsed + 5))
done

if [ "$STATUS_CODE" = "401" ]; then
    echo "CHECK: oidc_api_protected PASSED (status=401)" >&2
    printf '[{"id":"check_oidc_api_protected_result","value":"ok"}]'
else
    echo "CHECK: oidc_api_protected FAILED (status=${STATUS_CODE}, expected 401)" >&2
    printf '[{"id":"check_oidc_api_protected_result","value":"status=%s"}]' "$STATUS_CODE"
    exit 1
fi
