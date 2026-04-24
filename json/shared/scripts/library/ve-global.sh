#!/bin/sh
# Global VE host library - auto-injected into all execute_on:ve shell scripts
# Provides volume path resolution for managed volumes

resolve_host_volume() {
  # Usage: resolve_host_volume <hostname> <volume_key>
  # Returns: Host-side path to the volume directory
  #
  # Resolution order:
  # 1. Dedicated managed volume: subvol-*-<hostname>-<key> (OCI-image apps)
  # 2. App managed volume subdirectory: subvol-*-<hostname>-app/<key> (docker-compose apps)
  #
  # For each candidate a vol_mount'ed path under VOL_MOUNT_ROOT is preferred
  # over pvesm path — on LVM/LVM-thin pvesm path returns a block device, but
  # the pre_start phase has already mounted the filesystem there.
  _rhv_host="$1"
  _rhv_key="$2"

  # Keep in sync with VOL_MOUNT_ROOT in vol-common.sh.
  _rhv_mount_root="/var/lib/pve-vol-mounts"

  # Storages to search: VOLUME_STORAGE if set (explicit override), otherwise
  # every rootdir-content storage known to pvesm. Single-storage iteration was
  # fine when deployments were homogeneous (all ZFS), but with mixed setups
  # (e.g. LVM-thin on github-action CI) the caller rarely knows which storage
  # holds a given volume — scanning all rootdir storages is the right default.
  if [ -n "${VOLUME_STORAGE-}" ]; then
    _rhv_storages="$VOLUME_STORAGE"
  else
    _rhv_storages=$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | tr '\n' ' ')
    [ -z "$_rhv_storages" ] && _rhv_storages="local-zfs"
  fi

  command -v pvesm >/dev/null 2>&1 || {
    echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key} (pvesm not found)" >&2
    return 1
  }

  for _rhv_storage in $_rhv_storages; do
    # 1. Try dedicated managed volume (one volume per key)
    _rhv_volname="${_rhv_host}-${_rhv_key}"
    _rhv_volid=$(pvesm list "$_rhv_storage" --content rootdir 2>/dev/null \
      | awk -v pat="${_rhv_volname}$" '$1 ~ pat {print $1; exit}' || true)
    if [ -n "$_rhv_volid" ]; then
      _rhv_vname="${_rhv_volid#*:}"
      _rhv_mnt="${_rhv_mount_root}/${_rhv_vname}"
      if mountpoint -q "$_rhv_mnt" 2>/dev/null; then
        printf '%s' "$_rhv_mnt"
        return 0
      fi
      _rhv_path=$(pvesm path "$_rhv_volid" 2>/dev/null || true)
      if [ -n "$_rhv_path" ] && [ -d "$_rhv_path" ]; then
        printf '%s' "$_rhv_path"
        return 0
      fi
    fi

    # 2. Try app managed volume with subdirectory
    _rhv_appname="${_rhv_host}-app"
    _rhv_volid=$(pvesm list "$_rhv_storage" --content rootdir 2>/dev/null \
      | awk -v pat="${_rhv_appname}$" '$1 ~ pat {print $1; exit}' || true)
    if [ -n "$_rhv_volid" ]; then
      _rhv_vname="${_rhv_volid#*:}"
      _rhv_mnt="${_rhv_mount_root}/${_rhv_vname}"
      if mountpoint -q "$_rhv_mnt" 2>/dev/null; then
        _rhv_path="$_rhv_mnt"
      else
        _rhv_path=$(pvesm path "$_rhv_volid" 2>/dev/null || true)
      fi
      if [ -n "$_rhv_path" ] && [ -d "$_rhv_path" ]; then
        for _rhv_try in "$_rhv_key" $(echo "$_rhv_key" | tr '-' '_') $(echo "$_rhv_key" | tr '_' '-'); do
          if [ -d "${_rhv_path}/${_rhv_try}" ]; then
            printf '%s' "${_rhv_path}/${_rhv_try}"
            return 0
          fi
        done
      fi
    fi
  done

  echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key}" >&2
  return 1
}
