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
  _rhv_host="$1"
  _rhv_key="$2"

  _rhv_storage="${VOLUME_STORAGE:-local-zfs}"

  if command -v pvesm >/dev/null 2>&1; then
    # 1. Try dedicated managed volume (one volume per key)
    _rhv_volname="${_rhv_host}-${_rhv_key}"
    _rhv_volid=$(pvesm list "$_rhv_storage" --content rootdir 2>/dev/null \
      | awk -v pat="${_rhv_volname}$" '$1 ~ pat {print $1; exit}' || true)
    if [ -n "$_rhv_volid" ]; then
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
      _rhv_path=$(pvesm path "$_rhv_volid" 2>/dev/null || true)
      if [ -n "$_rhv_path" ] && [ -d "$_rhv_path" ]; then
        for _rhv_try in "$_rhv_key" $(echo "$_rhv_key" | tr '-' '_') $(echo "$_rhv_key" | tr '_' '-'); do
          if [ -d "${_rhv_path}/${_rhv_try}" ]; then
            printf '%s' "${_rhv_path}/${_rhv_try}"
            return 0
          fi
        done
      fi
    fi
  fi

  echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key}" >&2
  return 1
}
