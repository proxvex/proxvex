#!/bin/sh
# Check TLS connection to a container port.
#
# Template variables:
#   vm_id - Container VM ID
#   check_tls_port - Port to check TLS on
#
# Outputs JSON array with check results.
# Exit 1 on failure, exit 0 on success.

VM_ID="{{ vm_id }}"
TLS_PORT="{{ check_tls_port }}"

# Get container IP
IP=$(pct exec "$VM_ID" -- ip -4 addr show eth0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)

if [ -z "$IP" ]; then
    echo "CHECK: tls_connect FAILED (cannot determine container IP)" >&2
    printf '[{"id":"check_tls_connect","value":"no IP"}]'
    exit 1
fi

# Try TLS connection using openssl
result=$(echo | timeout 10 openssl s_client -connect "${IP}:${TLS_PORT}" -servername "${IP}" 2>/dev/null | head -5)

if echo "$result" | grep -q "BEGIN CERTIFICATE\|SSL handshake\|Protocol.*TLS\|Verify return code: 0"; then
    echo "CHECK: tls_connect PASSED (${IP}:${TLS_PORT})" >&2
    printf '[{"id":"check_tls_connect","value":"ok"}]'
else
    echo "CHECK: tls_connect FAILED (${IP}:${TLS_PORT})" >&2
    printf '[{"id":"check_tls_connect","value":"failed"}]'
    exit 1
fi
