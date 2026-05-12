#!/bin/sh
# Restore container settings from a previous container during upgrade.
# Reads the old container's LXC config and applies preserved settings to
# the newly created container.
#
# Restored entries:
#   - net0                (static IP, bridge, hwaddr, gw) via pct set
#   - hostname            via pct set
#   - nameserver          via pct set
#   - lxc.environment:    addon-managed ENV vars (OIDC, SSL, ...) appended
#                         directly to the new config file; lxc.environment.runtime:
#                         lines are NOT touched (they come from the image).
#
# Without this step the new container loses everything that addons appended
# to the old config — static IP falls back to DHCP, OIDC env vars are gone,
# etc. — and the upgraded container appears "half-initialized".
#
# Requires:
#   - previous_vm_id: Old container ID whose config to read
#   - vm_id: New container ID to apply settings to

set -eu

OLD_VMID="{{ previous_vm_id }}"
NEW_VMID="{{ vm_id }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$OLD_VMID" ] || [ "$OLD_VMID" = "NOT_DEFINED" ]; then
  log "No previous_vm_id — skipping settings restore"
  exit 0
fi
if [ -z "$NEW_VMID" ] || [ "$NEW_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ "$OLD_VMID" = "$NEW_VMID" ]; then
  log "Same container — skipping settings restore"
  exit 0
fi

OLD_CONF="/etc/pve/lxc/${OLD_VMID}.conf"
NEW_CONF="/etc/pve/lxc/${NEW_VMID}.conf"
if [ ! -f "$OLD_CONF" ]; then
  log "Old config $OLD_CONF not found — skipping settings restore"
  exit 0
fi
if [ ! -f "$NEW_CONF" ]; then
  fail "New config $NEW_CONF not found"
fi

# --- Extract network settings from old config ---
OLD_NET0=$(awk -F': ' '/^net0:/ { print $2; exit }' "$OLD_CONF")
OLD_HOSTNAME=$(awk -F': ' '/^hostname:/ { print $2; exit }' "$OLD_CONF")
OLD_NAMESERVER=$(awk -F': ' '/^nameserver:/ { print $2; exit }' "$OLD_CONF")

CHANGED=0

# --- Restore net0 (only if static IP, not just dhcp) ---
if [ -n "$OLD_NET0" ]; then
  case "$OLD_NET0" in
    *ip=dhcp*)
      log "Old container used DHCP — not restoring net0"
      ;;
    *ip=*)
      log "Restoring net0 from old container $OLD_VMID: $OLD_NET0"
      pct set "$NEW_VMID" --net0 "$OLD_NET0" >&2
      CHANGED=1
      ;;
    *)
      log "Old net0 has no ip= setting — not restoring"
      ;;
  esac
fi

# --- Restore hostname if different from default ---
if [ -n "$OLD_HOSTNAME" ]; then
  NEW_HOSTNAME=$(awk -F': ' '/^hostname:/ { print $2; exit }' "$NEW_CONF")
  if [ "$OLD_HOSTNAME" != "$NEW_HOSTNAME" ]; then
    log "Restoring hostname from old container: $OLD_HOSTNAME"
    pct set "$NEW_VMID" --hostname "$OLD_HOSTNAME" >&2
    CHANGED=1
  fi
fi

# --- Restore nameserver ---
if [ -n "$OLD_NAMESERVER" ]; then
  log "Restoring nameserver from old container: $OLD_NAMESERVER"
  pct set "$NEW_VMID" --nameserver "$OLD_NAMESERVER" >&2
  CHANGED=1
fi

# --- Restore lxc.environment: entries (addon-managed ENV vars) ---
# pct has no --environment flag — we append directly to the new config file.
# Only the literal "lxc.environment: " prefix is matched; "lxc.environment.runtime:"
# entries are set by the image and must not be copied from the old container.
OLD_ENV_TMP=$(mktemp)
trap 'rm -f "$OLD_ENV_TMP"' EXIT
grep '^lxc\.environment: ' "$OLD_CONF" > "$OLD_ENV_TMP" || true
if [ -s "$OLD_ENV_TMP" ]; then
  COUNT=$(wc -l < "$OLD_ENV_TMP" | tr -d ' ')
  # Drop any lxc.environment: lines the fresh container may already have,
  # then append the old ones (preserves order from the old config).
  sed -i '/^lxc\.environment: /d' "$NEW_CONF"
  cat "$OLD_ENV_TMP" >> "$NEW_CONF"
  log "Restored $COUNT lxc.environment: entries from old container"
  CHANGED=1
fi

# --- Restore addon-managed volume mount points (mp[0-9]+) ------------------
# During upgrade, oci-image's create_ct creates a fresh container with only
# the base volumes (config + secure for proxvex). Addon-managed volumes
# (e.g. certs + proxvex from addon-ssl) live on the old container's mp2/mp3
# and never get migrated — the upgrade flow does not re-run addon templates,
# and ADDON_VOLUMES is empty when 150-conf-create-storage-volumes-for-lxc.sh
# runs during the upgrade's create_ct phase. Result: the new container is
# missing /etc/ssl/addon, dockerd-style services find no certs at start, and
# HTTPS does not come up.
#
# Fix: iterate the old config's managed mp* entries, copy each underlying
# volume to a new-vmid-prefixed name (vol_copy preserves data via zfs
# send|recv / dd / cp), and add an mp* entry to the new container at the
# same mountpoint. Bind mounts (mp[N]: /...) and entries whose key already
# exists on the new container are left alone.
if grep -qaE '^mp[0-9]+: ' "$OLD_CONF"; then
  log "Scanning $OLD_CONF for addon-managed volumes to restore..."
  # vol-common.sh is prepended into this script via the template `library`
  # property — vol_copy, vol_get_storage_type are available here.
  #
  # We stage the mp-lines into a temp file rather than piping `grep |
  # while read` because the loop body sets CHANGED=1, and the pipe form
  # would run the body in a subshell where that variable change is lost.
  # `< <(...)` process substitution would also work but is bash-only; this
  # script runs as POSIX /bin/sh via SSH on the PVE host.
  MP_LIST_TMP=$(mktemp)
  grep -aE '^mp[0-9]+: ' "$OLD_CONF" > "$MP_LIST_TMP" || true
  while IFS= read -r mp_line; do
    mp_key=$(echo "$mp_line" | cut -d: -f1)
    mp_value=$(echo "$mp_line" | sed -E "s/^${mp_key}: //")
    mp_volid=$(echo "$mp_value" | sed -E 's/^([^,]+),.*/\1/')
    case "$mp_volid" in
      /*)
        # Bind mount — never restore. The new container's create_ct flow
        # already wires bind mounts from template parameters.
        continue
        ;;
    esac
    # Skip if the new container already has this mp* key.
    if grep -qaE "^${mp_key}: " "$NEW_CONF"; then
      continue
    fi
    # Skip if the new container already mounts the same mountpoint via a
    # different mp key — e.g. mp0:/config from create_ct vs old mp0:/config.
    mp_mountpoint=$(echo "$mp_value" | grep -oE 'mp=[^,]*' | sed 's/^mp=//' | head -1)
    if [ -n "$mp_mountpoint" ] && grep -qaE "^mp[0-9]+:.*[ ,]mp=${mp_mountpoint}([, ]|$)" "$NEW_CONF"; then
      log "  skip $mp_key ($mp_volid): mountpoint $mp_mountpoint already mounted on new container"
      continue
    fi
    mp_stor="${mp_volid%%:*}"
    mp_name="${mp_volid#*:}"
    # Compute new volume name by replacing old VMID prefix with new VMID.
    case "$mp_name" in
      subvol-${OLD_VMID}-*) mp_new_name="subvol-${NEW_VMID}-${mp_name#subvol-${OLD_VMID}-}" ;;
      vm-${OLD_VMID}-*)     mp_new_name="vm-${NEW_VMID}-${mp_name#vm-${OLD_VMID}-}" ;;
      *)
        log "  skip $mp_key ($mp_volid): unrecognised volume name pattern"
        continue
        ;;
    esac
    mp_type=$(vol_get_storage_type "$mp_stor" 2>/dev/null || echo "")
    if [ -z "$mp_type" ]; then
      log "  skip $mp_key ($mp_volid): storage type unknown"
      continue
    fi
    log "  Restoring $mp_key: copying $mp_volid -> $mp_new_name (type=$mp_type)"
    mp_new_volid=$(vol_copy "$mp_stor" "$mp_volid" "$mp_new_name" "$mp_type" 2>&1) || mp_new_volid=""
    if [ -z "$mp_new_volid" ]; then
      log "  WARN: vol_copy failed for $mp_volid; new container will be missing $mp_key (mountpoint $mp_mountpoint)"
      continue
    fi
    # mp_new_volid might include surrounding log lines if vol_copy printed
    # diagnostics. Extract the last token that looks like storage:volname.
    mp_new_volid=$(echo "$mp_new_volid" | grep -oE '[a-zA-Z0-9_-]+:[a-zA-Z0-9._/-]+' | tail -1)
    if [ -z "$mp_new_volid" ]; then
      log "  WARN: could not parse new volid from vol_copy output for $mp_volid"
      continue
    fi
    # Rebuild the mp value with the new volid, preserving all other options
    # (mp=, size=, backup=, etc.) verbatim.
    mp_rest=$(echo "$mp_value" | sed -E "s|^${mp_volid}||")
    pct set "$NEW_VMID" "-${mp_key}" "${mp_new_volid}${mp_rest}" >&2 || {
      log "  WARN: pct set -${mp_key} on $NEW_VMID failed"
      continue
    }
    log "  Attached $mp_key -> $mp_new_volid"
    CHANGED=1
  done < "$MP_LIST_TMP"
  rm -f "$MP_LIST_TMP"
fi

if [ "$CHANGED" -eq 1 ]; then
  log "Settings restored from container $OLD_VMID to $NEW_VMID"
else
  log "No settings to restore from container $OLD_VMID"
fi
