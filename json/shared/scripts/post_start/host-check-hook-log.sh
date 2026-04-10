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
#
# Output: JSON to stdout, hookscript output to stderr

VMID="{{ vm_id }}"
TIMEOUT=120

CONF_FILE="/etc/pve/lxc/${VMID}.conf"

# Find on_start.d scripts via oci-deployer mount (managed volume or bind mount)
OCI_DEPLOYER_PATH=""
_mp_line=$(grep 'mp=/etc/lxc-oci-deployer' "$CONF_FILE" 2>/dev/null | head -1)
if [ -n "$_mp_line" ]; then
  _mp_source=$(echo "$_mp_line" | sed -E 's/^mp[0-9]+: *//' | cut -d, -f1)
  case "$_mp_source" in
    /*)
      # Bind mount: source is a host path
      OCI_DEPLOYER_PATH="$_mp_source"
      ;;
    *)
      # Managed volume: resolve via pvesm path
      OCI_DEPLOYER_PATH=$(pvesm path "$_mp_source" 2>/dev/null || true)
      ;;
  esac
fi
if [ -z "$OCI_DEPLOYER_PATH" ]; then
  echo "No oci-deployer mount found, skipping" >&2
  printf '[{"id":"hook_status","value":"no_hooks"}]\n'
  exit 0
fi

HOOKS_DIR="${OCI_DEPLOYER_PATH}/on_start.d"
HAS_HOOKS=$(ls "$HOOKS_DIR"/*.sh 2>/dev/null | head -1)
if [ -z "$HAS_HOOKS" ]; then
  echo "No on_start.d hooks in container, skipping" >&2
  printf '[{"id":"hook_status","value":"no_hooks"}]\n'
  exit 0
fi

# Read log path from container config
LOG_FILE=$(awk -F": " '/^lxc\.console\.logfile:/{print $2}' "$CONF_FILE" 2>/dev/null)
if [ -z "$LOG_FILE" ] || [ ! -f "$LOG_FILE" ]; then
  echo "No console log found, skipping" >&2
  printf '[{"id":"hook_status","value":"no_log"}]\n'
  exit 0
fi

# Wait for completion marker (hookscript may take time, e.g. acme.sh install)
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if grep -q "===OCI_HOOK_SUCCESS===" "$LOG_FILE" 2>/dev/null; then
    break
  fi
  if grep -q "===OCI_HOOK_ERROR===" "$LOG_FILE" 2>/dev/null; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

# Extract and display log content between markers
if grep -q "===OCI_HOOK_START===" "$LOG_FILE" 2>/dev/null; then
  echo "--- on_start.d output ---" >&2
  sed -n '/===OCI_HOOK_START===/,/===OCI_HOOK_\(SUCCESS\|ERROR\)===/p' "$LOG_FILE" |
    grep -v "===OCI_HOOK_" >&2
  echo "--- end on_start.d output ---" >&2
fi

# Check result
if grep -q "===OCI_HOOK_SUCCESS===" "$LOG_FILE" 2>/dev/null; then
  echo "Hookscript completed successfully" >&2
  printf '[{"id":"hook_status","value":"success"}]\n'
elif grep -q "===OCI_HOOK_ERROR===" "$LOG_FILE" 2>/dev/null; then
  echo "ERROR: Hookscript reported errors (see output above)" >&2
  printf '[{"id":"hook_status","value":"error"}]\n'
  exit 1
else
  echo "WARNING: Hookscript did not complete within ${TIMEOUT}s" >&2
  if [ -f "$LOG_FILE" ]; then
    tail -20 "$LOG_FILE" >&2
  fi
  printf '[{"id":"hook_status","value":"timeout"}]\n'
fi
