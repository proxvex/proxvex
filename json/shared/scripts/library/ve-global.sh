#!/bin/sh
# Global VE host library - auto-injected into all execute_on:ve shell scripts
# Provides volume path resolution for Proxmox-managed volumes

resolve_host_volume() {
  # Usage: resolve_host_volume <shared_volpath> <hostname> <volume_key>
  # Returns: Host-side path to the volume directory
  #
  # Resolution order:
  # 1. Proxmox-managed volume: pvesm path for "<storage>:subvol-*-<hostname>-<key>"
  # 2. Legacy fallback: <shared_volpath>/volumes/<hostname>/<key>
  _rhv_base="$1"
  _rhv_host="$2"
  _rhv_key="$3"
  _rhv_volname="${_rhv_host}-${_rhv_key}"

  # Try to find managed volume via pvesm
  # Volume names follow: subvol-<VMID>-<hostname>-<key>
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

  # Legacy fallback: bind-mount layout
  if [ -n "$_rhv_base" ] && [ "$_rhv_base" != "NOT_DEFINED" ]; then
    printf '%s' "${_rhv_base}/volumes/${_rhv_host}/${_rhv_key}"
    return 0
  fi

  echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key}" >&2
  return 1
}
