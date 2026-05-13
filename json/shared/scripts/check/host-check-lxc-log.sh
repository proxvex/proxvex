#!/bin/sh
# Check LXC log for errors.
#
# Template variables:
#   vm_id - Container VM ID
#   hostname - Container hostname
#
# Outputs JSON array with check results.
# Exits non-zero when error lines are found so the scenario fails — a silent
# "WARNING" exit hid real install failures (e.g. modbus2mqtt mTLS misconfig
# logged "no mqttserverurl defined" without affecting test status).

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
    exit 0
fi

echo "CHECK: lxc_log_no_errors FAILED (errors found)" >&2
echo "$errors" | head -5 >&2
# JSON requires control characters (\x00-\x1F) and backslashes to be
# escaped. LXC logs commonly contain ANSI color codes, tabs and carriage
# returns — a hand-rolled sed replace only catches double quotes and
# produces invalid JSON ("Bad control character in string literal").
# Use python's json.dumps for a robust escape.
escaped=$(printf '%s' "$errors" | head -5 | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))')
printf '[{"id":"check_lxc_log","value":%s}]' "$escaped"
exit 1
