#!/bin/sh
# Patch a `KEY="value"` line in an on-start script under ${VOLUME_DIR}/on_start.d/.
# Runs on PVE host (execute_on: ve).
#
# Inputs (substituted by deployer):
#   {{ vm_id }}, {{ hostname }}, {{ script }}, {{ script_var }}, {{ new_value }}
#
# Output: JSON on stdout, logs on stderr.

set -eu

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
SCRIPT="{{ script }}"
VAR_NAME="{{ script_var }}"
NEW_VALUE="{{ new_value }}"

log() { echo "$@" >&2; }

SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")
VOLUME_DIR=$(resolve_host_volume "$SAFE_HOST" "oci-deployer")
TARGET_FILE="${VOLUME_DIR}/on_start.d/${SCRIPT}"

if [ ! -f "$TARGET_FILE" ]; then
  log "ERROR: on-start script not found: $TARGET_FILE"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"script not found"}]\n'
  exit 1
fi

log "Patching ${VAR_NAME} in ${TARGET_FILE}"

TMP_FILE="${TARGET_FILE}.refresh.tmp"

# awk: find line matching ^<VAR_NAME>="..."$ and replace its value. Leave other
# lines untouched. If the variable is not found, exit 3 so the caller can log
# a clear error.
awk -v var="$VAR_NAME" -v newval="$NEW_VALUE" '
  BEGIN { patched = 0 }
  {
    if (match($0, "^"var"=\"[^\"]*\"$") == 1) {
      print var"=\""newval"\""
      patched = 1
      next
    }
    print
  }
  END { if (!patched) exit 3 }
' "$TARGET_FILE" > "$TMP_FILE"

RC=$?
if [ $RC -eq 3 ]; then
  log "ERROR: variable '${VAR_NAME}' not found in ${TARGET_FILE}"
  rm -f "$TMP_FILE"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"variable not found"}]\n'
  exit 1
elif [ $RC -ne 0 ]; then
  log "ERROR: awk failed (rc=$RC)"
  rm -f "$TMP_FILE"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"awk failed"}]\n'
  exit 1
fi

# Preserve file mode (scripts are usually executable).
chmod --reference="$TARGET_FILE" "$TMP_FILE" 2>/dev/null || chmod 755 "$TMP_FILE"
mv "$TMP_FILE" "$TARGET_FILE"
log "Wrote patched script: $TARGET_FILE (${VAR_NAME} updated)"

if pct status "$VM_ID" 2>/dev/null | grep -q running; then
  log "Container $VM_ID is running — restarting so the on-start script re-runs with the new value"
  if pct restart "$VM_ID" >&2; then
    printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_restarted","value":"true"}]\n'
  else
    log "WARNING: pct restart $VM_ID failed — file is patched but new value not active yet"
    printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_restarted","value":"false"},{"id":"refresh_detail","value":"file patched; manual restart needed (pct restart failed)"}]\n'
  fi
else
  log "Container $VM_ID is not running — new value will take effect on next start"
  printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_restarted","value":"false"}]\n'
fi
