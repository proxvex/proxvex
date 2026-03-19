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
TIMEOUT=120

# Find oci-deployer volume path from container config (mp entry with mp=/etc/lxc-oci-deployer)
OCI_DEPLOYER_PATH=$(awk -F'[ ,]' '/mp=\/etc\/lxc-oci-deployer/{print $2}' "/etc/pve/lxc/${VMID}.conf" 2>/dev/null)
if [ -z "$OCI_DEPLOYER_PATH" ]; then
  echo "No oci-deployer bind mount found, skipping" >&2
  printf '[{"id":"hook_status","value":"no_hooks"}]\n'
  exit 0
fi

HOOK_LOG="${OCI_DEPLOYER_PATH}/hook.log"
HOOKS_DIR="${OCI_DEPLOYER_PATH}/on_start.d"

# Quick check: does the container have on_start.d scripts?
HAS_HOOKS=$(ls "$HOOKS_DIR"/*.sh 2>/dev/null | head -1)
if [ -z "$HAS_HOOKS" ]; then
  echo "No on_start.d hooks in container, skipping" >&2
  printf '[{"id":"hook_status","value":"no_hooks"}]\n'
  exit 0
fi

# Wait for completion marker (hookscript may take time, e.g. acme.sh install)
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if grep -q "===OCI_HOOK_SUCCESS===" "$HOOK_LOG" 2>/dev/null; then
    break
  fi
  if grep -q "===OCI_HOOK_ERROR===" "$HOOK_LOG" 2>/dev/null; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# Extract and display log content between markers
if grep -q "===OCI_HOOK_START===" "$HOOK_LOG" 2>/dev/null; then
  echo "--- on_start.d output ---" >&2
  sed -n '/===OCI_HOOK_START===/,/===OCI_HOOK_\(SUCCESS\|ERROR\)===/p' "$HOOK_LOG" |
    grep -v "===OCI_HOOK_" >&2
  echo "--- end on_start.d output ---" >&2
fi

# Check result
if grep -q "===OCI_HOOK_SUCCESS===" "$HOOK_LOG" 2>/dev/null; then
  echo "Hookscript completed successfully" >&2
  printf '[{"id":"hook_status","value":"success"}]\n'
elif grep -q "===OCI_HOOK_ERROR===" "$HOOK_LOG" 2>/dev/null; then
  echo "ERROR: Hookscript reported errors (see output above)" >&2
  printf '[{"id":"hook_status","value":"error"}]\n'
  exit 1
else
  echo "WARNING: Hookscript did not complete within ${TIMEOUT}s" >&2
  # Show whatever is in the log
  if [ -f "$HOOK_LOG" ]; then
    tail -20 "$HOOK_LOG" >&2
  fi
  printf '[{"id":"hook_status","value":"timeout"}]\n'
fi
