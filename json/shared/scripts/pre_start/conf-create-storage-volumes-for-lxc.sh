#!/bin/sh
# Create Proxmox-managed storage volumes and attach them (mpX) to an LXC container
#
# Each volume gets its own Proxmox-managed subvolume so pct snapshot
# captures all data. Volumes are mounted via pct set (not bind mounts).
#
# Requires:
#   - vm_id: LXC container ID (required)
#   - hostname: Container hostname (required when volumes are provided)
#   - volumes: key=container_path (one per line)
#   - volume_storage: Proxmox storage ID for volumes
#   - volume_size: default size for new volumes (e.g., 4G)
#   - volume_backup: include in backups (true/false)
#   - uid/gid/mapped_uid/mapped_gid: ownership mapping

set -eu

VMID="{{ vm_id }}"
HOSTNAME="{{ hostname }}"
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

# Merge addon_volumes with base volumes (if addon_volumes is set).
# Application volumes take precedence — addon entries with duplicate keys are silently skipped.
if [ -n "$ADDON_VOLUMES" ] && [ "$ADDON_VOLUMES" != "NOT_DEFINED" ] && [ "$ADDON_VOLUMES" != "" ]; then
  if [ -n "$VOLUMES" ]; then
    _base_keys=""
    _IFS="$IFS"; IFS='
'
    for _bline in $VOLUMES; do
      _bkey=$(echo "$_bline" | cut -d'=' -f1)
      [ -n "$_bkey" ] && _base_keys="$_base_keys $_bkey "
    done
    for _aline in $ADDON_VOLUMES; do
      _akey=$(echo "$_aline" | cut -d'=' -f1)
      case "$_base_keys" in
        *" $_akey "*) ;;
        *) VOLUMES="$VOLUMES
$_aline" ;;
      esac
    done
    IFS="$_IFS"
  else
    VOLUMES="$ADDON_VOLUMES"
  fi
  log "Merged addon_volumes with base volumes"
fi

if [ -n "$VOLUMES" ]; then
  if [ -z "$HOSTNAME" ] || [ "$HOSTNAME" = "NOT_DEFINED" ]; then
    fail "hostname is required when volumes are provided"
  fi
fi
if [ -z "$VOLUME_STORAGE" ] || [ "$VOLUME_STORAGE" = "NOT_DEFINED" ]; then
  fail "volume_storage is required"
fi

if [ -z "$VOLUME_SIZE" ] || [ "$VOLUME_SIZE" = "NOT_DEFINED" ]; then
  VOLUME_SIZE="4G"
fi

PCT_CONFIG=$(pct config "$VMID" 2>/dev/null || true)

is_number() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

map_id_via_idmap() {
  _kind="$1" # u or g
  _cid="$2"
  echo "$PCT_CONFIG" | awk -v kind="$_kind" -v cid="$_cid" '
    $1 ~ /^lxc\.idmap[:=]$/ {
      k=$2; c=$3+0; h=$4+0; l=$5+0;
      if (k==kind && cid>=c && cid < (c+l)) {
        print h + (cid - c);
        exit 0;
      }
    }
    END { }
  '
}

IS_UNPRIV=0
if echo "$PCT_CONFIG" | grep -aqE '^unprivileged:\s*1\s*$'; then
  IS_UNPRIV=1
fi

EFFECTIVE_UID="$UID_VALUE"
EFFECTIVE_GID="$GID_VALUE"

if [ -n "$MAPPED_UID" ] && [ "$MAPPED_UID" != "" ] && [ "$MAPPED_UID" != "NOT_DEFINED" ]; then
  EFFECTIVE_UID="$MAPPED_UID"
elif is_number "$UID_VALUE"; then
  MID=$(map_id_via_idmap u "$UID_VALUE")
  if [ -n "$MID" ]; then
    EFFECTIVE_UID="$MID"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    # Check if custom idmap exists (passthrough UIDs) - if so, UID is already
    # a 1:1 mapped passthrough and should be used directly on the host
    if printf '%s' "$PCT_CONFIG" | grep -q 'lxc\.idmap' 2>/dev/null; then
      EFFECTIVE_UID="$UID_VALUE"
    else
      EFFECTIVE_UID=$((100000 + UID_VALUE))
    fi
  fi
fi

if [ -n "$MAPPED_GID" ] && [ "$MAPPED_GID" != "" ] && [ "$MAPPED_GID" != "NOT_DEFINED" ]; then
  EFFECTIVE_GID="$MAPPED_GID"
elif is_number "$GID_VALUE"; then
  MID=$(map_id_via_idmap g "$GID_VALUE")
  if [ -n "$MID" ]; then
    EFFECTIVE_GID="$MID"
  elif [ "$IS_UNPRIV" -eq 1 ]; then
    if printf '%s' "$PCT_CONFIG" | grep -q 'lxc\.idmap' 2>/dev/null; then
      EFFECTIVE_GID="$GID_VALUE"
    else
      EFFECTIVE_GID=$((100000 + GID_VALUE))
    fi
  fi
fi

log "storage-volumes: vm_id=$VMID host=$HOSTNAME storage=$VOLUME_STORAGE uid=$UID_VALUE gid=$GID_VALUE host_uid=$EFFECTIVE_UID host_gid=$EFFECTIVE_GID"

# Track used mp indices
USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')
ASSIGNED_MPS=""
VOLUME_PERMS=""

find_next_mp() {
  for i in $(seq 0 31); do
    case " $USED_MPS $ASSIGNED_MPS " in
      *" $i "*) ;;
      *) echo "mp$i"; return 0 ;;
    esac
  done
  echo ""
}

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

# Refresh used mp list
USED_MPS=$(pct config "$VMID" | awk -F: '/^mp[0-9]+:/ { sub(/^mp/,"",$1); print $1 }' | tr '\n' ' ')

sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

get_existing_volid() {
  name="$1"
  storage_type="$2"
  if [ "$storage_type" = "zfspool" ]; then
    _volid=$(pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -Ei -- "subvol-[0-9]+-${name}$" \
      | head -n1 || true)
    if [ -n "$_volid" ]; then
      echo "$_volid"
      return 0
    fi
    _pool=$(get_zfs_pool)
    if [ -n "$_pool" ] && zfs list -H -o name "${_pool}/${name}" >/dev/null 2>&1; then
      echo "${VOLUME_STORAGE}:${name}"
      return 0
    fi
  elif [ "$storage_type" = "lvmthin" ] || [ "$storage_type" = "lvm" ]; then
    # LVM/lvmthin uses vm-<vmid>-* naming pattern
    pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -Ei -- "vm-[0-9]+-${name}$" \
      | head -n1 || true
  else
    pvesm list "$VOLUME_STORAGE" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -i -- "${name}" \
      | head -n1 || true
  fi
}

get_storage_type() {
  pvesm status -storage "$VOLUME_STORAGE" 2>/dev/null | awk 'NR==2 {print $2}' || true
}

extract_volid() {
  # pvesm alloc may output:
  #   "successfully created 'storage:volname'"
  # or just:
  #   "storage:volname"
  # Extract the actual volume ID
  _raw="$1"
  case "$_raw" in
    *"'"*)
      # Extract content between single quotes
      echo "$_raw" | sed -n "s/.*'\\([^']*\\)'.*/\\1/p"
      ;;
    *)
      # Return as-is (trim whitespace)
      echo "$_raw" | tr -d '[:space:]'
      ;;
  esac
}

alloc_volume() {
  _volname="$1"
  _size="$2"
  _owner_vmid="$3"
  if [ -z "$_owner_vmid" ]; then
    _owner_vmid="$VMID"
  fi
  _type=$(get_storage_type)
  _errfile=$(mktemp)
  _volid=""

  _raw=$(pvesm alloc "$VOLUME_STORAGE" "$_owner_vmid" "$_volname" "$_size" 2>"$_errfile" || true)
  _rc=$?
  if [ "$_rc" -eq 0 ] && [ -n "$_raw" ]; then
    _volid=$(extract_volid "$_raw")
    if [ -n "$_volid" ]; then
      rm -f "$_errfile"
      echo "$_volid"
      return 0
    fi
  fi

  if [ "$_type" = "zfspool" ]; then
    _raw=$(pvesm alloc "$VOLUME_STORAGE" "$_owner_vmid" "$_volname" "$_size" --format subvol 2>"$_errfile" || true)
    _rc=$?
    if [ "$_rc" -eq 0 ] && [ -n "$_raw" ]; then
      _volid=$(extract_volid "$_raw")
      if [ -n "$_volid" ]; then
        rm -f "$_errfile"
        echo "$_volid"
        return 0
      fi
    fi
  fi

  _err=$(cat "$_errfile" 2>/dev/null || true)
  rm -f "$_errfile"
  log "pvesm alloc failed (type=$_type): ${_err}"
  return 1
}

get_zfs_pool() {
  if [ -r /etc/pve/storage.cfg ]; then
    awk -v storage="$VOLUME_STORAGE" '
      $1 ~ /^zfspool:/ { inblock=0 }
      $1 == "zfspool:" && $2 == storage { inblock=1 }
      inblock && $1 == "pool" { print $2; exit }
    ' /etc/pve/storage.cfg 2>/dev/null || true
  fi
}

# Find a free (unformatted/unmounted) partition for storage
# Returns the partition device path if found, empty otherwise
find_free_partition() {
  # Look for partitions that are:
  # 1. Not mounted
  # 2. Not part of LVM
  # 3. Not swap
  # 4. Have no filesystem or are unformatted

  for dev in /dev/sd[a-z][0-9]* /dev/nvme[0-9]n[0-9]p[0-9]* /dev/vd[a-z][0-9]*; do
    [ -b "$dev" ] || continue

    # Skip if mounted
    if mount | grep -q "^$dev "; then
      continue
    fi

    # Skip if part of LVM
    if pvs "$dev" >/dev/null 2>&1; then
      continue
    fi

    # Skip if swap
    if grep -q "^$dev " /proc/swaps 2>/dev/null; then
      continue
    fi

    # Skip partitions smaller than 100MB (e.g. BIOS boot partition)
    _size_bytes=$(blockdev --getsize64 "$dev" 2>/dev/null || echo 0)
    if [ "$_size_bytes" -lt 104857600 ]; then
      continue
    fi

    # Check if it has a filesystem
    _fstype=$(blkid -o value -s TYPE "$dev" 2>/dev/null || true)

    # If no filesystem or filesystem is empty/unknown, it's potentially free
    if [ -z "$_fstype" ]; then
      echo "$dev"
      return 0
    fi
  done

  return 1
}

# Setup filesystem-based storage volumes
# Uses either a free partition or creates directories on root
setup_filesystem_storage() {
  _volname="$1"
  _mount_base="/mnt/pve-volumes"
  _mount_point="${_mount_base}/${_volname}"

  # Check if already set up
  if [ -d "$_mount_point" ]; then
    if mountpoint -q "$_mount_point" 2>/dev/null || [ -d "$_mount_point/config" ]; then
      echo "$_mount_point"
      return 0
    fi
  fi

  # Try to find a free partition
  _free_part=$(find_free_partition || true)

  if [ -n "$_free_part" ]; then
    log "Found free partition: $_free_part - formatting with ext4..."

    # Format with ext4
    mkfs.ext4 -q -L "pve-volumes" "$_free_part" >&2

    # Create mount point and mount
    mkdir -p "$_mount_point"
    mount "$_free_part" "$_mount_point"

    # Add to fstab for persistence
    if ! grep -q "$_free_part" /etc/fstab 2>/dev/null; then
      echo "$_free_part $_mount_point ext4 defaults 0 2" >> /etc/fstab
      log "Added $_free_part to /etc/fstab"
    fi

    echo "$_mount_point"
    return 0
  fi

  # No free partition - use root filesystem
  log "No free partition found - using root filesystem for volumes"

  # Create directory structure on root
  mkdir -p "$_mount_point"

  echo "$_mount_point"
  return 0
}

resolve_volume_path() {
  _volid="$1"
  _volname="$2"
  _type="$3"

  _path=""
  _i=0
  while [ "$_i" -lt 10 ]; do
    _path="$(pvesm path "$_volid" 2>/dev/null || true)"
    if [ -n "$_path" ]; then
      echo "$_path"
      return 0
    fi
    sleep 1
    _i=$(( _i + 1 ))
  done

  # Fallback for ZFS
  if [ "$_type" = "zfspool" ]; then
    _pool=$(get_zfs_pool)
    if [ -n "$_pool" ]; then
      _mp=$(zfs get -H -o value mountpoint "${_pool}/${_volname}" 2>/dev/null || true)
      if [ -z "$_mp" ] || [ "$_mp" = "-" ] || [ "$_mp" = "none" ]; then
        _mp=$(zfs list -H -o mountpoint "${_pool}/${_volname}" 2>/dev/null || true)
      fi
      if [ -n "$_mp" ] && [ "$_mp" != "-" ] && [ "$_mp" != "none" ]; then
        echo "$_mp"
        return 0
      fi
    fi
  fi

  # For non-ZFS storage types, we use setup_filesystem_storage() instead
  # This function is now only used for ZFS volumes

  return 1
}

STORAGE_TYPE=$(get_storage_type)
SAFE_HOST=$(sanitize_name "$HOSTNAME")
SHARED_OWNER_VMID="${SHARED_OWNER_VMID:-999999}"
SHARED_NAME_KEY="oci-lxc-deployer-volumes"
CERT_DIR_OVERRIDE=""

log "storage-volumes: vm_id=$VMID host=$HOSTNAME storage=$VOLUME_STORAGE type=$STORAGE_TYPE"

# --- Create per-container managed volumes ---
# Each volume key gets its own Proxmox-managed subvolume so pct snapshot
# captures all data automatically.

CERT_DIR_OVERRIDE=""

while IFS= read -r line <&3; do
  [ -z "$line" ] && continue
  VOLUME_KEY=$(echo "$line" | cut -d'=' -f1)
  VOLUME_REST=$(echo "$line" | cut -d'=' -f2-)
  VOLUME_PATH=$(echo "$VOLUME_REST" | cut -d',' -f1)
  VOLUME_OPTS=$(echo "$VOLUME_REST" | cut -d',' -f2-)
  [ -z "$VOLUME_KEY" ] && continue
  [ -z "$VOLUME_PATH" ] && continue
  VOLUME_PATH=$(printf '%s' "$VOLUME_PATH" | sed -E 's#^/*#/#')

  SAFE_KEY=$(sanitize_name "$VOLUME_KEY")

  # Check if mount target already exists on the container
  case " $EXISTING_TARGETS " in
    *" $VOLUME_PATH "*)
      log "Skipping $VOLUME_KEY ($VOLUME_PATH) - mount already exists"
      continue
      ;;
  esac

  # Allocate a Proxmox-managed subvolume for this volume
  # pvesm requires name format: subvol-<VMID>-<suffix>
  VOL_NAME="subvol-${VMID}-${SAFE_HOST}-${SAFE_KEY}"
  VOLID=$(get_existing_volid "$VOL_NAME" "$STORAGE_TYPE")
  if [ -z "$VOLID" ]; then
    log "Creating managed volume $VOL_NAME for $VOLUME_KEY (size $VOLUME_SIZE)"
    VOLID=$(alloc_volume "$VOL_NAME" "$VOLUME_SIZE" "$VMID" || true)
    if [ -z "$VOLID" ]; then
      fail "Failed to allocate volume $VOL_NAME"
    fi
  else
    log "Reusing existing volume $VOL_NAME"
  fi

  # Resolve host-side path for permissions
  VOLPATH=$(resolve_volume_path "$VOLID" "${VOLID#*:}" "$STORAGE_TYPE" || true)
  if [ -z "$VOLPATH" ]; then
    fail "Failed to resolve path for volume $VOLID"
  fi

  # Set permissions and ownership on the volume
  PERM=$(printf '%s' "$VOLUME_OPTS" | tr ',' '\n' | awk '/^[0-9]{3,4}$/ {print $1; exit}')
  if [ -n "$PERM" ]; then
    chmod "$PERM" "$VOLPATH" 2>/dev/null || true
    VOLUME_PERMS="${VOLUME_PERMS:+$VOLUME_PERMS
}${VOLUME_PATH}:${PERM}"
  fi

  # Parse per-volume uid:gid override (e.g. certs=/etc/ssl/addon,0700,0:0)
  VOL_UID_OVERRIDE=$(printf '%s' "$VOLUME_OPTS" | tr ',' '\n' | grep -E '^[0-9]+:[0-9]+$' | head -1 || true)
  if [ -n "$VOL_UID_OVERRIDE" ]; then
    _vol_uid=$(echo "$VOL_UID_OVERRIDE" | cut -d: -f1)
    _vol_gid=$(echo "$VOL_UID_OVERRIDE" | cut -d: -f2)
    # Map through idmap if unprivileged
    _eff_uid="$_vol_uid"
    _eff_gid="$_vol_gid"
    if is_number "$_vol_uid"; then
      _mid=$(map_id_via_idmap u "$_vol_uid")
      if [ -n "$_mid" ]; then
        _eff_uid="$_mid"
      elif [ "$IS_UNPRIV" -eq 1 ]; then
        if printf '%s' "$PCT_CONFIG" | grep -q 'lxc\.idmap' 2>/dev/null; then
          _eff_uid="$_vol_uid"
        else
          _eff_uid=$((_vol_uid + 100000))
        fi
      fi
    fi
    if is_number "$_vol_gid"; then
      _mid=$(map_id_via_idmap g "$_vol_gid")
      if [ -n "$_mid" ]; then
        _eff_gid="$_mid"
      elif [ "$IS_UNPRIV" -eq 1 ]; then
        if printf '%s' "$PCT_CONFIG" | grep -q 'lxc\.idmap' 2>/dev/null; then
          _eff_gid="$_vol_gid"
        else
          _eff_gid=$((_vol_gid + 100000))
        fi
      fi
    fi
    chown "$_eff_uid:$_eff_gid" "$VOLPATH" 2>/dev/null || true
  elif [ -n "$EFFECTIVE_UID" ] && [ -n "$EFFECTIVE_GID" ]; then
    chown "$EFFECTIVE_UID:$EFFECTIVE_GID" "$VOLPATH" 2>/dev/null || true
  fi

  # Track cert dir for downstream templates
  if [ "$VOLUME_PATH" = "/etc/ssl/addon" ]; then
    CERT_DIR_OVERRIDE="$VOLPATH"
  fi

  # Attach managed volume to container
  MP=$(find_next_mp)
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

# Output shared_volpath as empty — managed volumes are resolved via pvesm path
printf '[{"id":"volumes_attached","value":"true"},{"id":"shared_volpath","value":""},{"id":"cert_dir_override","value":"%s"}]\n' "$CERT_DIR_OVERRIDE"
