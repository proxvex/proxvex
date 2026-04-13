#!/bin/sh
# Global VE host library - auto-injected into all execute_on:ve shell scripts
# Provides volume path resolution for Proxmox-managed volumes

resolve_host_volume() {
  # Usage: resolve_host_volume <hostname> <volume_key>
  # Returns: Host-side path to the volume directory
  # Finds Proxmox-managed volumes via pvesm path
  _rhv_host="$1"
  _rhv_key="$2"
  _rhv_volname="${_rhv_host}-${_rhv_key}"

  if command -v pvesm >/dev/null 2>&1; then
    _rhv_volid=$(pvesm list "${VOLUME_STORAGE:-local-zfs}" --content rootdir 2>/dev/null \
      | awk -v pat="${_rhv_volname}$" '$1 ~ pat {print $1; exit}' || true)
    if [ -n "$_rhv_volid" ]; then
      _rhv_path=$(pvesm path "$_rhv_volid" 2>/dev/null || true)
      if [ -n "$_rhv_path" ] && [ -d "$_rhv_path" ]; then
        printf '%s' "$_rhv_path"
        return 0
      fi
    fi
  fi

  echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key}" >&2
  return 1
}
