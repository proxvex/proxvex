#!/bin/sh
# Check LXC log for errors.
#
# Template variables:
#   vm_id - Container VM ID
#   hostname - Container hostname
#
# Outputs JSON array with check results.
# Exit 0 always (log errors are warnings, not fatal).

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"

LOG_FILE="/var/log/lxc/${HOSTNAME}-${VM_ID}.log"

if [ ! -f "$LOG_FILE" ]; then
    echo "CHECK: lxc_log_no_errors PASSED (no log file)" >&2
    printf '[{"id":"check_lxc_log","value":"no log file"}]'
    exit 0
fi

errors=$(grep -i error "$LOG_FILE" 2>/dev/null | head -10)

if [ -z "$errors" ]; then
    echo "CHECK: lxc_log_no_errors PASSED" >&2
    printf '[{"id":"check_lxc_log","value":"clean"}]'
else
    echo "CHECK: lxc_log_no_errors WARNING (errors found)" >&2
    echo "$errors" | head -5 >&2
    escaped=$(printf '%s' "$errors" | head -5 | sed 's/"/\\"/g' | tr '\n' ' ')
    printf '[{"id":"check_lxc_log","value":"%s"}]' "$escaped"
fi
