#!/bin/sh
# Global VE host library - auto-injected into all execute_on:ve shell scripts
# Provides volume path resolution for managed volumes

# find_vmid_by_hostname <hostname>
# Print the first VMID that matches <hostname> in pct list. Empty + return 1
# if no match. Useful for cross-container scripts (e.g. an OIDC client that
# needs to write into the Zitadel container's volume) that have a hostname
# but no vmid in their template variables.
find_vmid_by_hostname() {
  _fvbh_host="$1"
  [ -z "$_fvbh_host" ] && return 1
  command -v pct >/dev/null 2>&1 || return 1
  # pct list columns: VMID Status Lock Name. Match Name (= hostname).
  _fvbh_running=$(pct list 2>/dev/null \
    | awk -v h="$_fvbh_host" 'NR>1 && $NF==h && $2=="running" {print $1; exit}')
  if [ -n "$_fvbh_running" ]; then
    printf '%s' "$_fvbh_running"
    return 0
  fi
  _fvbh_any=$(pct list 2>/dev/null \
    | awk -v h="$_fvbh_host" 'NR>1 && $NF==h {print $1; exit}')
  if [ -n "$_fvbh_any" ]; then
    printf '%s' "$_fvbh_any"
    return 0
  fi
  return 1
}

resolve_host_volume() {
  # Usage: resolve_host_volume <hostname> <volume_key> <vm_id>
  # Returns: Host-side path to the volume directory
  #
  # Resolution order:
  # 1. Dedicated managed volume: subvol-<vmid>-<hostname>-<key>     (OCI-image apps)
  # 2. App managed volume subdirectory: subvol-<vmid>-<hostname>-app/<key>  (docker-compose apps)
  #
  # vm_id is REQUIRED. The lookup is restricted to volumes attached to that
  # container's pct config. This prevents picking up orphaned volumes from
  # previously destroyed or stopped containers that share the same hostname
  # — adopting such a volume is silent data corruption.
  _rhv_host="$1"
  _rhv_key="$2"
  _rhv_vmid="$3"

  if [ -z "$_rhv_host" ] || [ -z "$_rhv_key" ] || [ -z "$_rhv_vmid" ]; then
    echo "ERROR: resolve_host_volume requires <hostname> <volume_key> <vm_id> (got host='$_rhv_host' key='$_rhv_key' vmid='$_rhv_vmid')" >&2
    return 1
  fi

  # Keep in sync with VOL_MOUNT_ROOT in vol-common.sh.
  _rhv_mount_root="/var/lib/pve-vol-mounts"

  command -v pct >/dev/null 2>&1 || {
    echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key} (pct not found)" >&2
    return 1
  }

  # Read volume IDs attached to this VMID. pct config lines look like:
  #   rootfs: local-zfs:subvol-507-disk-0,size=1G
  #   mp0: local-zfs:subvol-507-proxvex-config,mp=/config,...
  _rhv_attached=$(pct config "$_rhv_vmid" 2>/dev/null \
    | awk '/^(rootfs|mp[0-9]+):/ {
        line=$0; sub(/^[^:]+:[[:space:]]+/, "", line);
        n=split(line, a, ",");
        print a[1];
      }')
  if [ -z "$_rhv_attached" ]; then
    echo "ERROR: resolve_host_volume: vmid $_rhv_vmid has no attached volumes (does the container exist?)" >&2
    return 1
  fi

  # Fallback for block-based storages (LVM/LVM-thin etc.) where pvesm path
  # gives a block device and the LV is locked by the running container's
  # mount: walk the rootfs via /proc/<pid>/root.
  _rhv_resolve_via_running_ct() {
    _rhv_volid_in="$1"
    _rhv_vname_in="${_rhv_volid_in#*:}"
    _rhv_ct_conf=$(pct config "$_rhv_vmid" 2>/dev/null) || return 1
    _rhv_mp_in=$(printf '%s\n' "$_rhv_ct_conf" \
      | awk -v v="$_rhv_vname_in" '
          /^(rootfs|mp[0-9]+):/ {
            line=$0; sub(/^[^:]+:[[:space:]]+/, "", line);
            n=split(line, a, ",");
            if (a[1] !~ ":"v"$") next
            for (i=2;i<=n;i++) if (a[i] ~ /^mp=/) { sub(/^mp=/, "", a[i]); print a[i]; exit }
          }')
    [ -z "$_rhv_mp_in" ] && _rhv_mp_in="/"
    _rhv_pid=$(lxc-info -n "$_rhv_vmid" -p -H 2>/dev/null) || \
      _rhv_pid=$(cat "/var/lib/lxc/$_rhv_vmid/init.pid" 2>/dev/null) || true
    [ -z "$_rhv_pid" ] && return 1
    _rhv_proc_path="/proc/${_rhv_pid}/root${_rhv_mp_in}"
    [ -d "$_rhv_proc_path" ] || return 1
    printf '%s' "$_rhv_proc_path"
    return 0
  }

  _rhv_resolve_path() {
    # Resolve a volid to a host-side directory. Prefer mounted path, then
    # pvesm path, then /proc/<pid>/root for block-locked volumes.
    _rhv_resolve_volid="$1"
    _rhv_resolve_vname="${_rhv_resolve_volid#*:}"

    _rhv_mnt="${_rhv_mount_root}/${_rhv_resolve_vname}"
    if mountpoint -q "$_rhv_mnt" 2>/dev/null; then
      printf '%s' "$_rhv_mnt"
      return 0
    fi
    _rhv_path=$(pvesm path "$_rhv_resolve_volid" 2>/dev/null || true)
    if [ -n "$_rhv_path" ] && [ -d "$_rhv_path" ]; then
      printf '%s' "$_rhv_path"
      return 0
    fi
    if _rhv_resolve_via_running_ct "$_rhv_resolve_volid"; then
      return 0
    fi
    return 1
  }

  # 1. Try dedicated managed volume: <host>-<key>
  _rhv_volname_pat="${_rhv_host}-${_rhv_key}"
  _rhv_volid=$(printf '%s\n' "$_rhv_attached" \
    | grep -E "${_rhv_volname_pat}\$" | head -1 || true)
  if [ -n "$_rhv_volid" ]; then
    if _rhv_resolve_path "$_rhv_volid"; then
      return 0
    fi
  fi

  # 2. Try app managed volume with subdirectory: <host>-app/<key>
  _rhv_appname_pat="${_rhv_host}-app"
  _rhv_volid=$(printf '%s\n' "$_rhv_attached" \
    | grep -E "${_rhv_appname_pat}\$" | head -1 || true)
  if [ -n "$_rhv_volid" ]; then
    _rhv_app_path=$(_rhv_resolve_path "$_rhv_volid" || true)
    if [ -n "$_rhv_app_path" ] && [ -d "$_rhv_app_path" ]; then
      for _rhv_try in "$_rhv_key" $(echo "$_rhv_key" | tr '-' '_') $(echo "$_rhv_key" | tr '_' '-'); do
        if [ -d "${_rhv_app_path}/${_rhv_try}" ]; then
          printf '%s' "${_rhv_app_path}/${_rhv_try}"
          return 0
        fi
      done
    fi
  fi

  echo "ERROR: resolve_host_volume failed for ${_rhv_host}/${_rhv_key} (vmid $_rhv_vmid)" >&2
  return 1
}
