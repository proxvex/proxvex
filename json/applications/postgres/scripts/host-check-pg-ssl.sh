#!/bin/sh
# Check if PostgreSQL has SSL enabled.
#
# Template variables:
#   vm_id - Container VM ID
#
# Outputs JSON array with check results.
# Exit 1 on failure, exit 0 on success.

VM_ID="{{ vm_id }}"

# Run SHOW ssl inside the container
ssl_status=$(pct exec "$VM_ID" -- su - postgres -c "psql -t -A -c 'SHOW ssl'" 2>/dev/null || true)

if [ "$ssl_status" = "on" ]; then
    echo "CHECK: pg_ssl_on PASSED (ssl=$ssl_status)" >&2
    printf '[{"id":"check_pg_ssl","value":"on"}]'
elif [ "$ssl_status" = "off" ]; then
    echo "CHECK: pg_ssl_on FAILED (ssl=$ssl_status)" >&2
    printf '[{"id":"check_pg_ssl","value":"off"}]'
    exit 1
else
    echo "CHECK: pg_ssl_on WARNING (could not determine ssl status: $ssl_status)" >&2
    printf '[{"id":"check_pg_ssl","value":"unknown"}]'
fi
