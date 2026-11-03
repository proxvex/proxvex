#!/bin/sh
# Stop the previous deployer container and unlink its persistent volumes so
# the new deployer can take over the static IP and the managed volumes.
#
# Invoked by upgrade-finalization-service.mts on the NEW deployer's first
# boot after a self-upgrade. The marker file at /config/.pending-post-
# upgrade.json carries the previous VMID.
#
# Steps:
# 1) Unlock the container (replace-ct.sh marked it with lock=migrate).
# 2) pct stop --timeout 90 (graceful, then SIGKILL after 90s). 90s keeps it
#    uniform with replace-ct.sh's Zitadel-bound stop window; the deployer
#    itself stops fast, so the extra ceiling is just a safety margin.
# 3) Unlink managed volumes (renamed to clean names; rootfs stays so the
#    container remains restorable until the cleanup service purges it).
# 4) Mark it replaced by the new deployer, so the replaced-container cleanup
#    destroys it after the grace period.
#
# Output: found=false when the container does not exist on this host — the
# finalizer then tries the next VE context.
#
# vol-common.sh is prepended via the template `library` property.

set -eu

VMID="{{ vmid }}"
NEW_VMID="{{ new_vmid }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "vmid is required"
fi

if ! pct config "$VMID" >/dev/null 2>&1; then
  log "Container $VMID does not exist on this host"
  printf '[{"id":"found","value":"false"}]'
  exit 0
fi

# Release the lock set by replace-ct.sh so `pct stop` is allowed.
pct unlock "$VMID" >&2 2>/dev/null || true

status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$status" = "running" ]; then
  log "Stopping previous deployer container $VMID (graceful shutdown, timeout 90s, then forceStop)..."
  # Use `pct shutdown --timeout N --forceStop 1`: `pct stop` does not
  # accept --timeout on this PVE (`pct stop` is the forceful path).
  # `--forceStop 1` makes shutdown SIGKILL after the timeout instead of
  # bailing. Bare `pct stop` is the last-resort fallback.
  pct shutdown "$VMID" --timeout 90 --forceStop 1 >&2 \
    || pct stop "$VMID" >&2 \
    || fail "pct shutdown/stop $VMID failed"
else
  log "Container $VMID already stopped"
fi

vol_unlink_persistent "$VMID"

# Mark replaced (notes markers, onboot 0, lock) so the cleanup service
# destroys it after the grace period and a manual `pct start` cannot
# accidentally bring it back up during the grace window.
if [ -n "$NEW_VMID" ] && [ "$NEW_VMID" != "NOT_DEFINED" ]; then
  vol_mark_replaced "$VMID" "$NEW_VMID"
else
  pct set "$VMID" --lock "${PROXVEX_REPLACED_LOCK:-migrate}" >&2 2>/dev/null || true
fi

log "Container $VMID stopped and managed volumes unlinked"
printf '[{"id":"found","value":"true"}]'
