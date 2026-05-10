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
# 2) pct stop --timeout 30 (graceful, then SIGKILL after 30s).
# 3) Unlink managed volumes (renamed to clean names; rootfs stays so the
#    container remains restorable until the cleanup service purges it).
#
# vol-common.sh is prepended via the template `library` property.

set -eu

VMID="{{ vmid }}"

log() { echo "$@" >&2; }
fail() { log "Error: $*"; exit 1; }

if [ -z "$VMID" ] || [ "$VMID" = "NOT_DEFINED" ]; then
  fail "vmid is required"
fi

if ! pct config "$VMID" >/dev/null 2>&1; then
  log "Container $VMID does not exist — nothing to do"
  exit 0
fi

# Release the lock set by replace-ct.sh so `pct stop` is allowed.
pct unlock "$VMID" >&2 2>/dev/null || true

status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$status" = "running" ]; then
  log "Stopping previous deployer container $VMID (timeout 30s)..."
  pct stop "$VMID" --timeout 30 >&2 || fail "pct stop $VMID failed"
else
  log "Container $VMID already stopped"
fi

vol_unlink_persistent "$VMID"

# Re-apply lock so the cleanup service still treats this container as
# replaced and a manual `pct start` cannot accidentally bring it back up
# during the grace window.
LOCK_NAME="${PROXVEX_REPLACED_LOCK:-migrate}"
pct set "$VMID" --lock "$LOCK_NAME" >&2 2>/dev/null || true

log "Container $VMID stopped and managed volumes unlinked"
