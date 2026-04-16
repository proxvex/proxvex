#!/bin/sh
# Create Proxmox-managed storage volumes and attach them (mpX) to an LXC container
#
# Each volume gets its own Proxmox-managed subvolume so pct snapshot
# captures all data. Volumes are mounted via pct set (not bind mounts).
#
# Library: pve-common.sh, vol-common.sh
#
# Requires:
#   - vm_id: LXC container ID (required)
#   - hostname: Container hostname (required when volumes are provided)
#   - volumes: key=container_path (one per line)
#   - volume_storage: Proxmox storage ID for volumes (auto-detected from rootfs if empty)
#   - volume_size: default size for new volumes (e.g., 4G)
#   - volume_backup: include in backups (true/false)
#   - uid/gid/mapped_uid/mapped_gid: ownership mapping

set -eu

VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
PREV_VMID="{{ previouse_vm_id }}"
VOLUMES="{{ volumes }}"
ADDON_VOLUMES="{{ addon_volumes }}"
VOLUME_STORAGE="{{ volume_storage }}"
VOLUME_SIZE="{{ volume_size }}"
VOLUME_BACKUP="{{ volume_backup }}"
UID_VALUE="{{ uid }}"
GID_VALUE="{{ gid }}"
MAPPED_UID="{{ mapped_uid }}"
MAPPED_GID="{{ mapped_gid }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required for volume creation"
fi

if [ -z "$VOLUMES" ] || [ "$VOLUMES" = "NOT_DEFINED" ]; then
  VOLUMES=""
fi
if [ -z "$ADDON_VOLUMES" ] || [ "$ADDON_VOLUMES" = "NOT_DEFINED" ]; then
  ADDON_VOLUMES=""
fi

# Merge addon_volumes with base volumes using library function
VOLUMES=$(pve_merge_addon_volumes "$VOLUMES" "$ADDON_VOLUMES")
if [ -n "$ADDON_VOLUMES" ]; then
  log "Merged addon_volumes with base volumes"
fi

if [ -n "$VOLUMES" ]; then
  if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "NOT_DEFINED" ]; then
    fail "hostname is required when volumes are provided"
  fi
fi

# Auto-detect volume_storage from rootfs if not set
if [ -z "$VOLUME_STORAGE" ] || [ "$VOLUME_STORAGE" = "NOT_DEFINED" ]; then
  VOLUME_STORAGE=$(pct config "$VMID" 2>/dev/null | grep "^rootfs:" | sed 's/^rootfs: *//; s/:.*//')
  if [ -z "$VOLUME_STORAGE" ]; then
    fail "volume_storage is required and could not be auto-detected"
  fi
  log "Auto-detected volume_storage=$VOLUME_STORAGE from rootfs"
fi

if [ -z "$VOLUME_SIZE" ] || [ "$VOLUME_SIZE" = "NOT_DEFINED" ]; then
  VOLUME_SIZE="4G"
fi

PCT_CONFIG=$(pct config "$VMID" 2>/dev/null || true)

# Compute effective host-side UID/GID using library functions
EFFECTIVE_UID=$(pve_effective_uid "$PCT_CONFIG" "$UID_VALUE" "$MAPPED_UID")
EFFECTIVE_GID=$(pve_effective_gid "$PCT_CONFIG" "$GID_VALUE" "$MAPPED_GID")

log "storage-volumes: vm_id=$VMID host=$HOSTNAME storage=$VOLUME_STORAGE uid=$UID_VALUE gid=$GID_VALUE host_uid=$EFFECTIVE_UID host_gid=$EFFECTIVE_GID"

# Track used mp indices
USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')
ASSIGNED_MPS=""

# Stop container if running (mp changes require stop)
WAS_RUNNING=0
if pct status "$VMID" 2>/dev/null | grep -aq 'status: running'; then
  WAS_RUNNING=1
fi

NEEDS_STOP=0

# Collect existing mount targets - do NOT remove them (user may have created them)
TMPFILE=$(mktemp)
printf "%s\n" "$VOLUMES" > "$TMPFILE"
EXISTING_TARGETS=$(pct config "$VMID" 2>/dev/null | grep -aE "^mp[0-9]+:" | sed -E 's/.*mp=([^,]+).*/\1/' | tr '\n' ' ' || true)

STORAGE_TYPE=$(vol_get_storage_type "$VOLUME_STORAGE")
SAFE_HOST=$(pve_sanitize_name "$HOSTNAME")

# Backward-compat: clean up old bind-mount entries from template 160
# (single app volume with subdirectory bind mounts)
OLD_APP_VOLID=$(pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
  | awk -v pat="${SAFE_HOST}-app\$" '$1 ~ pat {print $1; exit}' || true)
if [ -n "$OLD_APP_VOLID" ]; then
  OLD_APP_PATH=$(pvesm path "$OLD_APP_VOLID" 2>/dev/null || true)
  if [ -n "$OLD_APP_PATH" ] && [ -d "$OLD_APP_PATH" ]; then
    pct config "$VMID" 2>/dev/null | grep -aE "^mp[0-9]+: ${OLD_APP_PATH}/" | while IFS= read -r mline; do
      mpkey=$(echo "$mline" | cut -d: -f1)
      if [ "$NEEDS_STOP" -eq 0 ] && [ "$WAS_RUNNING" -eq 1 ]; then
        pct stop "$VMID" >&2 || true
        NEEDS_STOP=1
      fi
      pct set "$VMID" -delete "$mpkey" >&2 2>/dev/null || true
      log "Cleaned up old bind mount $mpkey from app volume"
    done
    # Refresh used mp list after cleanup
    USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')
  fi
fi

CERT_DIR_OVERRIDE=""

log "storage-volumes: vm_id=$VMID host=$HOSTNAME storage=$VOLUME_STORAGE type=$STORAGE_TYPE"

# --- Create per-container managed volumes ---
# Each volume key gets its own Proxmox-managed subvolume so pct snapshot
# captures all data automatically.

while IFS= read -r line <&3; do
  [ -z "$line" ] && continue
  VOLUME_KEY=$(echo "$line" | cut -d'=' -f1)
  VOLUME_REST=$(echo "$line" | cut -d'=' -f2-)
  VOLUME_PATH=$(echo "$VOLUME_REST" | cut -d',' -f1)
  VOLUME_OPTS=$(echo "$VOLUME_REST" | cut -d',' -f2-)
  [ -z "$VOLUME_KEY" ] && continue
  [ -z "$VOLUME_PATH" ] && continue
  VOLUME_PATH=$(printf '%s' "$VOLUME_PATH" | sed -E 's#^/*#/#')

  SAFE_KEY=$(pve_sanitize_name "$VOLUME_KEY")

  # Check if mount target already exists on the container
  case " $EXISTING_TARGETS " in
    *" $VOLUME_PATH "*)
      log "Skipping $VOLUME_KEY ($VOLUME_PATH) - mount already exists"
      continue
      ;;
  esac

  # Volume naming strategy:
  # - Proxmox requires subvol-<VMID>-<suffix> format in .conf for pct start
  # - We use the suffix ({hostname}-{key}) as the stable reuse key
  # - On container destroy, vol_unlink_persistent() renames volumes to
  #   clean names (without VMID prefix) so they persist independently
  # - Reuse lookup checks clean name first, then conventional names
  VOL_SUFFIX="${SAFE_HOST}-${SAFE_KEY}"
  VOL_NAME="subvol-${VMID}-${VOL_SUFFIX}"

  # Reuse lookup: clean name (from previous destroy) -> conventional names
  VOLID=$(vol_get_existing "$VOLUME_STORAGE" "$VOL_SUFFIX" "$STORAGE_TYPE" "$PREV_VMID")
  if [ -z "$VOLID" ]; then
    log "Creating managed volume $VOL_NAME for $VOLUME_KEY (size $VOLUME_SIZE)"
    VOLID=$(vol_alloc "$VOLUME_STORAGE" "$VMID" "$VOL_NAME" "$VOLUME_SIZE" || true)
    if [ -z "$VOLID" ]; then
      fail "Failed to allocate volume $VOL_NAME"
    fi
  else
    log "Reusing existing volume $VOLID (suffix $VOL_SUFFIX)"
    # If the reused volume has a different VMID or is a clean name,
    # rename it to match the current VMID (Proxmox requires this format).
    _cur_volname="${VOLID#*:}"
    if [ "$_cur_volname" != "$VOL_NAME" ]; then
      NEW_VOLID=$(vol_rename "$VOLUME_STORAGE" "$VOLID" "$VOL_NAME" "$STORAGE_TYPE" || true)
      if [ -n "$NEW_VOLID" ]; then
        VOLID="$NEW_VOLID"
        log "Renamed volume to $VOL_NAME for current container"
      else
        log "Warning: rename to $VOL_NAME failed, keeping $VOLID"
      fi
    fi
  fi

  # Resolve host-side path for permissions
  VOLPATH=$(vol_resolve_path "$VOLID" "${VOLID#*:}" "$STORAGE_TYPE" "$VOLUME_STORAGE" || true)
  if [ -z "$VOLPATH" ]; then
    fail "Failed to resolve path for volume $VOLID"
  fi

  # Set permissions and ownership on the volume
  PERM=$(printf '%s' "$VOLUME_OPTS" | tr ',' '\n' | awk '/^[0-9]{3,4}$/ {print $1; exit}')
  if [ -n "$PERM" ]; then
    chmod -R "$PERM" "$VOLPATH" 2>/dev/null || true
  fi

  # Parse per-volume uid:gid override (e.g. certs=/etc/ssl/addon,0700,0:0)
  VOL_UID_OVERRIDE=$(printf '%s' "$VOLUME_OPTS" | tr ',' '\n' | grep -E '^[0-9]+:[0-9]+$' | head -1 || true)
  if [ -n "$VOL_UID_OVERRIDE" ]; then
    _vol_uid=$(echo "$VOL_UID_OVERRIDE" | cut -d: -f1)
    _vol_gid=$(echo "$VOL_UID_OVERRIDE" | cut -d: -f2)
    _eff_uid=$(pve_effective_uid "$PCT_CONFIG" "$_vol_uid" "")
    _eff_gid=$(pve_effective_gid "$PCT_CONFIG" "$_vol_gid" "")
    chown -R "$_eff_uid:$_eff_gid" "$VOLPATH" 2>/dev/null || true
  elif [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ]; then
    chown -R "$EFFECTIVE_UID:$EFFECTIVE_GID" "$VOLPATH" 2>/dev/null || true
  fi

  # Track cert dir for downstream templates
  if [ "$VOLUME_PATH" = "/etc/ssl/addon" ]; then
    CERT_DIR_OVERRIDE="$VOLPATH"
  fi

  # Attach managed volume to container
  MP=$(pve_find_next_mp "$USED_MPS" "$ASSIGNED_MPS")
  if [ -z "$MP" ]; then
    fail "No free mp slots available"
  fi
  ASSIGNED_MPS="$ASSIGNED_MPS ${MP#mp}"

  OPTS="mp=$VOLUME_PATH"
  if [ "$VOLUME_BACKUP" = "true" ] || [ "$VOLUME_BACKUP" = "1" ]; then
    OPTS="$OPTS,backup=1"
  fi

  if [ "$NEEDS_STOP" -eq 0 ] && [ "$WAS_RUNNING" -eq 1 ]; then
    pct stop "$VMID" >&2 || true
    NEEDS_STOP=1
  fi

  pct set "$VMID" -${MP} "${VOLID},${OPTS}" >&2

  log "Attached ${VOLID} (${VOLPATH}) to ${VOLUME_PATH} via ${MP}"

done 3< "$TMPFILE"

rm -f "$TMPFILE"

if [ "$WAS_RUNNING" -eq 1 ]; then
  pct start "$VMID" >/dev/null 2>&1 || true
fi

printf '[{"id":"volumes_attached","value":"true"},{"id":"cert_dir_override","value":"%s"}]\n' "$CERT_DIR_OVERRIDE"
