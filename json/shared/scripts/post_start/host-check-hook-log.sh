#!/bin/sh
# Check hookscript execution results from LXC console log.
#
# Waits for the on_start_container dispatcher to write a completion
# marker (SUCCESS or ERROR) to the console log, then outputs everything
# between START and completion markers.
#
# Self-skips if no on_start.d scripts exist in the container.
#
# Requires:
#   - vm_id: LXC container ID
#   - hostname: Container hostname
#
# Output: JSON to stdout, hookscript output to stderr

VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
LOG_PATH="/var/log/lxc/${HOSTNAME}-${VMID}.log"
TIMEOUT=120

# Quick check: does the container have on_start.d scripts?
# Retry because pct exec may not be ready immediately after container start
HAS_HOOKS=""
for _try in 1 2 3 4 5; do
  HAS_HOOKS=$(pct exec "$VMID" -- sh -c 'ls /etc/lxc-oci-deployer/on_start.d/*.sh 2>/dev/null | head -1' 2>/dev/null || true)
  [ -n "$HAS_HOOKS" ] && break
  sleep 2
done
if [ -z "$HAS_HOOKS" ]; then
  echo "No on_start.d hooks in container, skipping" >&2
  printf '[{"id":"hook_status","value":"no_hooks"}]\n'
  exit 0
fi

if [ ! -f "$LOG_PATH" ]; then
  echo "No console log found at ${LOG_PATH}" >&2
  printf '[{"id":"hook_status","value":"no_log"}]\n'
  exit 0
fi

# Wait for completion marker (hookscript may take time, e.g. acme.sh install)
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if grep -q "===OCI_HOOK_SUCCESS===" "$LOG_PATH" 2>/dev/null; then
    break
  fi
  if grep -q "===OCI_HOOK_ERROR===" "$LOG_PATH" 2>/dev/null; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# Extract and display log content between markers
if grep -q "===OCI_HOOK_START===" "$LOG_PATH" 2>/dev/null; then
  echo "--- on_start.d output ---" >&2
  sed -n '/===OCI_HOOK_START===/,/===OCI_HOOK_\(SUCCESS\|ERROR\)===/p' "$LOG_PATH" |
    grep -v "===OCI_HOOK_" >&2
  echo "--- end on_start.d output ---" >&2
fi

# Check result
if grep -q "===OCI_HOOK_SUCCESS===" "$LOG_PATH" 2>/dev/null; then
  echo "Hookscript completed successfully" >&2
  printf '[{"id":"hook_status","value":"success"}]\n'
elif grep -q "===OCI_HOOK_ERROR===" "$LOG_PATH" 2>/dev/null; then
  echo "ERROR: Hookscript reported errors (see output above)" >&2
  printf '[{"id":"hook_status","value":"error"}]\n'
  exit 1
else
  echo "WARNING: Hookscript did not complete within ${TIMEOUT}s" >&2
  # Show whatever is in the log
  if [ -f "$LOG_PATH" ]; then
    tail -20 "$LOG_PATH" >&2
  fi
  printf '[{"id":"hook_status","value":"timeout"}]\n'
fi
