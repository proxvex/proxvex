#!/bin/sh
# Global VE host library - auto-injected into all execute_on:ve shell scripts
# Provides volume path resolution for managed and bind-mount volumes

resolve_host_volume() {
  # Usage: resolve_host_volume <hostname> <volume_key>
  # Returns: Host-side path to the volume directory
  #
  # Resolution order:
  # 1. Proxmox-managed volume via pvesm path (OCI-image apps)
  # 2. Bind-mount directory at /mnt/volumes/<hostname>/<key> (docker-compose apps)
  _rhv_host="$1"
  _rhv_key="$2"
  _rhv_volname="${_rhv_host}-${_rhv_key}"

  # 1. Try Proxmox-managed volume
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

  # 2. Fallback: bind-mount directory (docker-compose apps)
  # Try common base paths and both underscore/hyphen key variants
  _rhv_key_underscore=$(echo "$_rhv_key" | tr '-' '_')
  _rhv_key_hyphen=$(echo "$_rhv_key" | tr '_' '-')
  for _rhv_base in /rpool/volumes /mnt/volumes /mnt/pve-volumes; do
    for _rhv_try in "$_rhv_key" "$_rhv_key_underscore" "$_rhv_key_hyphen"; do
      _rhv_bind="${_rhv_base}/${_rhv_host}/${_rhv_try}"
      if [ -d "$_rhv_bind" ]; then
        printf '%s' "$_rhv_bind"
        return 0
      fi
    done
  done

  echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key}" >&2
  return 1
}
