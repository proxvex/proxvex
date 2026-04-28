#!/bin/sh
# Destroy a previously-replaced LXC container.
#
# Steps:
# 1) Unlock the container (it was locked at replace time).
# 2) Unlink persistent volumes (rename to clean names so they survive destroy).
# 3) pct destroy --force --purge.
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

pct unlock "$VMID" >&2 2>/dev/null || true

# Stop if still running (defensive — replace-ct.sh stops first, but a manual
# unlock + start by an admin during the grace window would leave it running).
status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo "unknown")
if [ "$status" = "running" ]; then
  log "Stopping running container $VMID before destroy..."
  pct stop "$VMID" >&2 || log "Warning: failed to stop container $VMID"
fi

vol_unlink_persistent "$VMID"

log "Destroying replaced container $VMID..."
pct destroy "$VMID" --force --purge >&2 || fail "pct destroy $VMID failed"

log "Container $VMID destroyed"
