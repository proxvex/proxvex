#!/bin/sh
# Copy-upgrade: create target LXC from source config + new OCI image,
# then stop source and start target. If start fails, restart source.
#
# Steps:
# 1) Create target container with minimal pct create (new rootfs).
# 2) Reverse-merge: apply new conf keys into source config (preserving notes).
# 3) Update VMID references in notes (source → target).
# 4) Update version and OCI image in notes.
# 5) Stop source, start target.
# 6) On failure: restart source.
#
# Requires:
#   - source_vm_id: Source container ID (required)
#   - vm_id: Target container ID (required)
#   - template_path: OCI template path (required)
#   - ostype: Optional OS type for target container
#   - oci_image: OCI image reference (required)
#   - oci_image_tag: Version from OCI image labels or backend default

set -eu

SOURCE_VMID="{{ source_vm_id }}"
TARGET_VMID="{{ vm_id }}"
TEMPLATE_PATH="{{ template_path }}"
NEW_OSTYPE="{{ ostype }}"
OCI_IMAGE_RAW="{{ oci_image }}"
OCI_IMAGE_TAG="{{ oci_image_tag }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "source_vm_id is required"
fi
if [ -z "$TARGET_VMID" ] || [ "$TARGET_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id (target) is required"
fi
if [ -z "$TEMPLATE_PATH" ] || [ "$TEMPLATE_PATH" = "NOT_DEFINED" ]; then
  fail "template_path is required"
fi
if [ -z "$OCI_IMAGE_RAW" ] || [ "$OCI_IMAGE_RAW" = "NOT_DEFINED" ]; then
  fail "oci_image is required"
fi
if [ "$OCI_IMAGE_TAG" = "NOT_DEFINED" ]; then OCI_IMAGE_TAG=""; fi

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"
TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"

if [ ! -f "$SOURCE_CONF" ]; then
  fail "Source container config not found: $SOURCE_CONF"
fi

# ─── Step 1: Create target container with minimal pct create ─────────────────
create_target_from_source() {
  if [ -f "$TARGET_CONF" ]; then
    log "Target config already exists: $TARGET_CONF (skipping create)"
    return 0
  fi

  SOURCE_ROOTFS_LINE=$(get_conf_line "$SOURCE_CONF" "rootfs" || true)
  SOURCE_ROOTFS_STORAGE=""
  SOURCE_ROOTFS_SIZE=""
  if [ -n "$SOURCE_ROOTFS_LINE" ]; then
    SOURCE_ROOTFS_STORAGE=$(printf "%s" "$SOURCE_ROOTFS_LINE" | sed -E 's/^rootfs:[ ]*([^:]+):.*/\1/;t;d')
    SOURCE_ROOTFS_SIZE=$(printf "%s" "$SOURCE_ROOTFS_LINE" | sed -E 's/.*size=([^, ]+).*/\1/;t;d')
  fi

  stor="$SOURCE_ROOTFS_STORAGE"
  if [ -z "$stor" ]; then stor="local-zfs"; fi

  SIZE_INPUT="$SOURCE_ROOTFS_SIZE"
  if [ -z "$SIZE_INPUT" ]; then SIZE_INPUT="4G"; fi

  if [ "$stor" = "local-zfs" ]; then
    SIZE_GB=$(normalize_size_to_gb "$SIZE_INPUT")
    ROOTFS="${stor}:${SIZE_GB}"
  else
    case "$SIZE_INPUT" in
      *[TtGgMmKk]) ROOTFS="${stor}:${SIZE_INPUT}" ;;
      *) ROOTFS="${stor}:${SIZE_INPUT}G" ;;
    esac
  fi

  UNPRIVILEGED=$(get_conf_value "$SOURCE_CONF" "unprivileged" || true)
  OSTYPE_SRC=$(get_conf_value "$SOURCE_CONF" "ostype" || true)
  HOSTNAME_SRC=$(get_conf_value "$SOURCE_CONF" "hostname" || true)

  OSTYPE_ARG=""
  if [ -n "$NEW_OSTYPE" ] && [ "$NEW_OSTYPE" != "NOT_DEFINED" ]; then
    OSTYPE_ARG="$NEW_OSTYPE"
  elif [ -n "$OSTYPE_SRC" ]; then
    OSTYPE_ARG="$OSTYPE_SRC"
  fi

  log "Creating target container $TARGET_VMID from template '$TEMPLATE_PATH'"
  pct create "$TARGET_VMID" "$TEMPLATE_PATH" \
    --rootfs "$ROOTFS" \
    ${HOSTNAME_SRC:+--hostname "$HOSTNAME_SRC"} \
    ${OSTYPE_ARG:+--ostype "$OSTYPE_ARG"} \
    ${UNPRIVILEGED:+--unprivileged "$UNPRIVILEGED"} \
    >&2

  if [ ! -f "$TARGET_CONF" ]; then
    fail "Target container config was not created: $TARGET_CONF"
  fi
}

create_target_from_source

# ─── Step 2: Reverse-merge — apply new conf keys into source config ──────────
log "Applying new config into source config (preserving notes)..."
apply_new_conf_to_backup "$SOURCE_CONF" "$TARGET_CONF"

# ─── Step 3: Update VMID references (source → target) ───────────────────────
if [ "$SOURCE_VMID" != "$TARGET_VMID" ]; then
  log "Updating VMID references: $SOURCE_VMID → $TARGET_VMID..."
  update_notes_vmid "$TARGET_CONF" "$SOURCE_VMID" "$TARGET_VMID"
fi

# ─── Step 4: Update version and OCI image in notes ──────────────────────────
if [ -n "$OCI_IMAGE_TAG" ] || [ -n "$OCI_IMAGE_RAW" ]; then
  log "Updating version/OCI image in notes..."
  update_notes_version "$TARGET_CONF" "$OCI_IMAGE_TAG" "$OCI_IMAGE_RAW"
fi

# ─── Step 5: Stop source, start target ───────────────────────────────────────
source_status=$(pct status "$SOURCE_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")

log "Source $SOURCE_VMID status: $source_status"
log "Target $TARGET_VMID status: $target_status"

# Stop source if running
if [ "$source_status" = "running" ]; then
  log "Stopping source container $SOURCE_VMID..."
  if ! pct stop "$SOURCE_VMID" >/dev/null 2>&1; then
    fail "Failed to stop source container $SOURCE_VMID"
  fi
fi

# Start target if not running
if [ "$target_status" != "running" ]; then
  log "Starting target container $TARGET_VMID..."
  START_EXIT=0
  START_ERROR=""
  ATTEMPTS=3
  WAIT_SECONDS=40
  INTERVAL=2
  attempt=1
  while [ "$attempt" -le "$ATTEMPTS" ]; do
    START_ERROR=$(pct start "$TARGET_VMID" 2>&1) || START_EXIT=$?
    ELAPSED=0
    while [ "$ELAPSED" -lt "$WAIT_SECONDS" ]; do
      target_status=$(pct status "$TARGET_VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
      if [ "$target_status" = "running" ]; then
        START_EXIT=0
        break
      fi
      sleep "$INTERVAL"
      ELAPSED=$((ELAPSED + INTERVAL))
    done
    if [ "$target_status" = "running" ]; then
      break
    fi
    attempt=$((attempt + 1))
  done
  if [ "$target_status" != "running" ]; then
    # ─── Step 6: Rollback — restart source ───────────────────────────────────
    log "Failed to start target container $TARGET_VMID. Trying to restart source $SOURCE_VMID..."
    pct start "$SOURCE_VMID" >/dev/null 2>&1 || log "Warning: failed to restart source $SOURCE_VMID"
    log "=== Original error message ==="
    log "$START_ERROR"
    log "=== Diagnostic information ==="
    pct status "$TARGET_VMID" >&2 || true
    pct config "$TARGET_VMID" >&2 || true
    fail "Failed to start target container $TARGET_VMID"
  elif [ "$START_EXIT" -ne 0 ]; then
    log "Warning: start returned non-zero, but container is running. Output:"
    log "$START_ERROR"
  fi
fi

echo '[{"id":"started","value":"true"}]'
