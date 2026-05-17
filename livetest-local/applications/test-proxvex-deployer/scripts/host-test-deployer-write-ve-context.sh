#!/bin/sh
# Write storagecontext.json into the test-deployer's /config volume before first start.
# Mirrors install-proxvex.sh:755-790 — the deployer reads this on boot to learn
# which PVE host it manages. Without this, the test deployer comes up with an
# empty context and refuses to run any task.
#
# Idempotent: if storagecontext.json already exists we leave it alone (upgrade case).
set -eu

VM_ID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
UID_VAL="{{ uid }}"
GID_VAL="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

[ "$MAPPED_UID" = "NOT_DEFINED" ] || [ -z "$MAPPED_UID" ] && MAPPED_UID="$UID_VAL"
[ "$MAPPED_GID" = "NOT_DEFINED" ] || [ -z "$MAPPED_GID" ] && MAPPED_GID="$GID_VAL"

SAFE_HOST=$(echo "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')

CONFIG_DIR=$(resolve_host_volume "$SAFE_HOST" "config" "$VM_ID")
if [ -z "$CONFIG_DIR" ] || [ ! -d "$CONFIG_DIR" ]; then
  echo "ERROR: cannot resolve /config host path for $HOSTNAME (vm_id=$VM_ID)" >&2
  exit 1
fi

PVE_HOST=$(hostname -f 2>/dev/null || hostname)
STORAGE_FILE="${CONFIG_DIR}/storagecontext.json"

if [ -f "$STORAGE_FILE" ]; then
  echo "storagecontext.json already exists at ${STORAGE_FILE} — leaving in place (upgrade?)" >&2
else
  cat > "$STORAGE_FILE" <<JSON
{
  "ve_${PVE_HOST}": {
    "host": "${PVE_HOST}",
    "port": 22,
    "current": true
  }
}
JSON
  chmod 640 "$STORAGE_FILE"
  chown "${MAPPED_UID}:${MAPPED_GID}" "$STORAGE_FILE" 2>/dev/null || true
  echo "Wrote ${STORAGE_FILE} with ve_${PVE_HOST}" >&2
fi

echo '[{"id":"test_deployer_ve_context_written","value":"true"}]'
