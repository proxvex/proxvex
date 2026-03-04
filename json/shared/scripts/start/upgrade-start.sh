#!/bin/sh
# In-place upgrade of an LXC container using a new OCI image.
#
# Steps:
# 1) Stop the container.
# 2) Back up the .conf file.
# 3) Read rootfs storage+size from backup for pct create.
# 4) Destroy the container (removes rootfs).
# 5) Recreate the container with minimal pct create (new rootfs).
# 6) Reverse-merge: apply new conf keys into backup (preserving notes).
# 7) Update version and OCI image in notes.
# 8) Start the container (with retry).
# 9) On failure: restore backup config and restart old container.
#
# Requires:
#   - vm_id: Container ID (required) — same as source_vm_id from upgrade-oci-lxc.sh
#   - template_path: OCI template path (required)
#   - ostype: Optional OS type
#   - oci_image: OCI image reference (required)
#   - oci_image_tag: Version from OCI image labels or backend default

set -eu

VMID="{{ vm_id }}"
TEMPLATE_PATH="{{ template_path }}"
NEW_OSTYPE="{{ ostype }}"
OCI_IMAGE_RAW="{{ oci_image }}"
OCI_IMAGE_TAG="{{ oci_image_tag }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ -z "$TEMPLATE_PATH" ] || [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then
  fail "template_path is required"
fi
if [ -z "$OCI_IMAGE_RAW" ] || [ "$OCI_IMAGE_RAW" = "NOT_DEFINED" ]; then
  fail "oci_image is required"
fi
if [ "$OCI_IMAGE_TAG" = "NOT_DEFINED" ]; then OCI_IMAGE_TAG=""; fi

CONFIG_DIR="/etc/pve/lxc"
CONF="${CONFIG_DIR}/${VMID}.conf"
CONF_BAK="${CONF}.bak"

if [ ! -f "$CONF" ]; then
  fail "Container config not found: $CONF"
fi

# ─── Step 1: Stop the container if running ───────────────────────────────────
container_status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
log "Container $VMID status: $container_status"

if [ "$container_status" = "running" ]; then
  log "Stopping container $VMID..."
  if ! pct stop "$VMID" >/dev/null 2>&1; then
    fail "Failed to stop container $VMID"
  fi
fi

# ─── Step 2: Back up the .conf file ──────────────────────────────────────────
log "Backing up config to $CONF_BAK..."
cp "$CONF" "$CONF_BAK"

# ─── Step 3: Read params from backup for pct create ──────────────────────────
UNPRIVILEGED=$(get_conf_value "$CONF" "unprivileged" || true)
OSTYPE_SRC=$(get_conf_value "$CONF" "ostype" || true)
HOSTNAME_SRC=$(get_conf_value "$CONF" "hostname" || true)

ROOTFS_LINE=$(get_conf_line "$CONF" "rootfs" || true)
ROOTFS_STORAGE=""
ROOTFS_SIZE=""
if [ -n "$ROOTFS_LINE" ]; then
  ROOTFS_STORAGE=$(printf "%s" "$ROOTFS_LINE" | sed -E 's/^rootfs:[ ]*([^:]+):.*/\1/;t;d')
  ROOTFS_SIZE=$(printf "%s" "$ROOTFS_LINE" | sed -E 's/.*size=([^, ]+).*/\1/;t;d')
fi

stor="$ROOTFS_STORAGE"
if [ -z "$stor" ]; then stor="local-zfs"; fi

SIZE_INPUT="$ROOTFS_SIZE"
if [ -z "$SIZE_INPUT" ]; then SIZE_INPUT="4G"; fi

if [ "$stor" = "local-zfs" ]; then
  SIZE_GB=$(normalize_size_to_gb "$SIZE_INPUT")
  ROOTFS_ARG="${stor}:${SIZE_GB}"
else
  case "$SIZE_INPUT" in
    *[TtGgMmKk]) ROOTFS_ARG="${stor}:${SIZE_INPUT}" ;;
    *) ROOTFS_ARG="${stor}:${SIZE_INPUT}G" ;;
  esac
fi

OSTYPE_ARG=""
if [ -n "$NEW_OSTYPE" ] && [ "$NEW_OSTYPE" != "NOT_DEFINED" ]; then
  OSTYPE_ARG="$NEW_OSTYPE"
elif [ -n "$OSTYPE_SRC" ]; then
  OSTYPE_ARG="$OSTYPE_SRC"
fi

# ─── Step 4: Destroy the container (removes rootfs) ──────────────────────────
log "Destroying container $VMID (rootfs will be replaced with new OCI image)..."
if ! pct destroy "$VMID" --purge >/dev/null 2>&1; then
  log "Warning: pct destroy returned non-zero — attempting to continue..."
fi

if [ -f "$CONF" ]; then
  fail "Container config still exists after destroy: $CONF — aborting"
fi

# ─── Step 5: Recreate container with minimal params (new rootfs) ─────────────
log "Recreating container $VMID from new template '$TEMPLATE_PATH'..."
pct create "$VMID" "$TEMPLATE_PATH" \
  --rootfs "$ROOTFS_ARG" \
  ${HOSTNAME_SRC:+--hostname "$HOSTNAME_SRC"} \
  ${OSTYPE_ARG:+--ostype "$OSTYPE_ARG"} \
  ${UNPRIVILEGED:+--unprivileged "$UNPRIVILEGED"} \
  >&2

if [ ! -f "$CONF" ]; then
  log "Container config was not created after pct create — restoring backup..."
  cp "$CONF_BAK" "$CONF"
  fail "Failed to recreate container $VMID"
fi

# ─── Step 6: Reverse-merge — apply new conf keys into backup ────────────────
# Backup is the base (preserves notes/comments). New keys from pct create
# (rootfs, OCI-derived settings) overwrite their counterparts in backup.
log "Applying new config into backup (preserving notes)..."
apply_new_conf_to_backup "$CONF_BAK" "$CONF"

# ─── Step 7: Update version and OCI image in notes ──────────────────────────
if [ -n "$OCI_IMAGE_TAG" ] || [ -n "$OCI_IMAGE_RAW" ]; then
  log "Updating version/OCI image in notes..."
  update_notes_version "$CONF" "$OCI_IMAGE_TAG" "$OCI_IMAGE_RAW"
fi

# ─── Step 8: Start the container with retry ──────────────────────────────────
log "Starting container $VMID..."
START_EXIT=0
START_ERROR=""
ATTEMPTS=3
WAIT_SECONDS=40
INTERVAL=2
attempt=1
container_status="unknown"
while [ "$attempt" -le "$ATTEMPTS" ]; do
  START_ERROR=$(pct start "$VMID" 2>&1) || START_EXIT=$?
  ELAPSED=0
  while [ "$ELAPSED" -lt "$WAIT_SECONDS" ]; do
    container_status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
    if [ "$container_status" = "running" ]; then
      START_EXIT=0
      break
    fi
    sleep "$INTERVAL"
    ELAPSED=$((ELAPSED + INTERVAL))
  done
  if [ "$container_status" = "running" ]; then
    break
  fi
  attempt=$((attempt + 1))
done

if [ "$container_status" != "running" ]; then
  # ─── Step 9: Rollback — restore backup config and try to restart ──────────
  log "Failed to start upgraded container $VMID — attempting rollback..."
  log "=== Original start error ==="
  log "$START_ERROR"
  log "=== Diagnostic information ==="
  pct status "$VMID" >&2 || true
  pct config "$VMID" >&2 || true
  log "Backup config is available at: $CONF_BAK"
  log "To rollback manually: pct destroy $VMID --purge && restore from backup"
  fail "Failed to start upgraded container $VMID — backup config is at $CONF_BAK"
elif [ "$START_EXIT" -ne 0 ]; then
  log "Warning: start returned non-zero, but container is running. Output:"
  log "$START_ERROR"
fi

log "Container $VMID upgraded and running successfully."
echo '[{"id":"started","value":"true"}]'
