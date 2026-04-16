#!/bin/sh
# Volume Management Common Library
#
# Helper functions for Proxmox storage volume management.
# Requires: pve-common.sh (must be listed first in library array)
# It contains only function definitions - no direct execution.
#
# Main functions:
#   1. vol_get_storage_type - Get storage backend type (zfspool, lvmthin, lvm, dir)
#   2. vol_get_zfs_pool - Get ZFS pool name from storage.cfg
#   3. vol_extract_volid - Extract volume ID from pvesm alloc output
#   4. vol_alloc - Allocate a new Proxmox-managed volume
#   5. vol_resolve_path - Resolve host-side path for a volume
#   6. vol_get_existing - Find existing volume by name suffix

# Get storage backend type for a given storage name.
# Args: $1=storage_name
# Prints: zfspool, lvmthin, lvm, dir, etc.
vol_get_storage_type() {
  pvesm status -storage "$1" 2>/dev/null | awk 'NR==2 {print $2}' || true
}

# Get ZFS pool name from /etc/pve/storage.cfg.
# Args: $1=storage_name
vol_get_zfs_pool() {
  [ -r /etc/pve/storage.cfg ] || return
  awk -v storage="$1" '
    $1 ~ /^zfspool:/ { inblock=0 }
    $1 == "zfspool:" && $2 == storage { inblock=1 }
    inblock && $1 == "pool" { print $2; exit }
  ' /etc/pve/storage.cfg 2>/dev/null || true
}

# Get LVM volume group name from /etc/pve/storage.cfg.
# Args: $1=storage_name
vol_get_lvm_vgname() {
  [ -r /etc/pve/storage.cfg ] || return
  awk -v storage="$1" '
    $1 ~ /^(lvmthin|lvm):/ { inblock=0 }
    ($1 == "lvmthin:" || $1 == "lvm:") && $2 == storage { inblock=1 }
    inblock && $1 == "vgname" { print $2; exit }
  ' /etc/pve/storage.cfg 2>/dev/null || true
}

# Get directory path from /etc/pve/storage.cfg for dir-type storage.
# Args: $1=storage_name
vol_get_dir_path() {
  [ -r /etc/pve/storage.cfg ] || return
  awk -v storage="$1" '
    $1 == "dir:" { inblock=0 }
    $1 == "dir:" && $2 == storage { inblock=1 }
    inblock && $1 == "path" { print $2; exit }
  ' /etc/pve/storage.cfg 2>/dev/null || true
}

# Extract volume ID from pvesm alloc output.
# pvesm alloc may output: "successfully created 'storage:volname'" or just "storage:volname"
# Args: $1=raw_output
vol_extract_volid() {
  case "$1" in
    *"'"*)
      echo "$1" | sed -n "s/.*'\\([^']*\\)'.*/\\1/p"
      ;;
    *)
      echo "$1" | tr -d '[:space:]'
      ;;
  esac
}

# Allocate a new Proxmox-managed volume.
# Args: $1=storage, $2=vmid, $3=volname, $4=size
# Prints volume ID on success, returns 1 on failure.
vol_alloc() {
  _vol_storage="$1"; _vol_vmid="$2"; _vol_name="$3"; _vol_size="$4"
  _vol_errfile=$(mktemp)
  _vol_vid=""

  _vol_raw=$(pvesm alloc "$_vol_storage" "$_vol_vmid" "$_vol_name" "$_vol_size" 2>"$_vol_errfile" || true)
  if [ -n "$_vol_raw" ]; then
    _vol_vid=$(vol_extract_volid "$_vol_raw")
    if [ -n "$_vol_vid" ]; then
      rm -f "$_vol_errfile"
      echo "$_vol_vid"
      return 0
    fi
  fi

  _vol_type=$(vol_get_storage_type "$_vol_storage")
  if [ "$_vol_type" = "zfspool" ]; then
    _vol_raw=$(pvesm alloc "$_vol_storage" "$_vol_vmid" "$_vol_name" "$_vol_size" --format subvol 2>"$_vol_errfile" || true)
    if [ -n "$_vol_raw" ]; then
      _vol_vid=$(vol_extract_volid "$_vol_raw")
      if [ -n "$_vol_vid" ]; then
        rm -f "$_vol_errfile"
        echo "$_vol_vid"
        return 0
      fi
    fi
  fi

  _vol_err=$(cat "$_vol_errfile" 2>/dev/null || true)
  rm -f "$_vol_errfile"
  echo "vol_alloc failed (type=$_vol_type): $_vol_err" >&2
  return 1
}

# Resolve host-side filesystem path for a volume.
# Retries up to 10 times (pvesm path may need time after alloc).
# Falls back to ZFS mountpoint lookup.
# Args: $1=volid, $2=volname, $3=storage_type, $4=storage_name
vol_resolve_path() {
  _vol_volid="$1"; _vol_volname="$2"; _vol_type="$3"; _vol_stor="$4"

  _vol_path=""
  _vol_i=0
  while [ "$_vol_i" -lt 10 ]; do
    _vol_path="$(pvesm path "$_vol_volid" 2>/dev/null || true)"
    if [ -n "$_vol_path" ]; then
      echo "$_vol_path"
      return 0
    fi
    sleep 1
    _vol_i=$(( _vol_i + 1 ))
  done

  # Fallback for ZFS
  if [ "$_vol_type" = "zfspool" ]; then
    _vol_pool=$(vol_get_zfs_pool "$_vol_stor")
    if [ -n "$_vol_pool" ]; then
      _vol_mp=$(zfs get -H -o value mountpoint "${_vol_pool}/${_vol_volname}" 2>/dev/null || true)
      if [ -z "$_vol_mp" ] || [ "$_vol_mp" = "-" ] || [ "$_vol_mp" = "none" ]; then
        _vol_mp=$(zfs list -H -o mountpoint "${_vol_pool}/${_vol_volname}" 2>/dev/null || true)
      fi
      if [ -n "$_vol_mp" ] && [ "$_vol_mp" != "-" ] && [ "$_vol_mp" != "none" ]; then
        echo "$_vol_mp"
        return 0
      fi
    fi
  fi

  return 1
}

# Find an existing volume by name suffix.
# Preference order: previouse_vm_id's volume -> any existing volume with suffix.
# Args: $1=storage, $2=suffix, $3=storage_type, $4=prev_vmid(optional)
vol_get_existing() {
  _vol_stor="$1"; _vol_suffix="$2"; _vol_type="$3"; _vol_prev="$4"

  if [ "$_vol_type" = "zfspool" ]; then
    _vol_all=$(pvesm list "$_vol_stor" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -Ei -- "subvol-[0-9]+-${_vol_suffix}$" || true)
    _vol_found=""
    if [ -n "$_vol_prev" ] && [ "$_vol_prev" != "NOT_DEFINED" ]; then
      _vol_found=$(printf '%s\n' "$_vol_all" | grep -E -- "subvol-${_vol_prev}-${_vol_suffix}$" | head -n1 || true)
    fi
    if [ -z "$_vol_found" ]; then
      _vol_found=$(printf '%s\n' "$_vol_all" | head -n1 || true)
    fi
    if [ -n "$_vol_found" ]; then
      echo "$_vol_found"
      return 0
    fi
    _vol_pool=$(vol_get_zfs_pool "$_vol_stor")
    if [ -n "$_vol_pool" ] && zfs list -H -o name "${_vol_pool}/${_vol_suffix}" >/dev/null 2>&1; then
      echo "${_vol_stor}:${_vol_suffix}"
      return 0
    fi
  elif [ "$_vol_type" = "lvmthin" ] || [ "$_vol_type" = "lvm" ]; then
    _vol_all=$(pvesm list "$_vol_stor" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -Ei -- "vm-[0-9]+-${_vol_suffix}$" || true)
    if [ -n "$_vol_prev" ] && [ "$_vol_prev" != "NOT_DEFINED" ]; then
      _vol_pref=$(printf '%s\n' "$_vol_all" | grep -E -- "vm-${_vol_prev}-${_vol_suffix}$" | head -n1 || true)
      [ -n "$_vol_pref" ] && { echo "$_vol_pref"; return 0; }
    fi
    printf '%s\n' "$_vol_all" | head -n1 || true
  else
    pvesm list "$_vol_stor" --content rootdir 2>/dev/null \
      | awk '{print $1}' \
      | grep -i -- "${_vol_suffix}" \
      | head -n1 || true
  fi
}

# Find a free (unformatted/unmounted) partition for storage.
# Returns the partition device path if found, empty otherwise.
vol_find_free_partition() {
  for _vol_dev in /dev/sd[a-z][0-9]* /dev/nvme[0-9]n[0-9]p[0-9]* /dev/vd[a-z][0-9]*; do
    [ -b "$_vol_dev" ] || continue
    # Skip if mounted
    if mount | grep -q "^$_vol_dev "; then continue; fi
    # Skip if part of LVM
    if pvs "$_vol_dev" >/dev/null 2>&1; then continue; fi
    # Skip if swap
    if grep -q "^$_vol_dev " /proc/swaps 2>/dev/null; then continue; fi
    # Skip partitions smaller than 100MB
    _vol_size_bytes=$(blockdev --getsize64 "$_vol_dev" 2>/dev/null || echo 0)
    if [ "$_vol_size_bytes" -lt 104857600 ]; then continue; fi
    # Check if it has a filesystem
    _vol_fstype=$(blkid -o value -s TYPE "$_vol_dev" 2>/dev/null || true)
    if [ -z "$_vol_fstype" ]; then
      echo "$_vol_dev"
      return 0
    fi
  done
  return 1
}

# Setup filesystem-based storage volumes (fallback for non-ZFS/LVM).
# Uses either a free partition or creates directories on root.
# Args: $1=volname
# Prints mount point path.
vol_setup_filesystem_storage() {
  _vol_volname="$1"
  _vol_mount_base="/mnt/pve-volumes"
  _vol_mount_point="${_vol_mount_base}/${_vol_volname}"

  # Check if already set up
  if [ -d "$_vol_mount_point" ]; then
    if mountpoint -q "$_vol_mount_point" 2>/dev/null || [ -d "$_vol_mount_point/config" ]; then
      echo "$_vol_mount_point"
      return 0
    fi
  fi

  # Try to find a free partition
  _vol_free_part=$(vol_find_free_partition || true)

  if [ -n "$_vol_free_part" ]; then
    echo "Found free partition: $_vol_free_part - formatting with ext4..." >&2
    mkfs.ext4 -q -L "pve-volumes" "$_vol_free_part" >&2
    mkdir -p "$_vol_mount_point"
    mount "$_vol_free_part" "$_vol_mount_point"
    if ! grep -q "$_vol_free_part" /etc/fstab 2>/dev/null; then
      echo "$_vol_free_part $_vol_mount_point ext4 defaults 0 2" >> /etc/fstab
      echo "Added $_vol_free_part to /etc/fstab" >&2
    fi
    echo "$_vol_mount_point"
    return 0
  fi

  # No free partition - use root filesystem
  echo "No free partition found - using root filesystem for volumes" >&2
  mkdir -p "$_vol_mount_point"
  echo "$_vol_mount_point"
  return 0
}

# Rename a volume across storage types.
# Used to make volume names VM-ID-independent after allocation.
# Args: $1=storage, $2=old_volid (storage:name), $3=new_name, $4=storage_type
# Prints new volid on success, returns 1 on failure.
vol_rename() {
  _vol_stor="$1"; _vol_old_volid="$2"; _vol_new_name="$3"; _vol_type="$4"
  _vol_old_name="${_vol_old_volid#*:}"

  case "$_vol_type" in
    zfspool)
      _vol_pool=$(vol_get_zfs_pool "$_vol_stor")
      [ -z "$_vol_pool" ] && return 1
      zfs rename "${_vol_pool}/${_vol_old_name}" "${_vol_pool}/${_vol_new_name}" 2>/dev/null || return 1
      echo "${_vol_stor}:${_vol_new_name}"
      ;;
    lvmthin|lvm)
      _vol_vgname=$(vol_get_lvm_vgname "$_vol_stor")
      [ -z "$_vol_vgname" ] && return 1
      lvrename "${_vol_vgname}" "${_vol_old_name}" "${_vol_new_name}" 2>/dev/null || return 1
      echo "${_vol_stor}:${_vol_new_name}"
      ;;
    dir)
      _vol_base=$(vol_get_dir_path "$_vol_stor")
      [ -z "$_vol_base" ] && return 1
      # Directory volumes are stored under images/<vmid>/
      _vol_old_vmid=$(echo "$_vol_old_name" | sed -E 's/^(subvol|vm)-([0-9]+)-.*/\2/')
      if [ -f "${_vol_base}/images/${_vol_old_vmid}/${_vol_old_name}" ]; then
        mkdir -p "${_vol_base}/images/shared"
        mv "${_vol_base}/images/${_vol_old_vmid}/${_vol_old_name}" "${_vol_base}/images/shared/${_vol_new_name}" 2>/dev/null || return 1
        echo "${_vol_stor}:shared/${_vol_new_name}"
      elif [ -d "${_vol_base}/images/${_vol_old_vmid}/${_vol_old_name}" ]; then
        mkdir -p "${_vol_base}/images/shared"
        mv "${_vol_base}/images/${_vol_old_vmid}/${_vol_old_name}" "${_vol_base}/images/shared/${_vol_new_name}" 2>/dev/null || return 1
        echo "${_vol_stor}:shared/${_vol_new_name}"
      else
        return 1
      fi
      ;;
    *) return 1 ;;
  esac
}

# Unlink managed volumes from a container's config and rename them to clean names.
# This preserves volumes during pct destroy by:
# 1. Removing the mp entry from .conf (so pct destroy won't delete the volume)
# 2. Renaming the volume from subvol-{VMID}-{suffix} to just {suffix}
# Args: $1=vmid
# Prints unlinked mp keys to stderr.
vol_unlink_persistent() {
  _vol_vmid="$1"
  _vol_conf=$(pct config "$_vol_vmid" 2>/dev/null || true)
  [ -z "$_vol_conf" ] && return 0

  echo "$_vol_conf" | grep -aE "^mp[0-9]+:" | while IFS= read -r _vol_mline; do
    _vol_mpkey=$(echo "$_vol_mline" | cut -d: -f1)
    _vol_mpsrc=$(echo "$_vol_mline" | sed -E 's/^mp[0-9]+: ([^,]+),.*/\1/')
    # Skip bind mounts (absolute paths) and rootfs
    case "$_vol_mpsrc" in
      /*) continue ;;
    esac
    # Extract storage and volume name
    _vol_stor="${_vol_mpsrc%%:*}"
    _vol_name="${_vol_mpsrc#*:}"
    # Unlink from .conf first
    pct set "$_vol_vmid" -delete "$_vol_mpkey" 2>/dev/null || true
    echo "Unlinked volume $_vol_mpkey ($_vol_mpsrc) from container $_vol_vmid" >&2
    # Rename to clean name (strip subvol-{VMID}- or vm-{VMID}- prefix)
    _vol_clean=""
    case "$_vol_name" in
      subvol-${_vol_vmid}-*) _vol_clean="${_vol_name#subvol-${_vol_vmid}-}" ;;
      vm-${_vol_vmid}-*)     _vol_clean="${_vol_name#vm-${_vol_vmid}-}" ;;
    esac
    if [ -n "$_vol_clean" ] && [ "$_vol_clean" != "$_vol_name" ]; then
      _vol_type=$(vol_get_storage_type "$_vol_stor")
      if vol_rename "$_vol_stor" "$_vol_mpsrc" "$_vol_clean" "$_vol_type" >/dev/null 2>&1; then
        echo "Renamed volume to clean name: $_vol_clean" >&2
      fi
    fi
  done
}
