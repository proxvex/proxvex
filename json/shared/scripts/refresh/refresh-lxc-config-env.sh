#!/bin/sh
# Patch a single lxc.environment.<NAME>=<VAL> entry in /etc/pve/lxc/<vmid>.conf on the PVE host.
# Runs on PVE host (execute_on: ve).
#
# Inputs (substituted by deployer):
#   {{ vm_id }}, {{ lxc_var_name }}, {{ new_value }}
#
# Output: JSON on stdout, logs on stderr.

set -eu

VM_ID="{{ vm_id }}"
VAR_NAME="{{ lxc_var_name }}"
NEW_VALUE="{{ new_value }}"

log() { echo "$@" >&2; }

CONF_FILE="/etc/pve/lxc/${VM_ID}.conf"

if [ ! -f "$CONF_FILE" ]; then
  log "ERROR: LXC config file not found: $CONF_FILE"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"conf file not found"}]\n'
  exit 1
fi

NEW_LINE="lxc.environment: ${VAR_NAME}=${NEW_VALUE}"

TMP_FILE="${CONF_FILE}.refresh.tmp"

awk -v var="$VAR_NAME" -v newline="$NEW_LINE" '
  BEGIN { patched = 0 }
  /^lxc\.environment:[ \t]+/ {
    match($0, /^lxc\.environment:[ \t]+/)
    rest = substr($0, RSTART + RLENGTH)
    split(rest, kv, "=")
    if (kv[1] == var) {
      print newline
      patched = 1
      next
    }
  }
  { print }
  END { if (!patched) exit 3 }
' "$CONF_FILE" > "$TMP_FILE"

RC=$?
if [ $RC -eq 3 ]; then
  log "Key ${VAR_NAME} not present in ${CONF_FILE} — appending"
  cp "$CONF_FILE" "$TMP_FILE"
  echo "$NEW_LINE" >> "$TMP_FILE"
elif [ $RC -ne 0 ]; then
  log "ERROR: awk failed (rc=$RC)"
  rm -f "$TMP_FILE"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"awk failed"}]\n'
  exit 1
fi

mv "$TMP_FILE" "$CONF_FILE"
log "Wrote patched LXC config: $CONF_FILE (${VAR_NAME} → updated)"

if pct status "$VM_ID" 2>/dev/null | grep -q running; then
  log "Container $VM_ID is running — restart needed for new env to take effect"
  printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_needs_restart","value":"true"}]\n'
else
  printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_needs_restart","value":"false"}]\n'
fi
