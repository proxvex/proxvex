#!/bin/sh
# Clone an existing LXC container for reconfigure.
#
# Steps:
# 1) Verify source container exists and was created by proxvex.
# 2) Determine target VMID (explicit, vm_id_start-based, or next free).
# 3) Clone source to target using vzdump + pct restore.
# 4) Output target VMID, source VMID, and installed addons.
#
# Inputs (templated):
#   - previous_vm_id (required)
#   - vm_id (optional target id)
#   - vm_id_start (optional start index for auto-assigned IDs)
#
# Output:
#   - JSON to stdout with vm_id, previous_vm_id, installed_addons

set -eu

SOURCE_VMID="{{ previous_vm_id }}"
TARGET_VMID_INPUT="{{ vm_id }}"

CONFIG_DIR="/etc/pve/lxc"
SOURCE_CONF="${CONFIG_DIR}/${SOURCE_VMID}.conf"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$SOURCE_VMID" ] || [ "$SOURCE_VMID" = "NOT_DEFINED" ]; then
  fail "previous_vm_id is required"
fi

if [ ! -f "$SOURCE_CONF" ]; then
  fail "Source container config not found: $SOURCE_CONF"
fi

# Verify source was created by proxvex
SOURCE_DESC=$(extract_description "$SOURCE_CONF")
SOURCE_CONF_TEXT=$(cat "$SOURCE_CONF" 2>/dev/null || echo "")
SOURCE_DESC_DECODED=$(decode_url "$SOURCE_DESC")
SOURCE_CONF_TEXT_DECODED=$(decode_url "$SOURCE_CONF_TEXT")

if ! check_managed_marker "$SOURCE_DESC" "$SOURCE_DESC_DECODED" "$SOURCE_CONF_TEXT" "$SOURCE_CONF_TEXT_DECODED"; then
  fail "Source container does not look like it was created by proxvex (missing notes marker)."
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

# Detect rootfs storage. Prefer the source container's own rootfs, fall back
# to whatever rootdir-content storage is actually configured on this host
# (LVM-thin on github-action CI, dir on minimal hosts, etc.). The previous
# fallback to a hardcoded `local-zfs` broke any non-ZFS deployment.
ROOTFS_STORAGE=$(pct config "$SOURCE_VMID" | grep "^rootfs:" | sed 's/^rootfs: *//; s/:.*//')
if [ -z "$ROOTFS_STORAGE" ]; then
  ROOTFS_STORAGE=$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print $1; exit}')
fi
if [ -z "$ROOTFS_STORAGE" ]; then
  fail "Cannot determine rootfs storage for clone (source vmid=$SOURCE_VMID, no rootdir-content storages found)"
fi

# Temporarily remove bind mounts (pct snapshot/clone refuse if any mp*
# points to a host path — bind mounts have no storage backend).
# Managed volumes (storage:subvol-...) are fine.
# We strip them from the config for snapshot/clone, then restore them on
# source (and copy them to target) afterwards. The running source container
# keeps its kernel mounts active until it is next stopped, so no data is lost.
BIND_MOUNTS_FILE=$(mktemp)
pct config "$SOURCE_VMID" | while IFS= read -r line; do
  case "$line" in
    mp[0-9]*:\ /*)
      echo "$line" >> "$BIND_MOUNTS_FILE"
      ;;
  esac
done

BIND_KEYS=""
if [ -s "$BIND_MOUNTS_FILE" ]; then
  BIND_KEYS=$(awk -F: '{print $1}' "$BIND_MOUNTS_FILE" | paste -sd, -)
  log "Temporarily removing bind mounts ($BIND_KEYS) from $SOURCE_VMID for snapshot/clone"
  pct set "$SOURCE_VMID" --delete "$BIND_KEYS" >&2 \
    || fail "Failed to delete bind mounts $BIND_KEYS from $SOURCE_VMID"
fi

restore_source_binds() {
  [ -s "$BIND_MOUNTS_FILE" ] || return 0
  while IFS= read -r line; do
    mpkey=$(echo "$line" | cut -d: -f1)
    mpval=$(echo "$line" | sed "s/^${mpkey}: //")
    log "Restoring bind mount $mpkey on source $SOURCE_VMID"
    pct set "$SOURCE_VMID" -"$mpkey" "$mpval" >&2 || true
  done < "$BIND_MOUNTS_FILE"
}

# Snapshot + clone so the source container (potentially the deployer itself)
# can keep running throughout. pct clone from a snapshot works on a running
# source on snapshot-capable storage (ZFS, LVM-thin, etc.). --full copies via
# zfs send|recv and produces a target that is independent of the snapshot.
SNAPNAME="oci-clone-$(date +%s)"
log "Creating snapshot $SNAPNAME on $SOURCE_VMID..."
if ! pct snapshot "$SOURCE_VMID" "$SNAPNAME" >&2; then
  restore_source_binds
  rm -f "$BIND_MOUNTS_FILE"
  fail "pct snapshot failed — source $SOURCE_VMID may have unsupported volumes"
fi

log "Cloning $SOURCE_VMID → $TARGET_VMID (snapshot $SNAPNAME, storage $ROOTFS_STORAGE, full)..."
clone_ok=true
pct clone "$SOURCE_VMID" "$TARGET_VMID" \
  --snapname "$SNAPNAME" \
  --full \
  --storage "$ROOTFS_STORAGE" >&2 \
  || clone_ok=false

# With --full the target is independent of the snapshot, so we can drop it.
pct delsnapshot "$SOURCE_VMID" "$SNAPNAME" >&2 \
  || log "Warning: could not delete snapshot $SNAPNAME on $SOURCE_VMID"

# Restore bind mounts on source — done whether clone succeeded or not.
restore_source_binds
rm -f "$BIND_MOUNTS_FILE"

if [ "$clone_ok" != true ]; then
  fail "Failed to clone container $SOURCE_VMID to $TARGET_VMID"
fi

# Copy bind mounts to target as well: the cloned config inherited none
# (we deleted them from source before snapshot). The new container needs the
# same host-path mounts to function.
TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"
if [ -f "$TARGET_CONF" ]; then
  pct config "$SOURCE_VMID" | while IFS= read -r line; do
    case "$line" in
      mp[0-9]*:\ /*)
        mpkey=$(echo "$line" | cut -d: -f1)
        mpval=$(echo "$line" | sed "s/^${mpkey}: //")
        log "Adding bind mount $mpkey to target $TARGET_VMID"
        pct set "$TARGET_VMID" -"$mpkey" "$mpval" >&2 || true
        ;;
    esac
  done
fi

# Keep cloned volume mounts on target.
# pct clone --full copies all volumes with their data (compose files,
# docker cache, app data). Template 150/160 will detect existing mounts
# and skip re-creation.

# Volume mounts are NOT restored on target — Template 150/160 in the
# pre_start flow creates fresh managed volumes for the new container.

# Source container keeps running — it will be destroyed by post-cleanup-previous-container

# Update lxc.console.logfile VMID in cloned config
TARGET_CONF="${CONFIG_DIR}/${TARGET_VMID}.conf"
if [ -f "$TARGET_CONF" ] && grep -q "lxc.console.logfile:" "$TARGET_CONF"; then
  sed -i "s/-${SOURCE_VMID}\.log/-${TARGET_VMID}.log/" "$TARGET_CONF"
  log "Updated lxc.console.logfile VMID: $SOURCE_VMID -> $TARGET_VMID"
fi

# Override the searchdomain Proxmox would otherwise inherit from the host's
# `hostname -d`. See conf-create-lxc-container.sh for the rationale —
# inherited search suffixes break bare-hostname DNS resolution from inside
# docker containers. Default empty.
SEARCHDOMAIN_VAL="{{ searchdomain }}"
[ "$SEARCHDOMAIN_VAL" = "NOT_DEFINED" ] && SEARCHDOMAIN_VAL=""
pct set "$TARGET_VMID" --searchdomain "$SEARCHDOMAIN_VAL" >&2 || \
  log "Warning: pct set --searchdomain on $TARGET_VMID failed"

# Determine volume_storage from rootfs storage
VOLUME_STORAGE="$ROOTFS_STORAGE"

# Extract installed addons from source
INSTALLED_ADDONS=$(extract_addons "$SOURCE_DESC$SOURCE_CONF_TEXT")

# Read the actual container hostname from the source config and emit it as
# an output. This overrides the (possibly stale or compose-project-suffixed)
# {{ hostname }} template variable for every downstream pre_start/post_start
# template — outputs win over inputs in the variable resolver. Without this,
# scripts that call resolve_host_volume "{{ hostname }}" "<key>" "<vmid>" on
# reconfigure would search for volumes named after the wrong hostname and
# fail.
SOURCE_HOSTNAME=$(awk '/^hostname:/ {print $2; exit}' "$SOURCE_CONF" 2>/dev/null || true)

log "Clone prepared: source=$SOURCE_VMID target=$TARGET_VMID volume_storage=$VOLUME_STORAGE addons=$INSTALLED_ADDONS hostname=$SOURCE_HOSTNAME"

printf '[{"id":"vm_id","value":"%s"},{"id":"previous_vm_id","value":"%s"},{"id":"installed_addons","value":"%s"},{"id":"volume_storage","value":"%s"},{"id":"hostname","value":"%s"}]' \
  "$TARGET_VMID" "$SOURCE_VMID" "$INSTALLED_ADDONS" "$VOLUME_STORAGE" "$SOURCE_HOSTNAME"
