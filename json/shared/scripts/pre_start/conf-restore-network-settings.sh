#!/bin/sh
# Restore network settings (net0, hostname, nameserver) from a previous container
# during upgrade. Reads the old container's LXC config and applies preserved
# settings to the newly created container via pct set.
#
# This prevents upgrade from resetting static IP / custom hostname back to DHCP.
#
# Requires:
#   - previouse_vm_id: Old container ID whose config to read
#   - vm_id: New container ID to apply settings to

set -eu

OLD_VMID="{{ previouse_vm_id }}"
NEW_VMID="{{ vm_id }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$OLD_VMID" ] || [ "$OLD_VMID" = "NOT_DEFINED" ]; then
  log "No previouse_vm_id — skipping network restore"
  exit 0
fi
if [ -z "$NEW_VMID" ] || [ "$NEW_VMID" = "NOT_DEFINED" ]; then
  fail "vm_id is required"
fi
if [ "$OLD_VMID" = "$NEW_VMID" ]; then
  log "Same container — skipping network restore"
  exit 0
fi

OLD_CONF="/etc/pve/lxc/${OLD_VMID}.conf"
if [ ! -f "$OLD_CONF" ]; then
  log "Old config $OLD_CONF not found — skipping network restore"
  exit 0
fi

# --- Extract settings from old config ---

# net0 line (e.g. "net0: name=eth0,bridge=vmbr0,gw=192.168.4.1,...")
OLD_NET0=$(awk -F': ' '/^net0:/ { print $2; exit }' "$OLD_CONF")

# hostname
OLD_HOSTNAME=$(awk -F': ' '/^hostname:/ { print $2; exit }' "$OLD_CONF")

# nameserver (may contain space-separated list)
OLD_NAMESERVER=$(awk -F': ' '/^nameserver:/ { print $2; exit }' "$OLD_CONF")

CHANGED=0

# --- Apply net0 if it has static IP (not just dhcp) ---
if [ -n "$OLD_NET0" ]; then
  # Check if old config had a static IP (contains ip=<something other than dhcp>)
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

# --- Apply hostname if different from default ---
if [ -n "$OLD_HOSTNAME" ]; then
  NEW_HOSTNAME=$(awk -F': ' '/^hostname:/ { print $2; exit }' "/etc/pve/lxc/${NEW_VMID}.conf")
  if [ "$OLD_HOSTNAME" != "$NEW_HOSTNAME" ]; then
    log "Restoring hostname from old container: $OLD_HOSTNAME"
    pct set "$NEW_VMID" --hostname "$OLD_HOSTNAME" >&2
    CHANGED=1
  fi
fi

# --- Apply nameserver ---
if [ -n "$OLD_NAMESERVER" ]; then
  log "Restoring nameserver from old container: $OLD_NAMESERVER"
  pct set "$NEW_VMID" --nameserver "$OLD_NAMESERVER" >&2
  CHANGED=1
fi

if [ "$CHANGED" -eq 1 ]; then
  log "Network settings restored from container $OLD_VMID to $NEW_VMID"
else
  log "No network settings to restore from container $OLD_VMID"
fi
