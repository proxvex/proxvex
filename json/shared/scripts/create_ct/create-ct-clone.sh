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

# --- Rename managed volumes to hostname-based names ---
# pct restore creates volumes with generic names (disk-1, disk-2).
# We rename them to match the source naming convention (hostname-key)
# so resolve_host_volume can find them.
#
# Source: mp0: local-zfs:subvol-221-postgres-default-data,mp=/var/lib/postgresql/data
# After restore: mp0: local-zfs:subvol-250-disk-1,mp=/var/lib/postgresql/data
# After rename:  mp0: local-zfs:subvol-250-postgres-default-data,mp=/var/lib/postgresql/data

# Build mapping: source volume suffix -> target mpkey
# by comparing source config (original names) with target config (disk-N names)
SOURCE_MPS=$(pct config "$SOURCE_VMID" 2>/dev/null | grep -aE "^mp[0-9]+:.*${ROOTFS_STORAGE}:" || true)
TARGET_MPS=$(pct config "$TARGET_VMID" 2>/dev/null | grep -aE "^mp[0-9]+:.*${ROOTFS_STORAGE}:" || true)

if [ -n "$SOURCE_MPS" ] && [ -n "$TARGET_MPS" ]; then
  # Get ZFS pool name for rename operations
  _pool=""
  if [ -r /etc/pve/storage.cfg ]; then
    _pool=$(awk -v storage="$ROOTFS_STORAGE" '
      $1 ~ /^zfspool:/ { inblock=0 }
      $1 == "zfspool:" && $2 == storage { inblock=1 }
      inblock && $1 == "pool" { print $2; exit }
    ' /etc/pve/storage.cfg 2>/dev/null || true)
  fi

  if [ -n "$_pool" ]; then
    # Match source and target by mount point (mp=)
    echo "$TARGET_MPS" | while IFS= read -r target_line; do
      [ -z "$target_line" ] && continue
      _tgt_mpkey=$(echo "$target_line" | cut -d: -f1)
      _tgt_mp=$(echo "$target_line" | sed -E 's/.*mp=([^,]+).*/\1/')
      _tgt_volname=$(echo "$target_line" | sed -E "s/^${_tgt_mpkey}: *${ROOTFS_STORAGE}:([^,]+).*/\1/")

      # Find matching source mp by container mount path
      _src_volname=""
      echo "$SOURCE_MPS" | while IFS= read -r src_line; do
        _src_mp=$(echo "$src_line" | sed -E 's/.*mp=([^,]+).*/\1/')
        if [ "$_src_mp" = "$_tgt_mp" ]; then
          _src_mpkey=$(echo "$src_line" | cut -d: -f1)
          _src_volname=$(echo "$src_line" | sed -E "s/^${_src_mpkey}: *${ROOTFS_STORAGE}:([^,]+).*/\1/")
          echo "$_src_volname"
          break
        fi
      done | read -r _src_volname || true

      if [ -n "$_src_volname" ] && [ "$_tgt_volname" != "$_src_volname" ]; then
        # Extract suffix from source: subvol-221-postgres-default-data -> postgres-default-data
        _suffix=$(echo "$_src_volname" | sed -E "s/^subvol-[0-9]+-//")
        _new_volname="subvol-${TARGET_VMID}-${_suffix}"

        if [ "$_tgt_volname" != "$_new_volname" ]; then
          log "Renaming volume: ${_tgt_volname} -> ${_new_volname}"
          # Get all mount options after the volume name
          _tgt_opts=$(echo "$target_line" | sed -E "s/^${_tgt_mpkey}: *${ROOTFS_STORAGE}:[^,]+,?//")
          zfs rename "${_pool}/${_tgt_volname}" "${_pool}/${_new_volname}" 2>&1 >&2 || {
            log "Warning: zfs rename failed for ${_tgt_volname}"
            continue
          }
          pct set "$TARGET_VMID" -"${_tgt_mpkey}" "${ROOTFS_STORAGE}:${_new_volname},${_tgt_opts}" >&2 || {
            log "Warning: pct set failed for ${_tgt_mpkey}"
          }
        fi
      fi
    done
  fi
fi

# Source container keeps running — it will be destroyed by post-cleanup-previous-container

# Determine volume_storage from rootfs storage
VOLUME_STORAGE="$ROOTFS_STORAGE"

# Extract installed addons from source
INSTALLED_ADDONS=$(extract_addons "$SOURCE_DESC$SOURCE_CONF_TEXT")
log "Clone prepared: source=$SOURCE_VMID target=$TARGET_VMID volume_storage=$VOLUME_STORAGE addons=$INSTALLED_ADDONS"

printf '[{"id":"vm_id","value":"%s"},{"id":"previouse_vm_id","value":"%s"},{"id":"installed_addons","value":"%s"},{"id":"volume_storage","value":"%s"}]' \
  "$TARGET_VMID" "$SOURCE_VMID" "$INSTALLED_ADDONS" "$VOLUME_STORAGE"
