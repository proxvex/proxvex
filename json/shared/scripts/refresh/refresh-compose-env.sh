#!/bin/sh
# Patch a single env key in an already-deployed docker-compose.yml and restart the stack.
# Runs on PVE host (execute_on: ve).
#
# Inputs (substituted by deployer):
#   {{ vm_id }}, {{ hostname }}, {{ compose_project }}, {{ compose_key }}, {{ new_value }}
#
# Output: JSON on stdout, logs on stderr.

set -eu

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
COMPOSE_PROJECT="{{ compose_project }}"
COMPOSE_KEY="{{ compose_key }}"
NEW_VALUE="{{ new_value }}"

log() { echo "$@" >&2; }

SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")
VOLUME_DIR=$(resolve_host_volume "$SAFE_HOST" "oci-deployer")
COMPOSE_DIR="${VOLUME_DIR}/docker-compose/${COMPOSE_PROJECT}"
COMPOSE_FILE=""

for name in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
  if [ -f "${COMPOSE_DIR}/${name}" ]; then
    COMPOSE_FILE="${COMPOSE_DIR}/${name}"
    break
  fi
done

if [ -z "$COMPOSE_FILE" ]; then
  log "ERROR: no compose file found under ${COMPOSE_DIR}"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"compose file not found"}]\n'
  exit 1
fi

log "Patching ${COMPOSE_KEY} in ${COMPOSE_FILE}"

TMP_FILE="${COMPOSE_FILE}.refresh.tmp"

COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_KEY="$COMPOSE_KEY" NEW_VALUE="$NEW_VALUE" \
  python3 - <<'PYEOF' > "$TMP_FILE"
import os, sys, yaml

path = os.environ["COMPOSE_FILE"]
key = os.environ["COMPOSE_KEY"]
new_value = os.environ["NEW_VALUE"]

with open(path, "r") as f:
    data = yaml.safe_load(f)

patched = 0
services = (data or {}).get("services", {}) or {}
for svc_name, svc in services.items():
    env = svc.get("environment")
    if env is None:
        continue
    if isinstance(env, dict):
        if key in env:
            env[key] = new_value
            patched += 1
    elif isinstance(env, list):
        for i, item in enumerate(env):
            if isinstance(item, str) and item.startswith(key + "="):
                env[i] = f"{key}={new_value}"
                patched += 1

if patched == 0:
    sys.stderr.write(f"ERROR: key '{key}' not found in any service.environment\n")
    sys.exit(2)

sys.stderr.write(f"patched {patched} occurrence(s) of {key}\n")
yaml.safe_dump(data, sys.stdout, default_flow_style=False, sort_keys=False)
PYEOF

RC=$?
if [ $RC -ne 0 ]; then
  log "ERROR: patch script failed (rc=$RC)"
  rm -f "$TMP_FILE"
  printf '[{"id":"refresh_status","value":"error"},{"id":"refresh_detail","value":"patch failed"}]\n'
  exit 1
fi

mv "$TMP_FILE" "$COMPOSE_FILE"
log "Wrote patched compose file: $COMPOSE_FILE"

if pct status "$VM_ID" 2>/dev/null | grep -q running; then
  log "Container $VM_ID is running — restarting so docker-compose picks up the new env value"
  if pct restart "$VM_ID" >&2; then
    printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_compose_file","value":"%s"},{"id":"refresh_restarted","value":"true"}]\n' "$COMPOSE_FILE"
  else
    log "WARNING: pct restart $VM_ID failed — compose file is patched but new value not active yet"
    printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_compose_file","value":"%s"},{"id":"refresh_restarted","value":"false"},{"id":"refresh_detail","value":"file patched; manual restart needed (pct restart failed)"}]\n' "$COMPOSE_FILE"
  fi
else
  log "Container $VM_ID is not running — new value will take effect on next start"
  printf '[{"id":"refresh_status","value":"ok"},{"id":"refresh_compose_file","value":"%s"},{"id":"refresh_restarted","value":"false"}]\n' "$COMPOSE_FILE"
fi
