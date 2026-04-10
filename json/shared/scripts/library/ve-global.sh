#!/bin/sh
# Global VE host library - auto-injected into all execute_on:ve shell scripts
# Provides volume path resolution for both bind-mount and managed-volume layouts

resolve_host_volume() {
  # Usage: resolve_host_volume <shared_volpath> <hostname> <volume_key>
  # Returns: Host-side path to the volume directory
  # Supports: bind-mounts (legacy) and Proxmox-managed volumes (future)
  _rhv_base="$1"
  _rhv_host="$2"
  _rhv_key="$3"
  _rhv_path="${_rhv_base}/volumes/${_rhv_host}/${_rhv_key}"
  # Future: check if managed volume exists and resolve via pvesm
  printf '%s' "$_rhv_path"
}
