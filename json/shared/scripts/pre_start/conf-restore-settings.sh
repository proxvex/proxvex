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
#   - previouse_vm_id: Old container ID whose config to read
#   - vm_id: New container ID to apply settings to

set -eu

OLD_VMID="{{ previouse_vm_id }}"
NEW_VMID="{{ vm_id }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$OLD_VMID" ] || [ "$OLD_VMID" = "NOT_DEFINED" ]; then
  log "No previouse_vm_id — skipping settings restore"
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

if [ "$CHANGED" -eq 1 ]; then
  log "Settings restored from container $OLD_VMID to $NEW_VMID"
else
  log "No settings to restore from container $OLD_VMID"
fi
