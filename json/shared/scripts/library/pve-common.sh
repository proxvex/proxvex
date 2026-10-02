#!/bin/sh
# PVE/LXC Common Library
#
# General helper functions for Proxmox VE and LXC container management.
# It contains only function definitions - no direct execution.
#
# Main functions:
#   1. pve_is_number - Check if a string is a non-negative integer
#   2. pve_sanitize_name - Sanitize a string for use in filenames/volume names
#   3. pve_map_id_via_idmap - Map container UID/GID to host UID/GID via lxc.idmap
#   4. pve_is_unprivileged - Detect unprivileged container from pct config
#   5. pve_effective_uid - Compute effective host UID for a container UID
#   6. pve_effective_gid - Compute effective host GID for a container GID
#   7. pve_find_next_mp - Find next free mpX mount point slot
#   8. pve_merge_addon_volumes - Merge addon volumes with base volumes
#   9. pve_write_on_start_dispatcher - Write the on_start_container dispatcher

# Check if a string is a non-negative integer
pve_is_number() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Sanitize a string for use in volume/filesystem names.
# Lowercases, replaces non-alphanumeric with hyphens, trims leading/trailing hyphens.
pve_sanitize_name() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# Map a container UID/GID to host UID/GID using lxc.idmap ranges.
# Args: $1=pct_config_output, $2=kind(u|g), $3=container_id
# Prints mapped host id or empty string.
pve_map_id_via_idmap() {
  echo "$1" | awk -v kind="$2" -v cid="$3" '
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

# Detect unprivileged container from pct config output.
# Args: $1=pct_config_output
# Returns 0 if unprivileged, 1 otherwise.
pve_is_unprivileged() {
  echo "$1" | grep -aqE '^unprivileged:\s*1\s*$'
}

# Check if pct config has custom idmap entries.
# Args: $1=pct_config_output
# Returns 0 if idmap found, 1 otherwise.
pve_has_idmap() {
  printf '%s' "$1" | grep -q 'lxc\.idmap' 2>/dev/null
}

# Compute effective host UID for a container UID.
# Handles: explicit override, idmap mapping, unprivileged offset (100000+).
# Args: $1=pct_config, $2=container_uid, $3=mapped_uid_override(optional)
pve_effective_uid() {
  _pve_cfg="$1"; _pve_cuid="$2"; _pve_override="$3"
  if [ -n "$_pve_override" ] && [ "$_pve_override" != "" ] && [ "$_pve_override" != "NOT_DEFINED" ]; then
    echo "$_pve_override"; return
  fi
  if pve_is_number "$_pve_cuid"; then
    _pve_mid=$(pve_map_id_via_idmap "$_pve_cfg" u "$_pve_cuid")
    if [ -n "$_pve_mid" ]; then
      echo "$_pve_mid"; return
    fi
    if pve_is_unprivileged "$_pve_cfg"; then
      if pve_has_idmap "$_pve_cfg"; then
        echo "$_pve_cuid"
      else
        echo $((_pve_cuid + 100000))
      fi
      return
    fi
  fi
  echo "$_pve_cuid"
}

# Compute effective host GID for a container GID.
# Same logic as pve_effective_uid but for group IDs.
# Args: $1=pct_config, $2=container_gid, $3=mapped_gid_override(optional)
pve_effective_gid() {
  _pve_cfg="$1"; _pve_cgid="$2"; _pve_override="$3"
  if [ -n "$_pve_override" ] && [ "$_pve_override" != "" ] && [ "$_pve_override" != "NOT_DEFINED" ]; then
    echo "$_pve_override"; return
  fi
  if pve_is_number "$_pve_cgid"; then
    _pve_mid=$(pve_map_id_via_idmap "$_pve_cfg" g "$_pve_cgid")
    if [ -n "$_pve_mid" ]; then
      echo "$_pve_mid"; return
    fi
    if pve_is_unprivileged "$_pve_cfg"; then
      if pve_has_idmap "$_pve_cfg"; then
        echo "$_pve_cgid"
      else
        echo $((_pve_cgid + 100000))
      fi
      return
    fi
  fi
  echo "$_pve_cgid"
}

# Find next free mpX mount point slot.
# Args: $1=used_mps (space-separated indices), $2=assigned_mps (space-separated indices)
# Prints "mpN" or empty string if all slots full.
pve_find_next_mp() {
  for _pve_i in $(seq 0 31); do
    case " $1 $2 " in
      *" $_pve_i "*) ;;
      *) echo "mp$_pve_i"; return 0 ;;
    esac
  done
  echo ""
}

# Merge addon_volumes with base volumes.
# Application volumes take precedence - addon entries with duplicate keys are skipped.
# Args: $1=volumes, $2=addon_volumes
# Prints merged volumes to stdout.
pve_merge_addon_volumes() {
  _pve_vols="$1"; _pve_advols="$2"
  if [ -z "$_pve_advols" ] || [ "$_pve_advols" = "NOT_DEFINED" ] || [ "$_pve_advols" = "" ]; then
    printf '%s' "$_pve_vols"; return
  fi
  if [ -z "$_pve_vols" ]; then
    printf '%s' "$_pve_advols"; return
  fi
  _pve_base_keys=""
  _pve_IFS="$IFS"; IFS='
'
  for _pve_bline in $_pve_vols; do
    _pve_bkey=$(echo "$_pve_bline" | cut -d'=' -f1)
    [ -n "$_pve_bkey" ] && _pve_base_keys="$_pve_base_keys $_pve_bkey "
  done
  for _pve_aline in $_pve_advols; do
    _pve_akey=$(echo "$_pve_aline" | cut -d'=' -f1)
    case "$_pve_base_keys" in
      *" $_pve_akey "*) ;;
      *) _pve_vols="$_pve_vols
$_pve_aline" ;;
    esac
  done
  IFS="$_pve_IFS"
  printf '%s' "$_pve_vols"
}

# Write the on_start_container dispatcher plus its on_start.d directory.
#
# The dispatcher is generic: Proxmox invokes it on container start and it runs
# every executable drop-in in on_start.d/. Which drop-ins exist is decided by
# the callers — addons (ssl-proxy.sh, acme-renew.sh, smbd.sh) and the
# docker-compose hooks (307-post-start-dockerd.sh) — so the dispatcher itself must
# not depend on any addon parameter.
#
# Args: $1=volume dir (host-side proxvex volume), $2=owner as "uid:gid"
# Overwrites an existing dispatcher; safe to call repeatedly.
pve_write_on_start_dispatcher() {
  _pve_voldir="$1"; _pve_owner="${2:-0:0}"

  mkdir -p "${_pve_voldir}/on_start.d"
  chown "$_pve_owner" "${_pve_voldir}/on_start.d" 2>/dev/null || true

  cat > "${_pve_voldir}/on_start_container" << 'DISPEOF'
#!/bin/sh
# on_start_container - runs all drop-in scripts on container start
# Called by Proxmox hookscript via: pct exec <CTID> -- /etc/proxvex/on_start_container [UID] [GID]

APP_UID="${1:-0}"
APP_GID="${2:-0}"
DROPIN_DIR="/etc/proxvex/on_start.d"

echo "===OCI_HOOK_START===" >&2
HOOK_FAILED=0

for script in "$DROPIN_DIR"/*.sh; do
  [ -x "$script" ] || continue
  echo "Running: $script" >&2
  "$script" "$APP_UID" "$APP_GID"
  RC=$?
  if [ $RC -ne 0 ]; then
    echo "  Script $script failed with exit code $RC" >&2
    HOOK_FAILED=1
  fi
done

if [ "$HOOK_FAILED" -eq 0 ]; then
  echo "===OCI_HOOK_SUCCESS===" >&2
else
  echo "===OCI_HOOK_ERROR===" >&2
fi
DISPEOF
  chmod 755 "${_pve_voldir}/on_start_container"
  chown "$_pve_owner" "${_pve_voldir}/on_start_container" 2>/dev/null || true
}
