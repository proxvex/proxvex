#!/bin/sh
# Clone an existing LXC container for reconfigure.
#
# Steps:
# 1) Verify source container exists and was created by oci-lxc-deployer.
# 2) Determine target VMID (explicit, vm_id_start-based, or next free).
# 3) Clone source to target using vzdump + pct restore.
# 4) Output target VMID, source VMID, and installed addons.
#
# Inputs (templated):
#   - previouse_vm_id (required)
#   - vm_id (optional target id)
#   - vm_id_start (optional start index for auto-assigned IDs)
#
# Output:
#   - JSON to stdout with vm_id, previouse_vm_id, installed_addons

set -eu

SOURCE_VMID="{{ previouse_vm_id }}"
TARGET_VMID_INPUT="{{ vm_id }}"

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previouse_vm_id is required"
fi

if [ ! -f "$SOURCE_CONF" ]; then
  fail "Source container config not found: $SOURCE_CONF"
fi

# Verify source was created by oci-lxc-deployer
SOURCE_DESC=$(extract_description "$SOURCE_CONF")
SOURCE_CONF_TEXT=$(cat "$SOURCE_CONF" 2>/dev/null || echo "")
SOURCE_DESC_DECODED=$(decode_url "$SOURCE_DESC")
SOURCE_CONF_TEXT_DECODED=$(decode_url "$SOURCE_CONF_TEXT")

if ! check_managed_marker "$SOURCE_DESC" "$SOURCE_DESC_DECODED" "$SOURCE_CONF_TEXT" "$SOURCE_CONF_TEXT_DECODED"; then
  fail "Source container does not look like it was created by oci-lxc-deployer (missing notes marker)."
fi

# Determine target VMID
if [ -n "$TARGET_VMID_INPUT" ] && [ "$TARGET_VMID_INPUT" != "NOT_DEFINED" ] && [ "$TARGET_VMID_INPUT" != "" ]; then
  TARGET_VMID="$TARGET_VMID_INPUT"
else
  # Find next free VMID starting from vm_id_start
  _id_start="{{ vm_id_start }}"
  if [ -n "$_id_start" ] && [ "$_id_start" != "NOT_DEFINED" ]; then
    _id="$_id_start"
    _id_max=$(( _id_start + 1000 ))
    TARGET_VMID=""
    while [ "$_id" -le "$_id_max" ]; do
      if TARGET_VMID=$(pvesh get /cluster/nextid --vmid "$_id" 2>/dev/null); then
        break
      fi
      _id=$(( _id + 1 ))
    done
    if [ -z "$TARGET_VMID" ]; then
      echo "Error: no free VMID found between $_id_start and $_id_max" >&2
      exit 1
    fi
  else
    TARGET_VMID=$(pvesh get /cluster/nextid)
  fi
fi

if [ "$TARGET_VMID" = "$SOURCE_VMID" ]; then
  fail "Target VMID ($TARGET_VMID) must differ from source VMID ($SOURCE_VMID)"
fi

# Detect and temporarily remove bind mounts (pct clone cannot handle them)
BIND_MOUNTS_FILE=$(mktemp)
pct config "$SOURCE_VMID" | while IFS= read -r line; do
  # Match mpN: lines where the value starts with / (bind mount, not storage:volume)
  case "$line" in
    mp[0-9]*:\ /*)
      echo "$line" >> "$BIND_MOUNTS_FILE"
      mpkey=$(echo "$line" | cut -d: -f1)
      log "Temporarily removing bind mount $mpkey for cloning"
      pct set "$SOURCE_VMID" -delete "$mpkey" >&2 || log "Warning: failed to remove $mpkey"
      ;;
  esac
done

# Clone via vzdump + pct restore (workaround for PVE bug: pct snapshot fails
# with "snapshot feature is not available" when bind mounts are configured on ZFS subvol,
# even after temporarily removing them — see docs/pve-snapshot-bind-mount-bug.md)
DUMP_STORAGE="local"
log "Creating backup of container $SOURCE_VMID via vzdump..."
DUMP_OUTPUT=$(vzdump "$SOURCE_VMID" --storage "$DUMP_STORAGE" --compress zstd 2>&1) || fail "vzdump failed: $DUMP_OUTPUT"
echo "$DUMP_OUTPUT" >&2

# Extract dump file path from vzdump output
DUMP_FILE=$(echo "$DUMP_OUTPUT" | grep -o "/var/lib/vz/dump/vzdump-lxc-${SOURCE_VMID}-[^ ]*\.tar\.zst" | tail -1)
if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  # Fallback: find most recent dump
  DUMP_FILE=$(ls -t /var/lib/vz/dump/vzdump-lxc-${SOURCE_VMID}-*.tar.zst 2>/dev/null | head -1)
fi
if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  fail "Could not find vzdump file for container $SOURCE_VMID"
fi
log "Dump file: $DUMP_FILE"

# Detect rootfs storage from source container config
ROOTFS_STORAGE=$(pct config "$SOURCE_VMID" | grep "^rootfs:" | sed 's/^rootfs: *//; s/:.*//')
if [ -z "$ROOTFS_STORAGE" ]; then
  ROOTFS_STORAGE="local-zfs"
fi
log "Restoring to storage: $ROOTFS_STORAGE"

log "Restoring container $SOURCE_VMID backup as $TARGET_VMID..."
clone_ok=true
pct restore "$TARGET_VMID" "$DUMP_FILE" --storage "$ROOTFS_STORAGE" >&2 || clone_ok=false

# Clean up dump file
rm -f "$DUMP_FILE"
log "Dump file removed"

# Restore bind mounts on source (and target if clone succeeded)
if [ -s "$BIND_MOUNTS_FILE" ]; then
  while IFS= read -r line; do
    mpkey=$(echo "$line" | cut -d: -f1)
    mpval=$(echo "$line" | sed "s/^${mpkey}: //")
    log "Restoring bind mount $mpkey on source $SOURCE_VMID"
    pct set "$SOURCE_VMID" -"$mpkey" "$mpval" >&2 || log "Warning: failed to restore $mpkey on source"
    if [ "$clone_ok" = true ]; then
      log "Restoring bind mount $mpkey on target $TARGET_VMID"
      pct set "$TARGET_VMID" -"$mpkey" "$mpval" >&2 || log "Warning: failed to restore $mpkey on target"
    fi
  done < "$BIND_MOUNTS_FILE"
fi
rm -f "$BIND_MOUNTS_FILE"

if [ "$clone_ok" != true ]; then
  fail "Failed to clone container $SOURCE_VMID to $TARGET_VMID"
fi

# Source container keeps running — it will be destroyed by post-cleanup-previous-container

# Determine volume_storage from oci-lxc-deployer-volumes volume
# Search all storages for a volume whose name contains "oci-lxc-deployer-volumes"
VOLUME_STORAGE=""
for store in $(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print $1}'); do
  if pvesm list "$store" 2>/dev/null | grep -q "oci-lxc-deployer-volumes"; then
    VOLUME_STORAGE="$store"
    break
  fi
done
if [ -n "$VOLUME_STORAGE" ]; then
  log "Detected volume_storage=$VOLUME_STORAGE (from oci-lxc-deployer-volumes)"
else
  log "Warning: could not detect volume_storage (no oci-lxc-deployer-volumes found)"
fi

# Extract installed addons from source
INSTALLED_ADDONS=$(extract_addons "$SOURCE_DESC$SOURCE_CONF_TEXT")
log "Clone prepared: source=$SOURCE_VMID target=$TARGET_VMID volume_storage=$VOLUME_STORAGE addons=$INSTALLED_ADDONS"

printf '[{"id":"vm_id","value":"%s"},{"id":"previouse_vm_id","value":"%s"},{"id":"installed_addons","value":"%s"},{"id":"volume_storage","value":"%s"}]' \
  "$TARGET_VMID" "$SOURCE_VMID" "$INSTALLED_ADDONS" "$VOLUME_STORAGE"
